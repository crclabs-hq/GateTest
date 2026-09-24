/**
 * Admin session utilities — HMAC-signed session cookies for GitHub OAuth admin access.
 *
 * Uses Node's built-in crypto (HMAC-SHA256) to avoid adding external deps.
 * Session payload format (base64url):
 *   {"u":"githubLogin","exp":1234567890}.<hmacSignature>
 */

import crypto from "crypto";
import { ADMIN_COOKIE_NAME } from "./admin-auth";

export const SESSION_COOKIE_NAME = "gatetest_admin_session";
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 days

interface SessionPayload {
  u: string; // GitHub login
  exp: number; // Unix seconds
}

interface AdminConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  sessionSecret: string;
  allowlist: string[];
}

interface AdminConfigStatus {
  ok: boolean;
  missing: string[];
  config?: AdminConfig;
}

/**
 * Read GitHub OAuth + session config from env. Never throws — returns a
 * status object so callers can render a clear "not configured" message
 * instead of crashing (green ecosystem mandate).
 */
export function getAdminConfig(): AdminConfigStatus {
  const clientId = process.env.GITHUB_CLIENT_ID || "";
  const clientSecret = process.env.GITHUB_CLIENT_SECRET || "";
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "";
  const explicitRedirect = process.env.GITHUB_OAUTH_REDIRECT_URI || "";
  const redirectUri =
    explicitRedirect ||
    (baseUrl ? `${baseUrl.replace(/\/$/, "")}/api/github/admin-callback` : "");
  const sessionSecret = process.env.SESSION_SECRET || "";
  const allowlistRaw = process.env.GATETEST_ADMIN_USERNAMES || "";
  const allowlist = allowlistRaw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const missing: string[] = [];
  if (!clientId) missing.push("GITHUB_CLIENT_ID");
  if (!clientSecret) missing.push("GITHUB_CLIENT_SECRET");
  if (!redirectUri) missing.push("GITHUB_OAUTH_REDIRECT_URI or NEXT_PUBLIC_BASE_URL");
  if (!sessionSecret) missing.push("SESSION_SECRET");
  if (allowlist.length === 0) missing.push("GATETEST_ADMIN_USERNAMES");

  if (missing.length > 0) {
    return { ok: false, missing };
  }

  return {
    ok: true,
    missing: [],
    config: { clientId, clientSecret, redirectUri, sessionSecret, allowlist },
  };
}

function b64urlEncode(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf) : buf;
  return b
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function b64urlDecode(str: string): Buffer {
  const pad = "=".repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(payload: string, secret: string): string {
  return b64urlEncode(
    crypto.createHmac("sha256", secret).update(payload).digest()
  );
}

/**
 * Sign a session token for the given GitHub login. Expires in 7 days.
 */
export function signSession(login: string, secret: string): string {
  const payload: SessionPayload = {
    u: login,
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS,
  };
  const encoded = b64urlEncode(JSON.stringify(payload));
  const sig = sign(encoded, secret);
  return `${encoded}.${sig}`;
}

/**
 * Verify a session token and return the payload if valid and not expired.
 * Returns null for any failure (never throws).
 */
function verifySession(
  token: string | undefined | null,
  secret: string
): SessionPayload | null {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;

  const expectedSig = sign(encoded, secret);
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }

  let payload: SessionPayload;
  try {
    payload = JSON.parse(b64urlDecode(encoded).toString("utf-8"));
  } catch {
    return null;
  }

  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  if (typeof payload.u !== "string" || !payload.u) return null;

  return payload;
}

/**
 * Check the incoming session cookie and return the admin user if valid and
 * on the allowlist. Returns null otherwise.
 */
export function getAdminUser(
  cookieValue: string | undefined,
  config: AdminConfig
): string | null {
  const payload = verifySession(cookieValue, config.sessionSecret);
  if (!payload) return null;
  if (!config.allowlist.includes(payload.u.toLowerCase())) return null;
  return payload.u;
}

/**
 * Generate a cryptographically secure OAuth state token.
 */
export function generateState(): string {
  return b64urlEncode(crypto.randomBytes(24));
}

const PASSWORD_HMAC_PAYLOAD = "gatetest-admin-v1";

/** Constant-time check of the password-cookie value against the current env var. */
function checkPasswordCookie(value: string | undefined): boolean {
  const pw = process.env.GATETEST_ADMIN_PASSWORD || "";
  if (!pw || !value) return false;
  const expected = crypto.createHmac("sha256", pw).update(PASSWORD_HMAC_PAYLOAD).digest("hex");
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * The one definition of "who is signed in as admin" (Doctrine #4) — GitHub
 * OAuth session cookie checked first, then the password cookie. Every
 * /admin/* route and page had re-implemented this same two-method check
 * (repos/route.ts's own comment calls it out: "copied verbatim from
 * /api/admin/repos/route.ts"); the admin shell layout needs the same answer
 * to decide whether to render its chrome, so it gets a shared home instead
 * of a fourth copy.
 */
export function getAdminLoginFromCookies(cookieStore: {
  get(name: string): { value: string } | undefined;
}): string | null {
  const oauthStatus = getAdminConfig();
  if (oauthStatus.ok && oauthStatus.config) {
    const login = getAdminUser(cookieStore.get(SESSION_COOKIE_NAME)?.value, oauthStatus.config);
    if (login) return login;
  }
  if (checkPasswordCookie(cookieStore.get(ADMIN_COOKIE_NAME)?.value)) {
    return "admin";
  }
  return null;
}
