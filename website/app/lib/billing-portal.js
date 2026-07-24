'use strict';
/**
 * Billing portal — self-serve subscription management via Stripe's hosted
 * Customer Portal (upgrade/downgrade payment method, view invoices, cancel).
 *
 * Flow (email-link, enumeration-safe):
 *   1. Customer POSTs their email to /api/billing/portal.
 *   2. We look up stripe_customer_id across BOTH subscription stores
 *      (continuous + mcp) by customer_email.
 *   3. For each distinct customer we create a Stripe billing-portal session
 *      and EMAIL the link — never return it in the HTTP response, so an
 *      attacker who knows a customer's email cannot open their portal.
 *   4. The HTTP response is identical whether or not the email matched
 *      anything (no subscription-existence oracle).
 *
 * Authorized by Craig 2026-07-25 ("walk me through it" in response to the
 * billing-portal authorization ask).
 */

const https = require('https');

const MAX_PORTAL_SESSIONS_PER_REQUEST = 3;

function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  const trimmed = email.trim();
  if (!trimmed || trimmed.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

/**
 * All distinct Stripe customer ids attached to subscriptions under this
 * email, newest first. Includes non-active statuses deliberately — a
 * past_due customer needs the portal to FIX their payment method, and a
 * canceled one may need old invoices.
 */
async function findStripeCustomersByEmail(sql, email) {
  if (!sql || typeof sql !== 'function') throw new Error('sql is required');
  if (!isValidEmail(email)) return [];
  const normalized = email.trim().toLowerCase();

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const continuous = require('./continuous-subscription-store');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mcp = require('./mcp-subscription-store');

  const customers = [];
  const seen = new Set();

  try {
    await continuous.ensureSchema(sql);
    const rows = await sql`SELECT stripe_customer_id, status FROM continuous_subscriptions
      WHERE LOWER(customer_email) = ${normalized} AND stripe_customer_id IS NOT NULL
      ORDER BY updated_at DESC`;
    for (const row of rows || []) {
      if (seen.has(row.stripe_customer_id)) continue;
      seen.add(row.stripe_customer_id);
      customers.push({ customerId: row.stripe_customer_id, source: 'continuous', status: row.status });
    }
  } catch { /* table absent on a fresh deploy — treat as no matches */ }

  try {
    await mcp.ensureSchema(sql);
    const rows = await sql`SELECT stripe_customer_id, status FROM mcp_subscriptions
      WHERE LOWER(customer_email) = ${normalized} AND stripe_customer_id IS NOT NULL
      ORDER BY updated_at DESC`;
    for (const row of rows || []) {
      if (seen.has(row.stripe_customer_id)) continue;
      seen.add(row.stripe_customer_id);
      customers.push({ customerId: row.stripe_customer_id, source: 'mcp', status: row.status });
    }
  } catch { /* table absent — treat as no matches */ }

  return customers;
}

/** Default Stripe transport — form-encoded POST, same shape as checkout's. */
function defaultStripeRequest(method, path, body) {
  const key = process.env.STRIPE_SECRET_KEY;
  return new Promise((resolve, reject) => {
    if (!key) { reject(new Error('STRIPE_SECRET_KEY not set')); return; }
    const req = https.request({
      hostname: 'api.stripe.com',
      port: 443,
      path,
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString());
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else reject(new Error(parsed.error?.message || `Stripe HTTP ${res.statusCode}`));
        } catch {
          reject(new Error(`Stripe HTTP ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => { req.destroy(); reject(new Error('Stripe request timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Create a Stripe billing-portal session for one customer.
 * @returns {Promise<{ url: string }>}
 */
async function createPortalSession(customerId, returnUrl, stripeRequestFn = defaultStripeRequest) {
  if (!customerId) throw new Error('customerId is required');
  const params = new URLSearchParams({ customer: customerId, return_url: returnUrl });
  const session = await stripeRequestFn('POST', '/v1/billing_portal/sessions', params.toString());
  if (!session || typeof session.url !== 'string') throw new Error('Stripe portal session missing url');
  return { url: session.url };
}

/**
 * The whole flow for one request. Returns what happened for logging, but
 * callers MUST NOT let the distinction reach the HTTP response body.
 *
 * @param {object} deps  — { sql, stripeRequestFn, sendEmailFn, baseUrl }
 * @returns {Promise<{ matched: number, sent: boolean, error?: string }>}
 */
async function requestPortalLink(email, deps) {
  const { sql, stripeRequestFn, sendEmailFn, baseUrl } = deps;
  const customers = await findStripeCustomersByEmail(sql, email);
  if (customers.length === 0) return { matched: 0, sent: false };

  const returnUrl = `${(baseUrl || 'https://gatetest.ai').replace(/\/$/, '')}/billing`;
  const links = [];
  for (const c of customers.slice(0, MAX_PORTAL_SESSIONS_PER_REQUEST)) {
    try {
      const { url } = await createPortalSession(c.customerId, returnUrl, stripeRequestFn);
      links.push({ url, source: c.source });
    } catch (err) {
      // One bad customer record must not block the rest.
      console.error('[GateTest] portal session failed', { source: c.source, error: err.message });
    }
  }
  if (links.length === 0) return { matched: customers.length, sent: false, error: 'no portal session created' };

  const sendResult = await sendEmailFn({ to: email.trim(), links });
  return { matched: customers.length, sent: Boolean(sendResult && sendResult.ok), error: sendResult && sendResult.error };
}

module.exports = {
  isValidEmail,
  findStripeCustomersByEmail,
  createPortalSession,
  requestPortalLink,
  defaultStripeRequest,
  MAX_PORTAL_SESSIONS_PER_REQUEST,
};
