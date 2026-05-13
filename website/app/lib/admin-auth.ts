/**
 * Admin authentication — TypeScript surface for Next.js routes.
 *
 * The crypto primitives live in `./admin-auth-verify.js` so they can be
 * unit-tested with `node:test` without compiling TS. This file is the
 * Next.js-aware wrapper: it pulls cookies off `NextRequest` and delegates
 * everything else to the shim.
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
 *   - safeEqual hashes both inputs to fixed 32-byte digests before
 *     `timingSafeEqual` — no length leak (Known Issue #31, 2026-05-13).
 *   - Cookie is httpOnly (JS cannot read it) + secure (HTTPS only in production)
 *     + sameSite=lax (prevents CSRF from other origins).
 *   - If `GATETEST_ADMIN_PASSWORD` is unset, all auth attempts fail — never
 *     accidentally open.
 */

import type { NextRequest } from "next/server";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const verify = require("./admin-auth-verify");

export function verifyAdminPassword(password: string): boolean {
  return verify.verifyAdminPassword(password);
}

export function buildAdminCookieHeader(): string {
  return verify.buildAdminCookieHeader();
}

export function buildAdminClearCookieHeader(): string {
  return verify.buildAdminClearCookieHeader();
}

export function isAdminRequest(req: NextRequest): boolean {
  const cookieValue = req.cookies.get(verify.COOKIE_NAME)?.value || "";
  return verify.isAdminCookieValid(cookieValue);
}

export const ADMIN_COOKIE_NAME: string = verify.COOKIE_NAME;
