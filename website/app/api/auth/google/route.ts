/**
 * Customer Google OAuth — initiate login.
 *
 * GET /api/auth/google?next=<path> → redirect to Google OAuth consent screen.
 * After consent, Google redirects to /api/auth/google/callback.
 */

import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { getGoogleOAuthConfig, generateState } from "../../../lib/customer-session";
import { authUnavailable } from "../../../lib/auth-unavailable";
import { safeNext } from "../../../lib/session-gate";

export async function GET(request: NextRequest) {
  const status = getGoogleOAuthConfig();
  if (!status.ok || !status.config) {
    // Was a JSON body that also listed our unset env var names to an
    // anonymous visitor. See lib/auth-unavailable.ts.
    return authUnavailable("Google");
  }

  const { clientId, redirectUri } = status.config;
  const state = generateState();

  const cookieStore = await cookies();
  cookieStore.set("goog_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });

  // Where to land after the callback: the page the visitor was sent here
  // from (/login?next=…). Same-origin paths only — see safeNext(). Same
  // shape as the GitHub route (#819).
  const next = safeNext(request.nextUrl.searchParams.get("next"));
  if (next) {
    cookieStore.set("goog_oauth_next", next, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 600,
      path: "/",
    });
  } else {
    cookieStore.delete("goog_oauth_next");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
    prompt: "select_account",
  });

  return NextResponse.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
  );
}
