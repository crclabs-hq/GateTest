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
  githubSessionEmail,
  CUSTOMER_COOKIE_NAME,
  CUSTOMER_MAX_AGE_SECONDS,
} from "../../../lib/customer-session";
import { safeNext } from "../../../lib/session-gate";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || url.origin;

  const cookieStore = await cookies();
  const storedState = cookieStore.get("gh_oauth_state")?.value;

  // Clear state cookie
  cookieStore.delete("gh_oauth_state");
  // Where /login?next=… wanted to go; re-validated here, the cookie is client-held.
  const landing = safeNext(cookieStore.get("gh_oauth_next")?.value) ?? "/dashboard";
  cookieStore.delete("gh_oauth_next");

  if (!code || !state || state !== storedState) {
    return NextResponse.redirect(`${baseUrl}/login?error=invalid_state`);
  }

  const status = getOAuthConfig();
  if (!status.ok || !status.config) {
    return NextResponse.redirect(`${baseUrl}/login?error=not_configured`);
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
      return NextResponse.redirect(`${baseUrl}/login?error=token_failed`);
    }
  } catch {
    return NextResponse.redirect(`${baseUrl}/login?error=token_failed`);
  }

  // Fetch user profile
  let login: string;
  let email: string;
  let emailVerified: boolean;
  try {
    const userRes = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const user = await userRes.json();
    login = user.login;

    // /user/emails (scope user:email) says whether the address is verified —
    // the admin allowlist by email needs that. It is always read now; a
    // failure there is only fatal when there is no public email to fall back
    // on (as before, when it was read only in that case).
    const profileEmail = typeof user.email === "string" ? user.email : "";
    let emails: unknown = null;
    try {
      const emailsRes = await fetch("https://api.github.com/user/emails", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      emails = await emailsRes.json();
    } catch {
      emails = null;
    }
    if (!profileEmail && !Array.isArray(emails)) {
      return NextResponse.redirect(`${baseUrl}/login?error=user_failed`);
    }
    const picked = githubSessionEmail(profileEmail, emails);
    email = picked.email;
    emailVerified = picked.verified;

    if (!login) {
      return NextResponse.redirect(`${baseUrl}/login?error=user_failed`);
    }
  } catch {
    return NextResponse.redirect(`${baseUrl}/login?error=user_failed`);
  }

  // Create session — include the OAuth access token so server-side
  // routes (scan/fix, etc.) can act on the customer's behalf without
  // re-prompting for a PAT. The token is AES-256-GCM encrypted inside
  // the cookie payload; httpOnly prevents browser-script access; never
  // logged.
  const token = signCustomerSession(login, email, sessionSecret, accessToken, emailVerified);
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
