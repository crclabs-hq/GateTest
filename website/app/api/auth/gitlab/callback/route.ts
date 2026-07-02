/**
 * Customer GitLab OAuth callback.
 *
 * GET /api/auth/gitlab/callback?code=...&state=...
 * Exchanges code for token, fetches GitLab user profile, creates session.
 */

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  getGitLabOAuthConfig,
  signCustomerSession,
  CUSTOMER_COOKIE_NAME,
  CUSTOMER_MAX_AGE_SECONDS,
} from "../../../../lib/customer-session";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || url.origin;

  const cookieStore = await cookies();
  const storedState = cookieStore.get("gl_oauth_state")?.value;
  cookieStore.delete("gl_oauth_state");

  if (!code || !state || state !== storedState) {
    return NextResponse.redirect(`${baseUrl}/dashboard?error=invalid_state`);
  }

  const status = getGitLabOAuthConfig();
  if (!status.ok || !status.config) {
    return NextResponse.redirect(`${baseUrl}/dashboard?error=not_configured`);
  }

  const { clientId, clientSecret, redirectUri, sessionSecret } = status.config;

  // Exchange code for access token
  let accessToken: string;
  try {
    const tokenRes = await fetch("https://gitlab.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });
    const tokenData = await tokenRes.json();
    accessToken = tokenData.access_token;
    if (!accessToken) {
      return NextResponse.redirect(`${baseUrl}/dashboard?error=token_failed`);
    }
  } catch {
    return NextResponse.redirect(`${baseUrl}/dashboard?error=token_failed`);
  }

  // Fetch GitLab user profile
  let login: string;
  let email: string;
  try {
    const userRes = await fetch("https://gitlab.com/api/v4/user", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const user = await userRes.json();
    login = user.username || user.name || "";
    email = user.email || user.public_email || "";

    if (!login) {
      return NextResponse.redirect(`${baseUrl}/dashboard?error=user_failed`);
    }
  } catch {
    return NextResponse.redirect(`${baseUrl}/dashboard?error=user_failed`);
  }

  const token = signCustomerSession(login, email, sessionSecret);
  const isProduction = process.env.NODE_ENV === "production";

  const response = NextResponse.redirect(`${baseUrl}/dashboard`);
  response.headers.set(
    "Set-Cookie",
    [
      `${CUSTOMER_COOKIE_NAME}=${token}`,
      `Max-Age=${CUSTOMER_MAX_AGE_SECONDS}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      ...(isProduction ? ["Secure"] : []),
    ].join("; ")
  );

  return response;
}
