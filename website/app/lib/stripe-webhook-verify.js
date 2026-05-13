/**
 * Stripe webhook signature verification — extracted for unit-testing.
 *
 * Spec reference:
 *   https://docs.stripe.com/webhooks#verify-manually
 *
 * Two-step verification:
 *   1. Parse the `Stripe-Signature` header (`t=<ts>,v1=<sig>[,v1=<sig>]`).
 *   2. Compute HMAC-SHA256(secret, `${ts}.${rawBody}`) and constant-time
 *      compare against each v1 signature.
 *
 * Plus a timestamp-tolerance check (default 300s) so an attacker who
 * captures one valid event cannot replay it indefinitely.
 *
 * Bible Forbidden #15: never let an error bubble unhandled. All failure
 * paths return `false`; never throw.
 */

const crypto = require("crypto");

const DEFAULT_TOLERANCE_S = 300;

function verifyStripeSignature(
  payload,
  sigHeader,
  secret,
  { toleranceSeconds = DEFAULT_TOLERANCE_S, now = Date.now } = {},
) {
  if (!secret) return false;
  if (!sigHeader || typeof sigHeader !== "string") return false;
  if (typeof payload !== "string") return false;

  const parts = sigHeader.split(",").reduce(
    (acc, part) => {
      const [key, val] = part.split("=");
      if (key === "t") acc.timestamp = val;
      if (key === "v1") acc.signatures.push(val);
      return acc;
    },
    { timestamp: "", signatures: [] },
  );

  if (parts.signatures.length === 0) return false;

  const tsSeconds = Number.parseInt(parts.timestamp, 10);
  if (!Number.isFinite(tsSeconds) || tsSeconds <= 0) return false;
  const nowSeconds = Math.floor(now() / 1000);
  if (Math.abs(nowSeconds - tsSeconds) > toleranceSeconds) return false;

  const signedPayload = `${parts.timestamp}.${payload}`;
  let expected;
  try {
    expected = crypto
      .createHmac("sha256", secret)
      .update(signedPayload)
      .digest("hex");
  } catch {
    return false;
  }

  return parts.signatures.some((sig) => {
    try {
      const a = Buffer.from(expected);
      const b = Buffer.from(sig);
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  });
}

module.exports = {
  verifyStripeSignature,
  DEFAULT_TOLERANCE_S,
};
