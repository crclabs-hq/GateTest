/**
 * GitHub OAuth — Admin Callback
 *
 * Exchanges the OAuth code for an access token, fetches the authenticated
 * GitHub user, verifies they're on GATETEST_ADMIN_USERNAMES, and sets a
 * signed HMAC session cookie on success.
 *
 * URL: /api/github/admin-callback?code=...&state=...
 */

import { NextRequest, NextResponse } from "next/server";
import https from "https";
import {
  getAdminConfig,
  signSession,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
} from "../../../lib/admin-session";
import { siteUrl } from "../../../lib/site-url";

const STATE_COOKIE_NAME = "gatetest_admin_oauth_state";

function httpsRequest(
  options: https.RequestOptions,
  body?: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode || 0,
          body: Buffer.concat(chunks).toString("utf-8"),
        });
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("GitHub OAuth request timed out"));
    });
    if (body) req.write(body);
    req.end();
  });
}

async function exchangeCodeForToken(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string
): Promise<string | null> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  }).toString();

  const { status, body: responseBody } = await httpsRequest(
    {
      hostname: "github.com",
      port: 443,
      path: "/login/oauth/access_token",
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": String(Buffer.byteLength(body)),
        "User-Agent": "GateTest/1.2.0",
      },
    },
    body
  );

  if (status !== 200) return null;
  try {
    const parsed = JSON.parse(responseBody);
    return parsed.access_token || null;
  } catch {
    return null;
  }
}

async function fetchGithubLogin(token: string): Promise<string | null> {
  const { status, body } = await httpsRequest({
    hostname: "api.github.com",
    port: 443,
    path: "/user",
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "GateTest/1.2.0",
    },
  });

  if (status !== 200) return null;
  try {
    const parsed = JSON.parse(body);
    return typeof parsed.login === "string" ? parsed.login : null;
  } catch {
    return null;
  }
}

// Redirects are built from the PUBLIC site URL, never from req.url: behind
// the box's reverse proxy req.url resolves to the internal bind address and
// the browser would be sent to a private IP (same bug class as the customer
// install callback, fixed 2026-09-10).
function errorRedirect(_req: NextRequest, reason: string): NextResponse {
  const url = new URL(siteUrl("/admin"));
  url.searchParams.set("error", reason);
  const res = NextResponse.redirect(url);
  res.cookies.delete(STATE_COOKIE_NAME);
  return res;
}

export async function GET(req: NextRequest) {
  const status = getAdminConfig();
  if (!status.ok || !status.config) {
    return NextResponse.json(
      { error: "Admin panel not configured", missing: status.missing },
      { status: 503 }
    );
  }

  const { clientId, clientSecret, redirectUri, sessionSecret, allowlist } =
    status.config;

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const expectedState = req.cookies.get(STATE_COOKIE_NAME)?.value;

  if (!code || !state || !expectedState || state !== expectedState) {
    return errorRedirect(req, "invalid_state");
  }

  let token: string | null;
  try {
    token = await exchangeCodeForToken(clientId, clientSecret, code, redirectUri);
  } catch {
    return errorRedirect(req, "token_exchange_failed");
  }
  if (!token) return errorRedirect(req, "token_exchange_failed");

  let login: string | null;
  try {
    login = await fetchGithubLogin(token);
  } catch {
    return errorRedirect(req, "user_fetch_failed");
  }
  if (!login) return errorRedirect(req, "user_fetch_failed");

  if (!allowlist.includes(login.toLowerCase())) {
    return errorRedirect(req, "not_authorized");
  }

  const session = signSession(login, sessionSecret);
  const res = NextResponse.redirect(siteUrl("/admin"));
  res.cookies.set(SESSION_COOKIE_NAME, session, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  res.cookies.delete(STATE_COOKIE_NAME);
  return res;
}
