/**
 * The one admin gate for API routes.
 *
 *   const refused = requireAdminRoute(req, { mutating: true });
 *   if (refused) return refused;
 *
 * A request is the admin when EITHER
 *   - isAdminRequest(req) (lib/admin-auth.ts) — the `gt_admin` password
 *     cookie, or the same HMAC token in `X-Admin-Token` for server-to-server
 *     calls; or
 *   - getAdminLoginFromCookies(req.cookies) (lib/admin-session.ts) — the
 *     GitHub OAuth admin session on the allowlist, or the password cookie.
 * Those are the same two answers the /admin pages use to decide whether to
 * render, so a page that renders never gets a 401 from its own API.
 *
 * `mutating` adds the same-origin check the password and secrets routes use
 * (csrfOk in lib/password-auth-http.ts): the admin cookie is SameSite=Lax,
 * which still rides a top-level cross-site navigation, so every write — and
 * every read that spends paid API budget — must come from this site. When
 * the option is left out it follows the method: anything other than
 * GET / HEAD / OPTIONS is treated as mutating.
 *
 * Every refusal is JSON with `cache-control: no-store`:
 *   401 { error: "unauthorized" }  — not signed in as the admin
 *   403 { error: "cross_origin" }  — admin, but a write from another origin
 *
 * History: three routes (hn-launch/poll, hn-launch/draft, seo/submit)
 * checked only that a cookie named `gatetest_admin` EXISTED — any value
 * passed, and the real cookie is `gt_admin`, so the owner was locked out
 * while anyone could spend the paid API budget. Two dozen more carried their
 * own copy of the two-method check. They all call this now, and
 * tests/admin-route-guard.test.js keeps it that way.
 */

import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "./admin-auth";
import { getAdminLoginFromCookies } from "./admin-session";
import { csrfOk } from "./password-auth-http";

const NO_STORE = { "cache-control": "no-store" } as const;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The body of every refusal. */
export type AdminRefusal = { error: "unauthorized" | "cross_origin" };

export interface AdminRouteOptions {
  /** Run the same-origin check. Defaults to true for any non-GET/HEAD/OPTIONS method. */
  mutating?: boolean;
}

/** True when the request carries a valid admin credential (either method). */
export function isAdminRouteRequest(req: NextRequest): boolean {
  return isAdminRequest(req) || Boolean(getAdminLoginFromCookies(req.cookies));
}

/**
 * Who the admin is, for routes that record it (e.g. watches.owner_login):
 * the GitHub login of an OAuth admin session, else "admin" (password cookie
 * or the internal token). Call only after requireAdminRoute has passed.
 */
export function adminLoginOf(req: NextRequest): string {
  return getAdminLoginFromCookies(req.cookies) || "admin";
}

/** A no-store JSON refusal. */
function refuse(error: AdminRefusal["error"], status: number): NextResponse<AdminRefusal> {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

/**
 * Gate an admin API route. Returns the response to send when refused, or
 * null when the caller is the admin (and, for writes, same-origin).
 */
export function requireAdminRoute(req: NextRequest, opts: AdminRouteOptions = {}): NextResponse<AdminRefusal> | null {
  if (!isAdminRouteRequest(req)) return refuse("unauthorized", 401);
  const mutating = opts.mutating ?? !SAFE_METHODS.has(String(req.method || "GET").toUpperCase());
  if (mutating && !csrfOk(req)) return refuse("cross_origin", 403);
  return null;
}
