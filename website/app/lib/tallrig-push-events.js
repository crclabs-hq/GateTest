/**
 * Pure handler for POST /api/integrations/tallrig/events — Tallrig's signed
 * push events for our tenant (issue #672): `deploy.started`,
 * `deploy.finished` (carries a sha or null, plus shaSource), `job.failed`,
 * `secret.rotated` (name only). Wire contract + all logic lives here so it
 * is unit-testable without a TS loader — same shape as
 * processMarketplaceWebhookEvent in marketplace-webhook.js, which
 * website/app/api/marketplace/webhook/route.ts mirrors (thin route, all
 * logic in a plain module). This file stays thin over two collaborators:
 *   - tallrig-push-signature.js   verifies the timestamp + HMAC signature
 *   - tallrig-push-event-store.js persists + dedupes + caps at 500 events
 *
 * Fails closed (Bible Forbidden #15):
 *   - TALLRIG_PUSH_SECRET unset            -> 503, nothing read or stored
 *   - X-Tallrig-Key-Id mismatch (when TALLRIG_PUSH_KEY_ID is set) -> 401
 *   - missing timestamp/signature header   -> 400
 *   - bad signature                        -> 401
 *   - timestamp outside the 300s window    -> 409
 *   - malformed JSON body                  -> 400
 *   - otherwise                            -> 200, stored (deduped on id)
 */

'use strict';

const { verifyTallrigPush } = require('./tallrig-push-signature');

/**
 * @param {object} args
 * @param {string} args.rawBody               raw request body (unparsed)
 * @param {string|null} args.keyIdHeader       X-Tallrig-Key-Id
 * @param {string|null} args.timestampHeader   X-Tallrig-Timestamp
 * @param {string|null} args.signatureHeader   X-Tallrig-Signature
 * @param {Record<string, string|undefined>} args.env
 * @param {number} [args.now]                  epoch ms, for deterministic tests
 * @param {{ appendEvent: Function }} args.store  tallrig-push-event-store.js (injected for tests)
 * @returns {Promise<{ status: number, body: unknown }>}
 */
async function processTallrigPushEvent({
  rawBody,
  keyIdHeader,
  timestampHeader,
  signatureHeader,
  env,
  now,
  store,
}) {
  const secret = env && env.TALLRIG_PUSH_SECRET;
  if (!secret) {
    return { status: 503, body: { error: 'Tallrig push events not configured' } };
  }

  const expectedKeyId = env && env.TALLRIG_PUSH_KEY_ID;
  if (expectedKeyId && keyIdHeader !== expectedKeyId) {
    return { status: 401, body: { error: 'unrecognized key id' } };
  }

  const verification = verifyTallrigPush({
    headers: { timestamp: timestampHeader, signature: signatureHeader },
    rawBody,
    secret,
    now,
  });
  if (!verification.valid) {
    return { status: verification.status, body: { error: verification.reason } };
  }

  let payload;
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return { status: 400, body: { error: 'malformed: invalid JSON' } };
  }

  const { stored } = store.appendEvent({ rawBody, payload, keyId: keyIdHeader || null });
  return { status: 200, body: { ok: true, stored } };
}

module.exports = { processTallrigPushEvent };
