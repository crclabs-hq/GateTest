/**
 * Pure decision logic for full-report-auth.ts — kept in plain JS (not TS)
 * specifically so it's unit-testable via `node --test` the same way
 * anthropic-error.js is (this repo has no ts-node/tsx loader registered,
 * so .ts lib files can't be required directly from tests). The TS wrapper
 * (full-report-auth.ts) does the Next.js-specific I/O (reading the
 * request, calling isAdminRequest, hitting the real Stripe API) and
 * delegates the actual yes/no decision here.
 */

'use strict';

const https = require('https');

/**
 * Decide whether a scan request may receive the full (unpaywalled) report.
 * NEVER derives true from anything the caller merely asserts — `isAdmin`
 * must come from a verified admin check, and `sessionId` is only trusted
 * once `fetchStripeSession` confirms Stripe itself says payment_status
 * is "paid".
 *
 * @param {object} opts
 * @param {boolean} opts.isAdmin
 * @param {string|undefined} opts.sessionId
 * @param {string} opts.stripeSecretKey
 * @param {(sessionId: string, stripeSecretKey: string) => Promise<{payment_status?: string}>} opts.fetchStripeSession
 * @returns {Promise<boolean>}
 */
async function resolveFullReportAccess({ isAdmin, sessionId, stripeSecretKey, fetchStripeSession }) {
  if (isAdmin) return true;

  if (!sessionId || typeof sessionId !== 'string' || !stripeSecretKey) {
    return false;
  }

  try {
    const session = await fetchStripeSession(sessionId, stripeSecretKey);
    return !!session && session.payment_status === 'paid';
  } catch (err) {
    // Fail closed — an unverifiable payment claim is treated as no payment.
    console.error('[GateTest] full-report-auth: Stripe session lookup failed:', err);
    return false;
  }
}

/** Real Stripe Checkout Session lookup. Injected as a default so tests can substitute a fake. */
function defaultFetchStripeSession(sessionId, stripeSecretKey) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.stripe.com',
        port: 443,
        path: `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
        method: 'GET',
        headers: { Authorization: `Bearer ${stripeSecretKey}` },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
          } catch {
            resolve({});
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

module.exports = { resolveFullReportAccess, defaultFetchStripeSession };
