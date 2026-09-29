/**
 * Customer Google OAuth callback.
 *
 * GET /api/auth/google/callback?code=...&state=...
 * Exchanges code for token, fetches Google user profile, creates session.
 * Failures land on /login?error=google_<code> (the page shows the copy;
 * anonymous /dashboard is gated, so an error there was never seen).
 */

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  getGoogleOAuthConfig,
  signCustomerSession,
  CUSTOMER_COOKIE_NAME,
  CUSTOMER_MAX_AGE_SECONDS,
} from "../../../../lib/customer-session";
import { safeNext } from "../../../../lib/session-gate";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || url.origin;

  const cookieStore = await cookies();
  const storedState = cookieStore.get("goog_oauth_state")?.value;
  cookieStore.delete("goog_oauth_state");
  // Where /login?next=… wanted to go; re-validated here, the cookie is client-held.
  const landing = safeNext(cookieStore.get("goog_oauth_next")?.value) ?? "/dashboard";
  cookieStore.delete("goog_oauth_next");

  if (!code || !state || state !== storedState) {
    return NextResponse.redirect(`${baseUrl}/login?error=google_invalid_state`);
  }

  const status = getGoogleOAuthConfig();
  if (!status.ok || !status.config) {
    return NextResponse.redirect(`${baseUrl}/login?error=google_not_configured`);
  }

  const { clientId, clientSecret, redirectUri, sessionSecret } = status.config;

  // Exchange code for access token
  let accessToken: string;
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }).toString(),
    });
    const tokenData = await tokenRes.json();
    accessToken = tokenData.access_token;
    if (!accessToken) {
      return NextResponse.redirect(`${baseUrl}/login?error=google_token_failed`);
    }
  } catch {
    return NextResponse.redirect(`${baseUrl}/login?error=google_token_failed`);
  }

  // Fetch Google user profile
  let login: string;
  let email: string;
  try {
    const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const user = await userRes.json();
    email = user.email || "";
    // Use email prefix as login identifier (Google has no "username")
    login = user.name || email.split("@")[0] || user.id || "";

    if (!login) {
      return NextResponse.redirect(`${baseUrl}/login?error=google_user_failed`);
    }
  } catch {
    return NextResponse.redirect(`${baseUrl}/login?error=google_user_failed`);
  }

  const token = signCustomerSession(login, email, sessionSecret);
  const isProduction = process.env.NODE_ENV === "production";

  const response = NextResponse.redirect(`${baseUrl}${landing}`);
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
