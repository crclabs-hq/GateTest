/**
 * Customer session utilities — HMAC-signed cookies for GitHub OAuth customer access.
 *
 * Reuses the same GitHub OAuth App as admin, but without the allowlist check.
 * Any GitHub user can sign in as a customer. Session lasts 30 days.
 */

import crypto from "crypto";

export const CUSTOMER_COOKIE_NAME = "gatetest_customer";
export const CUSTOMER_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days

interface CustomerPayload {
  u: string; // GitHub login
  e: string; // email
  exp: number; // Unix seconds
  // OAuth access token granted to the customer by GitHub OAuth. Used
  // server-side for: probing repo access on scan trigger, pushing the
  // fix branch + opening the PR. NEVER reaches the client — the cookie
  // is AES-256-GCM encrypted with SESSION_SECRET and only decrypts in
  // Node-side handlers. httpOnly prevents browser-script reads.
  // Optional because pre-encryption sessions don't have it (they re-login).
  a?: string;
}

interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  sessionSecret: string;
}

export interface OAuthConfigStatus {
  ok: boolean;
  missing: string[];
  config?: OAuthConfig;
}

export function getOAuthConfig(): OAuthConfigStatus {
  const clientId = process.env.GITHUB_CLIENT_ID || "";
  const clientSecret = process.env.GITHUB_CLIENT_SECRET || "";
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "";
  const redirectUri = baseUrl
    ? `${baseUrl.replace(/\/$/, "")}/api/auth/callback`
    : "";
  const sessionSecret = process.env.SESSION_SECRET || "";

  const missing: string[] = [];
  if (!clientId) missing.push("GITHUB_CLIENT_ID");
  if (!clientSecret) missing.push("GITHUB_CLIENT_SECRET");
  if (!redirectUri) missing.push("NEXT_PUBLIC_BASE_URL");
  if (!sessionSecret) missing.push("SESSION_SECRET");

  if (missing.length > 0) return { ok: false, missing };

  return {
    ok: true,
    missing: [],
    config: { clientId, clientSecret, redirectUri, sessionSecret },
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

// ─── AES-256-GCM payload encryption ──────────────────────────────────────
// Wraps the JSON payload in a layer of authenticated encryption so that
// even if the cookie is exfiltrated from a compromised browser, the
// embedded OAuth access token is unreadable without SESSION_SECRET.
//
// Format: b64url(iv) || "." || b64url(authTag) || "." || b64url(ciphertext)
// The whole concatenation is then HMAC-signed via sign() — we both
// encrypt AND sign for defence in depth.

function deriveKey(secret: string): Buffer {
  // Derive a 32-byte key from the session secret via SHA-256.
  // SESSION_SECRET is expected to be a high-entropy string (per the env
  // hygiene we already enforce). SHA-256 normalises whatever shape the
  // operator provides into a usable AES-256 key.
  return crypto.createHash("sha256").update(secret).digest();
}

function encryptPayload(plaintext: string, secret: string): string {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12); // 96-bit IV for AES-GCM
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${b64urlEncode(iv)}.${b64urlEncode(tag)}.${b64urlEncode(enc)}`;
}

function decryptPayload(ciphertext: string, secret: string): string | null {
  const parts = ciphertext.split(".");
  if (parts.length !== 3) return null;
  try {
    const iv = b64urlDecode(parts[0]);
    const tag = b64urlDecode(parts[1]);
    const enc = b64urlDecode(parts[2]);
    const key = deriveKey(secret);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString("utf-8");
  } catch {
    // Bad ciphertext, wrong key, or modified IV/tag — return null and
    // let the caller fail-closed.
    return null;
  }
}

function sign(payload: string, secret: string): string {
  return b64urlEncode(
    crypto.createHmac("sha256", secret).update(payload).digest()
  );
}

export function signCustomerSession(
  login: string,
  email: string,
  secret: string,
  accessToken?: string
): string {
  const payload: CustomerPayload = {
    u: login,
    e: email,
    exp: Math.floor(Date.now() / 1000) + CUSTOMER_MAX_AGE_SECONDS,
    ...(accessToken ? { a: accessToken } : {}),
  };
  // ENCRYPT the payload before signing — the access token bytes must not
  // be readable from a stolen cookie. The encrypted blob ("v2." prefix)
  // is then HMAC-signed for tamper-detection.
  const encrypted = encryptPayload(JSON.stringify(payload), secret); // pii-ok — AES-encrypting session payload; secret is the encryption key, not user PII being logged
  const blob = `v2.${encrypted}`;
  const sig = sign(blob, secret);
  return `${blob}.${sig}`;
}

export function verifyCustomerSession(
  token: string | undefined | null,
  secret: string
): CustomerPayload | null {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");

  // ─── v2 (encrypted) — preferred format ───
  // Shape: "v2." || iv "." || tag "." || ciphertext "." || sig  → 5 parts
  if (parts.length === 5 && parts[0] === "v2") {
    const blob = parts.slice(0, 4).join(".");
    const sig = parts[4];
    const expectedSig = sign(blob, secret);
    try {
      const a = Buffer.from(sig);
      const b = Buffer.from(expectedSig);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    } catch {
      return null;
    }
    const decrypted = decryptPayload(parts.slice(1, 4).join("."), secret);
    if (!decrypted) return null;
    let payload: CustomerPayload;
    try {
      payload = JSON.parse(decrypted);
    } catch {
      return null;
    }
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;
    return payload;
  }

  // ─── v1 (legacy: signed-only, no encryption) — accept for grace period ───
  // Pre-encryption sessions issued before this commit are still valid
  // until expiry. They won't have `a` (access token) so any handler that
  // needs the OAuth token will surface "please sign in again" via the
  // missing-token path. Remove this branch once telemetry shows no live
  // v1 sessions remain.
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

  let payload: CustomerPayload;
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

export function generateState(): string {
  return b64urlEncode(crypto.randomBytes(24));
}
