/**
 * Pure handler for POST /api/marketplace/webhook — the GitHub Marketplace
 * *listing's* own webhook, configured on the listing's Webhook page. This is
 * a distinct event stream from the GitHub App's push/PR webhook at
 * /api/webhook (see github-events.js) — different payload URL, different
 * secret, different event shapes, and it never touches scan_queue.
 *
 * GitHub POSTs here for the listing's install lifecycle:
 *   - `marketplace_purchase` (action: purchased | cancelled | changed |
 *     pending_change | pending_change_cancelled)
 *   - `ping` on webhook setup
 *
 * Wire contract:
 *   POST /api/marketplace/webhook
 *   Headers:
 *     X-GitHub-Event: marketplace_purchase | ping
 *     X-GitHub-Delivery: <uuid>        (idempotency key)
 *     X-Hub-Signature-256: sha256=<hmac(GITHUB_MARKETPLACE_WEBHOOK_SECRET, rawBody)>
 *     Content-Type: application/json
 *
 * Security (fail closed, Forbidden #15):
 *   - GITHUB_MARKETPLACE_WEBHOOK_SECRET missing → 503, nothing persisted
 *   - Invalid/missing signature → 401, nothing persisted
 *   - `ping` → 200 { ok: true, event: 'ping' }
 *   - `marketplace_purchase` → persist (idempotent on X-GitHub-Delivery), 200
 *   - any other event → 202 { ignored: true }
 *
 * `getSql` is only invoked once a request has already passed the secret and
 * signature checks and is actually a `marketplace_purchase` — so a database
 * outage never turns a `ping` or an ignored event into a 503, and neither the
 * secret-missing nor the bad-signature path ever touches the database.
 *
 * This module has NO network I/O so it is unit-testable from
 * tests/marketplace-webhook.test.js — same shape as processGitHubEvent in
 * github-events.js, which website/app/api/marketplace/webhook/route.ts
 * mirrors (thin route, all logic here).
 */

'use strict';

const { verifyGitHubSignature } = require('./github-signature');

/**
 * @param {object} args
 * @param {string} args.rawBody
 * @param {string|null} args.eventType         X-GitHub-Event value
 * @param {string|null} args.delivery          X-GitHub-Delivery value (UUID)
 * @param {string|null} args.signatureHeader   X-Hub-Signature-256 value
 * @param {Record<string, string | undefined>} args.env
 * @param {() => Function} args.getSql         lazy — called only right before a persist
 * @param {{ recordPurchaseEvent: Function }} args.purchaseStore  marketplace-purchase-store.js (injected for tests)
 * @returns {Promise<{ status: number, body: unknown }>}
 */
async function processMarketplaceWebhookEvent({
  rawBody,
  eventType,
  delivery,
  signatureHeader,
  env,
  getSql,
  purchaseStore,
}) {
  const secret = env && env.GITHUB_MARKETPLACE_WEBHOOK_SECRET;
  if (!secret) {
    return { status: 503, body: { error: 'marketplace webhook not configured' } };
  }
  if (!verifyGitHubSignature(rawBody, signatureHeader, secret)) {
    return { status: 401, body: { error: 'invalid signature' } };
  }

  if (eventType === 'ping') {
    return { status: 200, body: { ok: true, event: 'ping' } };
  }

  if (eventType !== 'marketplace_purchase') {
    return { status: 202, body: { ignored: true } };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: 'malformed: invalid JSON' } };
  }
  if (!delivery || typeof delivery !== 'string') {
    return { status: 400, body: { error: 'malformed: missing X-GitHub-Delivery header' } };
  }

  let sql;
  try {
    sql = typeof getSql === 'function' ? getSql() : getSql;
  } catch (err) {
    const msg = err && err.message ? err.message : 'database not configured';
    return { status: 503, body: { error: msg } };
  }

  try {
    await purchaseStore.recordPurchaseEvent(sql, { deliveryId: delivery, payload: parsed });
  } catch (err) { // error-ok — the webhook handler must never crash the Vercel function
    const msg = err && err.message ? err.message : 'failed to record purchase event';
    console.error('[marketplace-webhook] recordPurchaseEvent failed:', msg);
    return { status: 500, body: { error: msg } };
  }

  return { status: 200, body: { ok: true, event: 'marketplace_purchase' } };
}

module.exports = { processMarketplaceWebhookEvent };
