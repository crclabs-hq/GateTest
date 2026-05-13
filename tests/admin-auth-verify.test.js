// ============================================================================
// ADMIN AUTH PRIMITIVES — pure-helper coverage
// ============================================================================
// Covers website/app/lib/admin-auth-verify.js — the security-critical
// primitives behind the /admin login flow. The .ts wrapper at
// website/app/lib/admin-auth.ts delegates here, so testing this file
// transitively covers admin-route auth.
//
// Particular focus on the length-leak fix (Known Issue #31, 2026-05-13):
// safeEqual must NOT short-circuit on length mismatch. A remote attacker
// who could measure response time would otherwise infer the expected
// password's length, narrowing brute-force significantly.
// ============================================================================
const { describe, it } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");

const verify = require("../website/app/lib/admin-auth-verify");

const PASSWORD = "correct-horse-battery-staple-9f2a";

describe("safeEqual — constant-time + no length leak", () => {
  it("returns true for identical strings", () => {
    assert.strictEqual(verify.safeEqual("abc123", "abc123"), true);
  });

  it("returns false for different strings of same length", () => {
    assert.strictEqual(verify.safeEqual("abcdef", "abcxyz"), false);
  });

  it("returns false for different lengths WITHOUT short-circuiting", () => {
    // Crucial: this is the length-leak fix from Known Issue #31. The OLD
    // implementation returned false at the length check; the NEW one hashes
    // both sides to a fixed 32-byte digest first.
    assert.strictEqual(verify.safeEqual("a", "ab"), false);
    assert.strictEqual(verify.safeEqual("short", "much-longer-string"), false);
    assert.strictEqual(verify.safeEqual("x".repeat(8), "x".repeat(64)), false);
  });

  it("returns false for empty inputs", () => {
    assert.strictEqual(verify.safeEqual("", "anything"), false);
    assert.strictEqual(verify.safeEqual("anything", ""), false);
    assert.strictEqual(verify.safeEqual("", ""), false);
  });

  it("returns false for null/undefined inputs", () => {
    assert.strictEqual(verify.safeEqual(null, "x"), false);
    assert.strictEqual(verify.safeEqual("x", null), false);
    assert.strictEqual(verify.safeEqual(undefined, "x"), false);
  });

  it("handles unicode without throwing", () => {
    assert.strictEqual(verify.safeEqual("résumé", "résumé"), true);
    assert.strictEqual(verify.safeEqual("résumé", "resume"), false);
  });

  it("handles very long inputs without throwing", () => {
    const a = "a".repeat(100000);
    const b = "a".repeat(100000);
    const c = "b".repeat(100000);
    assert.strictEqual(verify.safeEqual(a, b), true);
    assert.strictEqual(verify.safeEqual(a, c), false);
  });
});

describe("verifyAdminPassword — env-keyed verification", () => {
  it("returns true when password matches GATETEST_ADMIN_PASSWORD", () => {
    assert.strictEqual(
      verify.verifyAdminPassword(PASSWORD, { GATETEST_ADMIN_PASSWORD: PASSWORD }),
      true,
    );
  });

  it("returns false when password does not match", () => {
    assert.strictEqual(
      verify.verifyAdminPassword("wrong", { GATETEST_ADMIN_PASSWORD: PASSWORD }),
      false,
    );
  });

  it("FAIL CLOSED when env var is empty (never accidentally open)", () => {
    assert.strictEqual(
      verify.verifyAdminPassword(PASSWORD, { GATETEST_ADMIN_PASSWORD: "" }),
      false,
    );
  });

  it("FAIL CLOSED when env var is missing entirely", () => {
    assert.strictEqual(verify.verifyAdminPassword(PASSWORD, {}), false);
  });

  it("FAIL CLOSED when env var is undefined", () => {
    assert.strictEqual(
      verify.verifyAdminPassword(PASSWORD, {
        GATETEST_ADMIN_PASSWORD: undefined,
      }),
      false,
    );
  });

  it("rejects empty supplied password even with env set", () => {
    assert.strictEqual(
      verify.verifyAdminPassword("", { GATETEST_ADMIN_PASSWORD: PASSWORD }),
      false,
    );
  });
});

describe("deriveToken — HMAC stability + rotation", () => {
  it("is deterministic for the same password", () => {
    const a = verify.deriveToken(PASSWORD);
    const b = verify.deriveToken(PASSWORD);
    assert.strictEqual(a, b);
  });

  it("changes when the password changes (session rotation)", () => {
    const a = verify.deriveToken("password-v1");
    const b = verify.deriveToken("password-v2");
    assert.notStrictEqual(a, b);
  });

  it("returns a 64-char hex digest", () => {
    const token = verify.deriveToken(PASSWORD);
    assert.strictEqual(token.length, 64);
    assert.match(token, /^[0-9a-f]{64}$/);
  });

  it("is keyed on the password (changing payload would change output)", () => {
    // Sanity: if HMAC_PAYLOAD ever drifts, every existing admin session
    // would be invalidated — confirm the payload is what we expect.
    assert.strictEqual(verify.HMAC_PAYLOAD, "gatetest-admin-v1");
  });
});

describe("isAdminCookieValid — request-side cookie check", () => {
  it("accepts a cookie value that matches the env-derived token", () => {
    const cookie = verify.deriveToken(PASSWORD);
    assert.strictEqual(
      verify.isAdminCookieValid(cookie, { GATETEST_ADMIN_PASSWORD: PASSWORD }),
      true,
    );
  });

  it("rejects a cookie that does not match", () => {
    assert.strictEqual(
      verify.isAdminCookieValid("garbage", { GATETEST_ADMIN_PASSWORD: PASSWORD }),
      false,
    );
  });

  it("rejects empty cookie", () => {
    assert.strictEqual(
      verify.isAdminCookieValid("", { GATETEST_ADMIN_PASSWORD: PASSWORD }),
      false,
    );
  });

  it("rejects cookie when env var is unset (post-rotation lockout)", () => {
    const cookie = verify.deriveToken(PASSWORD);
    assert.strictEqual(verify.isAdminCookieValid(cookie, {}), false);
  });

  it("rejects cookie minted from a different (rotated) password", () => {
    const cookie = verify.deriveToken("old-password");
    assert.strictEqual(
      verify.isAdminCookieValid(cookie, { GATETEST_ADMIN_PASSWORD: "new-password" }),
      false,
    );
  });
});

describe("buildAdminCookieHeader — Set-Cookie shape", () => {
  it("contains the derived token, HttpOnly, SameSite, and Path", () => {
    const header = verify.buildAdminCookieHeader({
      GATETEST_ADMIN_PASSWORD: PASSWORD,
    });
    assert.match(header, /^gt_admin=[0-9a-f]{64};/);
    assert.match(header, /HttpOnly/);
    assert.match(header, /SameSite=Lax/);
    assert.match(header, /Path=\//);
    assert.match(header, /Max-Age=86400/);
  });

  it("includes Secure flag when NODE_ENV=production", () => {
    const header = verify.buildAdminCookieHeader({
      GATETEST_ADMIN_PASSWORD: PASSWORD,
      NODE_ENV: "production",
    });
    assert.match(header, /Secure/);
  });

  it("omits Secure flag when NODE_ENV is not production", () => {
    const header = verify.buildAdminCookieHeader({
      GATETEST_ADMIN_PASSWORD: PASSWORD,
      NODE_ENV: "development",
    });
    assert.doesNotMatch(header, /Secure/);
  });
});

describe("buildAdminClearCookieHeader — logout shape", () => {
  it("expires the cookie immediately and preserves security flags", () => {
    const header = verify.buildAdminClearCookieHeader();
    assert.match(header, /^gt_admin=;/);
    assert.match(header, /Max-Age=0/);
    assert.match(header, /HttpOnly/);
    assert.match(header, /SameSite=Lax/);
  });
});
