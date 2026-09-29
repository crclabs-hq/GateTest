/**
 * Customer Gluecron OAuth callback.
 *
 * GET /api/auth/gluecron/callback?code=...&state=...
 * Checks state, exchanges the code (with the PKCE verifier) at Gluecron's
 * token endpoint, reads the profile from userinfo, signs the customer
 * session exactly as the Google callback does. Failures land on
 * /login?error=gluecron_<code> (the page shows the copy; anonymous
 * /dashboard is gated, so an error there was never seen). All three
 * transient cookies are cleared on every path, success or not.
 *
 * Fails closed while Gluecron's userinfo endpoint is not deployed yet: a
 * 404 there is `gluecron_user_failed` ("Gluecron did not return your
 * profile"), never a session for an unknown person. An email Gluecron has
 * not verified is `gluecron_email_unverified`.
 *
 * The customers table (release-notifier.js ensureSchema) has a github_login
 * column and no gluecron one; like the Google and GitLab callbacks this
 * one leaves the row shape alone — the session cookie is the record.
 *
 * Tokens are never logged. Both upstream calls have a 5 s deadline.
 */

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  getGluecronOAuthConfig,
  signCustomerSession,
  CUSTOMER_COOKIE_NAME,
  CUSTOMER_MAX_AGE_SECONDS,
} from "../../../../lib/customer-session";
import { safeNext } from "../../../../lib/session-gate";
import {
  discoverEndpoints,
  fetchWithTimeout,
  tokenRequestBody,
  profileFromUserinfo,
  isValidVerifier,
  GLUECRON_OAUTH_TIMEOUT_MS,
} from "../../../../lib/gluecron-oauth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || url.origin;

  const cookieStore = await cookies();
  const storedState = cookieStore.get("glc_oauth_state")?.value;
  cookieStore.delete("glc_oauth_state");
  const verifier = cookieStore.get("glc_oauth_pkce")?.value;
  cookieStore.delete("glc_oauth_pkce");
  // Where /login?next=… wanted to go; re-validated here, the cookie is client-held.
  const landing = safeNext(cookieStore.get("glc_oauth_next")?.value) ?? "/dashboard";
  cookieStore.delete("glc_oauth_next");

  if (!code || !state || state !== storedState || !isValidVerifier(verifier)) {
    return NextResponse.redirect(`${baseUrl}/login?error=gluecron_invalid_state`);
  }

  const status = getGluecronOAuthConfig();
  if (!status.ok || !status.config) {
    return NextResponse.redirect(`${baseUrl}/login?error=gluecron_not_configured`);
  }

  const { clientId, clientSecret, redirectUri, sessionSecret, gluecronBaseUrl } = status.config;
  const endpoints = await discoverEndpoints(gluecronBaseUrl);

  // Exchange code (+ PKCE verifier) for an access token
  let accessToken: string;
  try {
    const tokenRes = await fetchWithTimeout(
      fetch,
      endpoints.token_endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: tokenRequestBody({ clientId, clientSecret, code, redirectUri, verifier: verifier as string }).toString(),
      },
      GLUECRON_OAUTH_TIMEOUT_MS,
    );
    const tokenData = await tokenRes.json();
    accessToken = typeof tokenData?.access_token === "string" ? tokenData.access_token : "";
    if (!tokenRes.ok || !accessToken) {
      return NextResponse.redirect(`${baseUrl}/login?error=gluecron_token_failed`);
    }
  } catch {
    return NextResponse.redirect(`${baseUrl}/login?error=gluecron_token_failed`);
  }

  // Fetch the profile. A 404 (userinfo not deployed yet) or any other
  // non-2xx is "no profile" — fail closed, never sign in a guess.
  let login: string;
  let email: string;
  try {
    const userRes = await fetchWithTimeout(
      fetch,
      endpoints.userinfo_endpoint,
      { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } },
      GLUECRON_OAUTH_TIMEOUT_MS,
    );
    let body: unknown = null;
    try { body = await userRes.json(); } catch { body = null; }
    const profile = profileFromUserinfo(userRes.status, body);
    if (!profile.ok) {
      if (profile.reason === "email_unverified") {
        return NextResponse.redirect(`${baseUrl}/login?error=gluecron_email_unverified`);
      }
      return NextResponse.redirect(`${baseUrl}/login?error=gluecron_user_failed`);
    }
    login = profile.login;
    email = profile.email;
  } catch {
    return NextResponse.redirect(`${baseUrl}/login?error=gluecron_user_failed`);
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
