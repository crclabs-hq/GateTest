// ============================================================================
// TALLRIG-PUSH-SIGNATURE TEST — Coverage for website/app/lib/tallrig-push-signature.js
// ============================================================================
// Verifies verifyTallrigPush(), the auth check behind
// POST /api/integrations/tallrig/events (issue #672). Tallrig signs
// `${timestamp}.${rawBody}` with HMAC-SHA256 under TALLRIG_PUSH_SECRET and
// carries the timestamp in X-Tallrig-Timestamp, the signature in
// X-Tallrig-Signature as `sha256=<hex>`, with a 300s replay window in
// either direction.
//
// Covered:
//   - a correctly-signed, fresh request passes
//   - the wrong secret fails (401)
//   - a tampered body fails (401)
//   - a timestamp 301s in the past fails (409) — outside the window
//   - a timestamp 299s in the future passes — inside the window
//   - a missing header (timestamp or signature) fails (400)
//   - the comparison is constant-time (crypto.timingSafeEqual, via the
//     shared safeEqual from github-signature.js)
// ============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const path = require('path');

const { verifyTallrigPush, REPLAY_WINDOW_SECONDS } = require(path.resolve(
  __dirname, '..', 'website', 'app', 'lib', 'tallrig-push-signature.js',
));

const SECRET = 'test-tallrig-push-secret-0123456789abcdef';

function sign(timestamp, rawBody, secret = SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

describe('verifyTallrigPush — happy path', () => {
  it('a correctly-signed, fresh request is valid', () => {
    const rawBody = JSON.stringify({ id: 'evt_1', type: 'deploy.started' });
    const ts = String(nowSeconds());
    const result = verifyTallrigPush({
      headers: { timestamp: ts, signature: sign(ts, rawBody) },
      rawBody,
      secret: SECRET,
    });
    assert.deepStrictEqual(result, { valid: true });
  });
});

describe('verifyTallrigPush — signature failures (401)', () => {
  it('wrong secret fails', () => {
    const rawBody = JSON.stringify({ id: 'evt_1', type: 'deploy.started' });
    const ts = String(nowSeconds());
    const result = verifyTallrigPush({
      headers: { timestamp: ts, signature: sign(ts, rawBody, 'wrong-secret') },
      rawBody,
      secret: SECRET,
    });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.status, 401);
  });

  it('tampered body fails', () => {
    const rawBody = JSON.stringify({ id: 'evt_1', type: 'deploy.started' });
    const ts = String(nowSeconds());
    const signatureHeader = sign(ts, rawBody); // signed over the ORIGINAL body
    const result = verifyTallrigPush({
      headers: { timestamp: ts, signature: signatureHeader },
      rawBody: rawBody + 'tampered-suffix',
      secret: SECRET,
    });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.status, 401);
  });
});

describe('verifyTallrigPush — replay window (409)', () => {
  it('a timestamp 301s old fails — outside the window', () => {
    const rawBody = JSON.stringify({ id: 'evt_1', type: 'deploy.started' });
    const ts = String(nowSeconds() - (REPLAY_WINDOW_SECONDS + 1));
    const result = verifyTallrigPush({
      headers: { timestamp: ts, signature: sign(ts, rawBody) },
      rawBody,
      secret: SECRET,
    });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.status, 409);
  });

  it('a timestamp 299s in the future passes — inside the window', () => {
    const rawBody = JSON.stringify({ id: 'evt_1', type: 'deploy.started' });
    const ts = String(nowSeconds() + (REPLAY_WINDOW_SECONDS - 1));
    const result = verifyTallrigPush({
      headers: { timestamp: ts, signature: sign(ts, rawBody) },
      rawBody,
      secret: SECRET,
    });
    assert.deepStrictEqual(result, { valid: true });
  });

  it('the boundary at exactly 300s passes (inclusive)', () => {
    const rawBody = JSON.stringify({ id: 'evt_1', type: 'deploy.started' });
    const now = Date.now();
    const ts = String(Math.floor(now / 1000) - REPLAY_WINDOW_SECONDS);
    const result = verifyTallrigPush({
      headers: { timestamp: ts, signature: sign(ts, rawBody) },
      rawBody,
      secret: SECRET,
      now,
    });
    assert.deepStrictEqual(result, { valid: true });
  });
});

describe('verifyTallrigPush — missing headers (400)', () => {
  it('missing X-Tallrig-Timestamp fails', () => {
    const rawBody = JSON.stringify({ id: 'evt_1' });
    const result = verifyTallrigPush({
      headers: { signature: sign(String(nowSeconds()), rawBody) },
      rawBody,
      secret: SECRET,
    });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.status, 400);
  });

  it('missing X-Tallrig-Signature fails', () => {
    const rawBody = JSON.stringify({ id: 'evt_1' });
    const ts = String(nowSeconds());
    const result = verifyTallrigPush({
      headers: { timestamp: ts },
      rawBody,
      secret: SECRET,
    });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.status, 400);
  });

  it('both headers missing fails', () => {
    const result = verifyTallrigPush({ headers: {}, rawBody: '{}', secret: SECRET });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.status, 400);
  });
});

describe('verifyTallrigPush — constant-time compare', () => {
  it('uses crypto.timingSafeEqual (via the shared safeEqual helper) rather than ===', () => {
    const originalEqual = crypto.timingSafeEqual;
    let called = false;
    crypto.timingSafeEqual = (...args) => {
      called = true;
      return originalEqual(...args);
    };
    try {
      const rawBody = JSON.stringify({ id: 'evt_1' });
      const ts = String(nowSeconds());
      verifyTallrigPush({
        headers: { timestamp: ts, signature: sign(ts, rawBody) },
        rawBody,
        secret: SECRET,
      });
      assert.strictEqual(called, true, 'crypto.timingSafeEqual must be used for the signature comparison');
    } finally {
      crypto.timingSafeEqual = originalEqual;
    }
  });
});
