/**
 * Customer GitHub OAuth callback.
 *
 * GET /api/auth/callback?code=...&state=...
 * Exchanges code for token, fetches user profile, creates session.
 */

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  getOAuthConfig,
  signCustomerSession,
  CUSTOMER_COOKIE_NAME,
  CUSTOMER_MAX_AGE_SECONDS,
} from "../../../lib/customer-session";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || url.origin;

  const cookieStore = await cookies();
  const storedState = cookieStore.get("gh_oauth_state")?.value;

  // Clear state cookie
  cookieStore.delete("gh_oauth_state");

  if (!code || !state || state !== storedState) {
    return NextResponse.redirect(`${baseUrl}/dashboard?error=invalid_state`);
  }

  const status = getOAuthConfig();
  if (!status.ok || !status.config) {
    return NextResponse.redirect(`${baseUrl}/dashboard?error=not_configured`);
  }

  const { clientId, clientSecret, sessionSecret } = status.config;

  // Exchange code for access token
  let accessToken: string;
  try {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
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

  // Fetch user profile
  let login: string;
  let email: string;
  try {
    const userRes = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const user = await userRes.json();
    login = user.login;

    // Get primary email
    email = user.email || "";
    if (!email) {
      const emailsRes = await fetch("https://api.github.com/user/emails", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const emails = await emailsRes.json();
      const primary = emails.find(
        (e: { primary: boolean; verified: boolean; email: string }) =>
          e.primary && e.verified
      );
      email = primary?.email || emails[0]?.email || "";
    }

    if (!login) {
      return NextResponse.redirect(`${baseUrl}/dashboard?error=user_failed`);
    }
  } catch {
    return NextResponse.redirect(`${baseUrl}/dashboard?error=user_failed`);
  }

  // Create session — include the OAuth access token so server-side
  // routes (scan/fix, etc.) can act on the customer's behalf without
  // re-prompting for a PAT. The token is AES-256-GCM encrypted inside
  // the cookie payload; httpOnly prevents browser-script access; never
  // logged.
  const token = signCustomerSession(login, email, sessionSecret, accessToken);
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
