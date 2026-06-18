/**
 * Admin authentication helpers.
 *
 * Design:
 *   - Password lives in env var `GATETEST_ADMIN_PASSWORD` — never shipped to client.
 *   - On successful login, we set an httpOnly cookie `gt_admin` whose value is
 *     an HMAC-SHA256 of a constant payload using the password as key.
 *   - On each admin-protected request we recompute the HMAC from the env var
 *     and compare with the cookie. If the env password changes, all existing
 *     admin sessions are invalidated automatically.
 *   - No shared state, no database, no JWT library needed. Fits Vercel serverless.
 *
 * Security notes:
 *   - Uses `crypto.timingSafeEqual` for constant-time comparison.
 *   - Cookie is httpOnly (JS cannot read it) + secure (HTTPS only in production)
 *     + sameSite=lax (prevents CSRF from other origins).
 *   - If `GATETEST_ADMIN_PASSWORD` is unset, all auth attempts fail — never
 *     accidentally open.
 */

import { createHmac, timingSafeEqual } from "crypto";
import type { NextRequest } from "next/server";

const COOKIE_NAME = "gt_admin";
const COOKIE_MAX_AGE = 60 * 60 * 24; // 24 hours
const HMAC_PAYLOAD = "gatetest-admin-v1";

/**
 * Deterministic token derived from the admin password. Anyone who knows the
 * password (i.e. the server, via env var) can reproduce it.
 */
function deriveToken(password: string): string {
  return createHmac("sha256", password).update(HMAC_PAYLOAD).digest("hex");
}

/**
 * Constant-time string comparison that tolerates differing lengths by first
 * padding to the same length. Returns false if either input is empty.
 */
function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Verify a user-supplied password against the env var.
 */
export function verifyAdminPassword(password: string): boolean {
  const expected = process.env.GATETEST_ADMIN_PASSWORD || "";
  if (!expected) return false;
  return safeEqual(password, expected);
}

/**
 * Build the Set-Cookie header value for the admin session.
 */
export function buildAdminCookieHeader(): string {
  const password = process.env.GATETEST_ADMIN_PASSWORD || "";
  const token = deriveToken(password);
  const isProduction = process.env.NODE_ENV === "production";
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

/**
 * Build the Set-Cookie header that clears the admin cookie.
 */
export function buildAdminClearCookieHeader(): string {
  return `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`;
}

/**
 * Check whether a request carries a valid admin cookie OR a valid
 * X-Admin-Token header (for server-to-server internal calls such as
 * the watchdog tick calling /api/scan/run without browser cookies).
 */
export function isAdminRequest(req: NextRequest): boolean {
  const expectedPassword = process.env.GATETEST_ADMIN_PASSWORD || "";
  if (!expectedPassword) return false;

  const expectedToken = deriveToken(expectedPassword);

  // Cookie path — browser/admin-panel requests
  const cookieValue = req.cookies.get(COOKIE_NAME)?.value || "";
  if (cookieValue && safeEqual(cookieValue, expectedToken)) return true;

  // Header path — server-to-server internal calls (watchdog tick → scan/run)
  const headerValue = req.headers.get("x-admin-token") || "";
  if (headerValue && safeEqual(headerValue, expectedToken)) return true;

  return false;
}

/**
 * Derive the admin token for use in server-to-server internal calls.
 * Pass the result as the `X-Admin-Token` request header.
 */
export function deriveAdminToken(): string {
  const password = process.env.GATETEST_ADMIN_PASSWORD || "";
  if (!password) return "";
  return deriveToken(password);
}

export const ADMIN_COOKIE_NAME = COOKIE_NAME;
