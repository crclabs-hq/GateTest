/**
 * Customer Gluecron OAuth — initiate login.
 *
 * GET /api/auth/gluecron?next=<path> → redirect to Gluecron's authorize page.
 * After consent, Gluecron redirects to /api/auth/gluecron/callback.
 *
 * Same shape as the GitHub / Google / GitLab routes (#819, #836) plus PKCE
 * S256, which Gluecron requires: the verifier travels in its own httpOnly
 * cookie next to the state and is only ever sent back to Gluecron's token
 * endpoint by the callback. The pure half (PKCE pair, endpoint discovery,
 * authorize URL) is lib/gluecron-oauth.js.
 */

import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { getGluecronOAuthConfig, generateState } from "../../../lib/customer-session";
import { authUnavailable } from "../../../lib/auth-unavailable";
import { safeNext } from "../../../lib/session-gate";
import { pkcePair, discoverEndpoints, authorizeUrl } from "../../../lib/gluecron-oauth";

export const dynamic = "force-dynamic";

const COOKIE_MAX_AGE = 600;

export async function GET(request: NextRequest) {
  const status = getGluecronOAuthConfig();
  if (!status.ok || !status.config) {
    // A page, never a JSON body naming our unset env vars (lib/auth-unavailable.ts).
    return authUnavailable("Gluecron");
  }

  const { clientId, redirectUri, gluecronBaseUrl } = status.config;
  const state = generateState();
  const { verifier, challenge } = pkcePair();
  const secure = process.env.NODE_ENV === "production";

  const cookieStore = await cookies();
  cookieStore.set("glc_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: COOKIE_MAX_AGE,
    path: "/",
  });
  cookieStore.set("glc_oauth_pkce", verifier, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: COOKIE_MAX_AGE,
    path: "/",
  });

  // Where to land after the callback: the page the visitor was sent here
  // from (/login?next=…). Same-origin paths only — see safeNext().
  const next = safeNext(request.nextUrl.searchParams.get("next"));
  if (next) {
    cookieStore.set("glc_oauth_next", next, {
      httpOnly: true,
      sameSite: "lax",
      secure,
      maxAge: COOKIE_MAX_AGE,
      path: "/",
    });
  } else {
    cookieStore.delete("glc_oauth_next");
  }

  // Metadata document once per process (5 s), fixed URLs if unreachable.
  const endpoints = await discoverEndpoints(gluecronBaseUrl);

  return NextResponse.redirect(authorizeUrl(endpoints, { clientId, redirectUri, state, challenge }));
}
