/**
 * Shared GitHub HMAC-SHA256 webhook-signature verification.
 *
 * GitHub signs both of our webhook payload URLs the same way — raw body,
 * HMAC-SHA256, header `X-Hub-Signature-256: sha256=<hex>` — for two
 * unrelated event streams:
 *   - the GitHub App's push/PR webhook (/api/webhook, GITHUB_WEBHOOK_SECRET)
 *   - the GitHub Marketplace listing's webhook (/api/marketplace/webhook,
 *     GITHUB_MARKETPLACE_WEBHOOK_SECRET)
 *
 * Extracted 2026-09-19 (Doctrine #4 — one definition, imported) from
 * website/app/lib/github-events.js, which had this pair private. Behaviour
 * is byte-for-byte identical to what shipped there — github-events.js now
 * imports from here instead of redefining it, so its existing coverage
 * (tests/github-events.test.js) stays valid unchanged.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const crypto = require('crypto');

function safeEqual(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/**
 * Verify GitHub's X-Hub-Signature-256 header.
 * Format: `sha256=<hex-hmac-of-raw-body-keyed-with-secret>`.
 *
 * Fails closed: a missing secret or a missing/malformed header both return
 * false rather than throwing, so a caller can treat "not verified" uniformly.
 *
 * @param {string} rawBody
 * @param {string|null} headerValue
 * @param {string} secret
 */
function verifyGitHubSignature(rawBody, headerValue, secret) {
  if (!secret) return false;
  if (!headerValue || typeof headerValue !== 'string') return false;
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqual(expected, headerValue);
}

module.exports = {
  safeEqual,
  verifyGitHubSignature,
};
