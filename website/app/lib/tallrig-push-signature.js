/**
 * Signature + freshness verification for Tallrig's signed push events —
 * POST /api/integrations/tallrig/events (issue #672). Next to
 * github-signature.js because it is the same family of concern (raw-body
 * HMAC verification for an inbound webhook), but a distinct scheme:
 *
 *   - GitHub signs with X-Hub-Signature-256 over the raw body alone.
 *   - Tallrig signs with X-Tallrig-Signature: sha256=<hex> over
 *     `${timestamp}.${rawBody}` (the timestamp is bound into the signature,
 *     not just carried alongside it), and additionally requires the
 *     timestamp to be within a 300s window of "now" in either direction —
 *     replay protection GitHub's scheme doesn't need because it has no
 *     timestamp header at all.
 *
 * Wire contract (Tallrig's push-events feature, tenant 6bd0832e):
 *   Headers:
 *     X-Tallrig-Key-Id     <key id>            (see keyId below)
 *     X-Tallrig-Timestamp  <unix seconds>
 *     X-Tallrig-Signature  sha256=<hex-hmac>
 *   signed-string = `${timestamp}.${rawBody}`
 *   hmac          = HMAC-SHA256(TALLRIG_PUSH_SECRET, signed-string)
 *
 * This module verifies the timestamp + signature pair only. The key id
 * carried on X-Tallrig-Key-Id is returned to the caller unrejected here —
 * matching it against TALLRIG_PUSH_KEY_ID (when that env var is set) is a
 * route-level concern with its own env var, done by the caller
 * (tallrig-push-events.js), same as how the "secret configured at all"
 * check (-> 503) is the caller's job, not this pure function's.
 *
 * Reuses safeEqual from github-signature.js (Doctrine #4 — one constant-time
 * compare, not two).
 */

'use strict';

const crypto = require('crypto');
const { safeEqual } = require('./github-signature');

/** Replay window, in seconds, applied in both directions. */
const REPLAY_WINDOW_SECONDS = 300;

/**
 * @param {object} args
 * @param {{ timestamp?: string|null, signature?: string|null }} args.headers
 *   Already-extracted header values — X-Tallrig-Timestamp and
 *   X-Tallrig-Signature (the caller pulls these off the request; this
 *   function only ever reads `headers.timestamp` / `headers.signature`).
 * @param {string} args.rawBody   The exact bytes Tallrig signed (unparsed).
 * @param {string} args.secret    TALLRIG_PUSH_SECRET. Caller has already
 *   confirmed this is non-empty (an unset secret is a 503, decided by the
 *   caller before this function is ever invoked).
 * @param {number} [args.now]     Epoch milliseconds; defaults to Date.now().
 *   Exposed for tests so the replay window can be exercised deterministically.
 * @returns {{ valid: true } | { valid: false, status: 400|401|409, reason: string }}
 */
function verifyTallrigPush({ headers, rawBody, secret, now } = {}) {
  const timestampHeader = headers && headers.timestamp;
  const signatureHeader = headers && headers.signature;

  if (!timestampHeader || typeof timestampHeader !== 'string') {
    return { valid: false, status: 400, reason: 'missing X-Tallrig-Timestamp header' };
  }
  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return { valid: false, status: 400, reason: 'missing X-Tallrig-Signature header' };
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) {
    return { valid: false, status: 400, reason: 'malformed X-Tallrig-Timestamp header' };
  }

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(`${timestampHeader}.${rawBody}`).digest('hex');
  if (!safeEqual(expected, signatureHeader)) {
    return { valid: false, status: 401, reason: 'invalid signature' };
  }

  const nowMs = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const driftSeconds = Math.abs(nowSeconds - timestamp);
  if (driftSeconds > REPLAY_WINDOW_SECONDS) {
    return { valid: false, status: 409, reason: `timestamp outside ${REPLAY_WINDOW_SECONDS}s replay window` };
  }

  return { valid: true };
}

module.exports = {
  REPLAY_WINDOW_SECONDS,
  verifyTallrigPush,
};
