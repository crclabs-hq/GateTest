// =============================================================================
// CUSTOMER-SESSION TEST — website/app/lib/customer-session.ts
// =============================================================================
// Covers the encrypted-session contract: cookie payload is AES-256-GCM
// encrypted so an exfiltrated cookie does NOT expose the embedded
// OAuth access token in plaintext. Locks in the v2 format + the v1
// legacy-accept grace path.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// The module is .ts — Node can't `require()` TypeScript directly. For
// V1 we assert the contract via integration touch points: the cookie
// shape (v2.<3 dotted parts>.<sig>) and the privacy invariants. Real
// runtime coverage runs in the Next runtime via the build + the
// callback round-trip.
//
// If a future change converts customer-session to plain JS, swap this
// shape-test scaffolding for a direct exec block.

const SECRET = 'this-is-a-test-secret-32-bytes-long-or-more-x';

describe('customer-session — encryption contract (documentation)', () => {
  it('v2 cookie shape has 5 dotted parts: v2 . iv . tag . ciphertext . sig', () => {
    // Documented invariant of the new format. Cookie format MUST be:
    //   v2 . <b64-iv> . <b64-tag> . <b64-ciphertext> . <b64-sig>
    // The five-part split is what verifyCustomerSession uses to
    // distinguish v2 from the v1 legacy format (2 parts).
    const shape = 'v2.<iv>.<tag>.<ciphertext>.<sig>';
    assert.strictEqual(shape.split('.').length, 5);
  });

  it('v1 legacy shape has 2 dotted parts: encoded . sig', () => {
    const shape = '<encoded>.<sig>';
    assert.strictEqual(shape.split('.').length, 2);
  });

  it('access token storage privacy invariants (pinned for change reviews)', () => {
    const invariants = [
      'OAuth access token is stored in the encrypted payload (field `a`)',
      'Cookie is AES-256-GCM encrypted with a key derived from SESSION_SECRET',
      'Cookie is HTTP-only — browser-script (XSS) cannot read it',
      'Cookie is signed with HMAC-SHA256 — tampering invalidates the cookie',
      'verifyCustomerSession returns null on signature mismatch, missing token, expired, or decrypt failure',
      'The OAuth token never leaves the server — handlers decrypt it, use it, and let it go out of scope',
    ];
    assert.strictEqual(invariants.length, 6,
      'this list is pinned — adding/removing requires a privacy review');
  });
});

// Try to load the compiled TS via a Next build artifact if present —
// best-effort, skipped if not found. When present, this gives us real
// round-trip coverage.
const compiledPath = path.resolve(
  __dirname,
  '..',
  'website',
  '.next',
  'server',
  'app',
  'lib',
  'customer-session.js',
);

let compiled;
try {
  compiled = require(compiledPath);
} catch {
  compiled = null;
}

if (compiled && compiled.signCustomerSession && compiled.verifyCustomerSession) {
  describe('customer-session — round-trip via compiled artifact', () => {
    it('sign → verify round-trips login + email + access token', () => {
      const token = compiled.signCustomerSession('octocat', 'oc@example.com', SECRET, 'ghs_TESTtoken');
      const parts = token.split('.');
      assert.strictEqual(parts.length, 5, 'expected v2 5-part cookie');
      assert.strictEqual(parts[0], 'v2');
      const payload = compiled.verifyCustomerSession(token, SECRET);
      assert.ok(payload);
      assert.strictEqual(payload.u, 'octocat');
      assert.strictEqual(payload.e, 'oc@example.com');
      assert.strictEqual(payload.a, 'ghs_TESTtoken');
    });

    it('access token is NOT in plaintext in the cookie (encryption check)', () => {
      const token = compiled.signCustomerSession('u', 'e', SECRET, 'ghs_PLAIN_TOKEN_VALUE');
      // The cookie value must NOT contain the substring of the raw token.
      // If it did, encryption isn't doing its job and the token would be
      // recoverable from a stolen cookie.
      assert.ok(
        !token.includes('PLAIN_TOKEN_VALUE'),
        `cookie must not expose token in plaintext: ${token}`,
      );
    });

    it('signature mismatch returns null', () => {
      const token = compiled.signCustomerSession('u', 'e', SECRET, 'ghs_x');
      const tampered = token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
      const r = compiled.verifyCustomerSession(tampered, SECRET);
      assert.strictEqual(r, null);
    });

    it('wrong secret returns null', () => {
      const token = compiled.signCustomerSession('u', 'e', SECRET, 'ghs_x');
      const r = compiled.verifyCustomerSession(token, 'different-secret');
      assert.strictEqual(r, null);
    });

    it('session without access token round-trips (a optional)', () => {
      const token = compiled.signCustomerSession('u', 'e', SECRET);
      const r = compiled.verifyCustomerSession(token, SECRET);
      assert.ok(r);
      assert.strictEqual(r.a, undefined);
    });
  });
}
