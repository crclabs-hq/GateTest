// ============================================================================
// STRIPE WEBHOOK SIGNATURE VERIFICATION TESTS
// ============================================================================
// Covers website/app/lib/stripe-webhook-verify.js — the hot path on every
// Stripe-driven payment capture. A regression here lets attackers forge
// `checkout.session.completed` events and capture (or skip-capture) money.
//
// Particular focus on the timestamp-tolerance check added 2026-05-13: an
// otherwise-valid signature from >5 minutes ago must be rejected so a
// captured event cannot be replayed indefinitely.
// ============================================================================
const { describe, it } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");

const {
  verifyStripeSignature,
  DEFAULT_TOLERANCE_S,
} = require("../website/app/lib/stripe-webhook-verify");

const SECRET = "whsec_test_secret_do_not_use_in_prod";

function sign(payload, timestampSeconds, secret = SECRET) {
  const signed = `${timestampSeconds}.${payload}`;
  const v1 = crypto.createHmac("sha256", secret).update(signed).digest("hex");
  return `t=${timestampSeconds},v1=${v1}`;
}

describe("verifyStripeSignature — fail-closed paths", () => {
  it("rejects when secret is empty", () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = sign("{}", ts);
    assert.strictEqual(verifyStripeSignature("{}", header, ""), false);
  });

  it("rejects when secret is undefined", () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = sign("{}", ts);
    // @ts-expect-error — deliberately probing the runtime guard
    assert.strictEqual(verifyStripeSignature("{}", header), false);
  });

  it("rejects when signature header is empty", () => {
    assert.strictEqual(verifyStripeSignature("{}", "", SECRET), false);
  });

  it("rejects when signature header is null", () => {
    assert.strictEqual(verifyStripeSignature("{}", null, SECRET), false);
  });

  it("rejects when payload is not a string", () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = sign("{}", ts);
    assert.strictEqual(verifyStripeSignature(null, header, SECRET), false);
    assert.strictEqual(verifyStripeSignature(123, header, SECRET), false);
  });

  it("rejects header with no v1 signatures", () => {
    const ts = Math.floor(Date.now() / 1000);
    assert.strictEqual(
      verifyStripeSignature("{}", `t=${ts}`, SECRET),
      false,
    );
  });

  it("rejects header with malformed timestamp", () => {
    assert.strictEqual(
      verifyStripeSignature("{}", "t=NaN,v1=abc", SECRET),
      false,
    );
    assert.strictEqual(
      verifyStripeSignature("{}", "t=,v1=abc", SECRET),
      false,
    );
    assert.strictEqual(
      verifyStripeSignature("{}", "t=-100,v1=abc", SECRET),
      false,
    );
    assert.strictEqual(
      verifyStripeSignature("{}", "t=0,v1=abc", SECRET),
      false,
    );
  });
});

describe("verifyStripeSignature — replay-attack defence", () => {
  it("accepts a fresh signature (now)", () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = sign(`{"event":"test"}`, ts);
    assert.strictEqual(
      verifyStripeSignature(`{"event":"test"}`, header, SECRET),
      true,
    );
  });

  it("accepts a signature 4 minutes old (inside tolerance)", () => {
    const ts = Math.floor(Date.now() / 1000) - 240;
    const header = sign(`{"event":"test"}`, ts);
    assert.strictEqual(
      verifyStripeSignature(`{"event":"test"}`, header, SECRET),
      true,
    );
  });

  it("rejects a signature 6 minutes old (outside tolerance)", () => {
    const ts = Math.floor(Date.now() / 1000) - 360;
    const header = sign(`{"event":"test"}`, ts);
    assert.strictEqual(
      verifyStripeSignature(`{"event":"test"}`, header, SECRET),
      false,
    );
  });

  it("rejects a signature 1 hour old", () => {
    const ts = Math.floor(Date.now() / 1000) - 3600;
    const header = sign(`{"event":"test"}`, ts);
    assert.strictEqual(
      verifyStripeSignature(`{"event":"test"}`, header, SECRET),
      false,
    );
  });

  it("rejects a far-future signature (clock-skew abuse)", () => {
    const ts = Math.floor(Date.now() / 1000) + 3600;
    const header = sign(`{"event":"test"}`, ts);
    assert.strictEqual(
      verifyStripeSignature(`{"event":"test"}`, header, SECRET),
      false,
    );
  });

  it("respects a custom tolerance window", () => {
    const ts = Math.floor(Date.now() / 1000) - 120;
    const header = sign(`{"event":"test"}`, ts);
    // 60s tolerance — 120s-old event should now be rejected.
    assert.strictEqual(
      verifyStripeSignature(`{"event":"test"}`, header, SECRET, {
        toleranceSeconds: 60,
      }),
      false,
    );
    // 300s tolerance — accepted.
    assert.strictEqual(
      verifyStripeSignature(`{"event":"test"}`, header, SECRET, {
        toleranceSeconds: 300,
      }),
      true,
    );
  });

  it("default tolerance is 5 minutes (300 seconds)", () => {
    assert.strictEqual(DEFAULT_TOLERANCE_S, 300);
  });
});

describe("verifyStripeSignature — signature mismatch", () => {
  it("rejects a payload that differs from the signed body", () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = sign(`{"a":1}`, ts);
    assert.strictEqual(
      verifyStripeSignature(`{"a":2}`, header, SECRET),
      false,
    );
  });

  it("rejects a signature created with a different secret", () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = sign(`{}`, ts, "different_secret");
    assert.strictEqual(verifyStripeSignature(`{}`, header, SECRET), false);
  });

  it("rejects garbage v1 hex", () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = `t=${ts},v1=zzzznotahex`;
    assert.strictEqual(verifyStripeSignature(`{}`, header, SECRET), false);
  });

  it("accepts when any one of multiple v1 signatures matches (rotation)", () => {
    const ts = Math.floor(Date.now() / 1000);
    const goodHeader = sign(`{}`, ts);
    // Append a junk v1 — Stripe spec allows multi-sig during rotation.
    const header = `${goodHeader},v1=deadbeef`;
    assert.strictEqual(verifyStripeSignature(`{}`, header, SECRET), true);
  });
});

describe("verifyStripeSignature — never throws", () => {
  it("does not throw on garbage header", () => {
    assert.strictEqual(
      verifyStripeSignature("{}", "totally garbage", SECRET),
      false,
    );
  });

  it("does not throw on header with only commas", () => {
    assert.strictEqual(verifyStripeSignature("{}", ",,,", SECRET), false);
  });

  it("does not throw on extremely long header", () => {
    const huge = "t=1,v1=" + "a".repeat(100000);
    assert.strictEqual(verifyStripeSignature("{}", huge, SECRET), false);
  });
});
