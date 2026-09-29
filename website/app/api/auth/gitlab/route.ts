/**
 * Customer GitLab OAuth — initiate login.
 *
 * GET /api/auth/gitlab?next=<path> → redirect to GitLab OAuth consent screen.
 * After consent, GitLab redirects to /api/auth/gitlab/callback.
 */

import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { getGitLabOAuthConfig, generateState } from "../../../lib/customer-session";
import { authUnavailable } from "../../../lib/auth-unavailable";
import { safeNext } from "../../../lib/session-gate";

export async function GET(request: NextRequest) {
  const status = getGitLabOAuthConfig();
  if (!status.ok || !status.config) {
    // Was a JSON body that also listed our unset env var names to an
    // anonymous visitor. See lib/auth-unavailable.ts.
    return authUnavailable("GitLab");
  }

  const { clientId, redirectUri } = status.config;
  const state = generateState();

  const cookieStore = await cookies();
  cookieStore.set("gl_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });

  // Where to land after the callback (/login?next=…). Same-origin paths only —
  // see safeNext(). Same shape as the GitHub route (#819).
  const next = safeNext(request.nextUrl.searchParams.get("next"));
  if (next) {
    cookieStore.set("gl_oauth_next", next, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 600,
      path: "/",
    });
  } else {
    cookieStore.delete("gl_oauth_next");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "read_user",
    state,
  });

  return NextResponse.redirect(
    `https://gitlab.com/oauth/authorize?${params.toString()}`
  );
}
