/**
 * Admin authentication — pure helpers (testable shim).
 *
 * The TypeScript file `website/app/lib/admin-auth.ts` is the public surface
 * (Next.js routes import it). It re-exports everything from this `.js` so
 * the security-critical primitives can be exercised by `node:test` without
 * runtime-compiling TS.
 *
 * Shipping these helpers untested would violate Bible Quality Bar #1
 * ("Untested code does not exist"). Tests live at
 * tests/admin-auth-verify.test.js.
 *
 * Security primitives covered:
 *   - safeEqual:      constant-time compare with NO length leak (hashes both
 *                     inputs to a fixed 32-byte digest before comparing)
 *   - deriveToken:    deterministic HMAC-SHA256 of a constant payload, keyed
 *                     on the password — rotates automatically when password
 *                     rotates
 *   - verifyAdminPassword: env-keyed verification that fails closed when the
 *                          env var is unset
 */

const { createHash, createHmac, timingSafeEqual } = require("crypto");

const COOKIE_NAME = "gt_admin";
const COOKIE_MAX_AGE = 60 * 60 * 24; // 24 hours
const HMAC_PAYLOAD = "gatetest-admin-v1";

function deriveToken(password) {
  return createHmac("sha256", password).update(HMAC_PAYLOAD).digest("hex");
}

/**
 * Constant-time string comparison. Hashes both inputs to a fixed 32-byte
 * digest before comparing so length differences cannot leak via timing.
 *
 * The naive `bufA.length !== bufB.length → return false` shortcut reveals
 * the expected secret's length to a remote attacker who can measure response
 * latency — fixed 2026-05-13 (Known Issue #31).
 */
function safeEqual(a, b) {
  if (!a || !b) return false;
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

function verifyAdminPassword(password, env = process.env) {
  const expected = env.GATETEST_ADMIN_PASSWORD || "";
  if (!expected) return false;
  return safeEqual(password, expected);
}

function buildAdminCookieHeader(env = process.env) {
  const password = env.GATETEST_ADMIN_PASSWORD || "";
  const token = deriveToken(password);
  const isProduction = env.NODE_ENV === "production";
  const parts = [
    `${COOKIE_NAME}=${token}`,
    `Max-Age=${COOKIE_MAX_AGE}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isProduction) parts.push("Secure");
  return parts.join("; ");
}

function buildAdminClearCookieHeader() {
  return `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`;
}

/**
 * Verify a cookie value against the env-derived expected token. Returns
 * `true` only if both the env var is set AND the cookie matches. Decoupled
 * from `NextRequest` so the .ts wrapper can extract the cookie however it
 * wants while keeping the comparison logic testable.
 */
function isAdminCookieValid(cookieValue, env = process.env) {
  const expectedPassword = env.GATETEST_ADMIN_PASSWORD || "";
  if (!expectedPassword) return false;
  if (!cookieValue) return false;
  const expectedToken = deriveToken(expectedPassword);
  return safeEqual(cookieValue, expectedToken);
}

module.exports = {
  COOKIE_NAME,
  COOKIE_MAX_AGE,
  HMAC_PAYLOAD,
  deriveToken,
  safeEqual,
  verifyAdminPassword,
  buildAdminCookieHeader,
  buildAdminClearCookieHeader,
  isAdminCookieValid,
};
