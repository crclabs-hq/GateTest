'use strict';
/**
 * "Sign in with Gluecron" — the pure half, ONE definition (Doctrine #4).
 *
 * The two route handlers (app/api/auth/gluecron/route.ts and its callback)
 * are thin: they hold cookies and redirect. Everything that can be asserted
 * without a Next build lives here — the PKCE pair, the authorization
 * server's endpoints (discovered from its metadata document, with the fixed
 * URLs Gluecron verified on 2026-09-29 as the fallback), the token-request
 * body, and the mapping from a userinfo answer to the customer session.
 *
 * Facts from Gluecron (verified by them, 2026-09-29):
 *   metadata   GET  /.well-known/oauth-authorization-server
 *   authorize  GET  /oauth/authorize
 *   token      POST /oauth/token   (authorization_code + refresh_token)
 *   revoke     POST /oauth/revoke
 *   userinfo   GET  /oauth/userinfo with a Bearer access token →
 *              { sub, preferred_username, login, name, picture, profile,
 *                email, email_verified }
 *   PKCE S256 is required ("plain" is refused); scope for sign-in is
 *   `read:user` only; client auth is client_secret_post or none (public
 *   client + PKCE). The userinfo endpoint is not live yet on their side; it
 *   will be advertised as `userinfo_endpoint` in the metadata when it is,
 *   and until then the callback fails closed (see profileFromUserinfo).
 *
 * Plain CJS, like session-gate.js and sign-in-providers.js, so `node --test`
 * can require() it and drive discovery with a fake fetch — no live call to
 * gluecron.com in any test.
 */

const crypto = require('node:crypto');

const DEFAULT_GLUECRON_BASE_URL = 'https://gluecron.com';

/** Both upstream calls (token, userinfo) and the metadata read share it. */
const GLUECRON_OAUTH_TIMEOUT_MS = 5000;

/** The one scope sign-in asks for. Nothing more, ever. */
const GLUECRON_OAUTH_SCOPE = 'read:user';

const METADATA_PATH = '/.well-known/oauth-authorization-server';

/** Endpoint keys we read from the metadata document, in RFC 8414 spelling. */
const ENDPOINT_KEYS = ['authorization_endpoint', 'token_endpoint', 'revocation_endpoint', 'userinfo_endpoint'];

/**
 * Where Gluecron's OAuth server lives. `GLUECRON_OAUTH_BASE_URL` wins so the
 * OAuth server can be pointed somewhere else without moving the git-host
 * API; otherwise the existing `GLUECRON_BASE_URL` (gluecron-client.ts) is
 * honoured so one deployment variable moves both; otherwise the default.
 * Trailing slashes are dropped; anything that is not an http(s) URL is
 * treated as unset.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function gluecronOAuthBaseUrl(env = process.env) {
  const raw = (env.GLUECRON_OAUTH_BASE_URL || env.GLUECRON_BASE_URL || DEFAULT_GLUECRON_BASE_URL).trim();
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return DEFAULT_GLUECRON_BASE_URL;
    return raw.replace(/\/+$/, '');
  } catch {
    return DEFAULT_GLUECRON_BASE_URL;
  }
}

/**
 * The URLs Gluecron verified on 2026-09-29. Discovery starts from these and
 * only ever replaces a key with a same-origin URL from the metadata.
 *
 * @param {string} baseUrl
 * @returns {{ issuer: string, authorization_endpoint: string, token_endpoint: string, revocation_endpoint: string, userinfo_endpoint: string, discovered: boolean }}
 */
function fixedEndpoints(baseUrl) {
  const base = baseUrl.replace(/\/+$/, '');
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    revocation_endpoint: `${base}/oauth/revoke`,
    userinfo_endpoint: `${base}/oauth/userinfo`,
    discovered: false,
  };
}

// ── PKCE (RFC 7636) ──────────────────────────────────────────────────────────

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * S256 challenge for a verifier: base64url(sha256(verifier)).
 * @param {string} verifier
 * @returns {string}
 */
function pkceChallenge(verifier) {
  return b64url(crypto.createHash('sha256').update(verifier, 'ascii').digest());
}

/**
 * A fresh verifier (32 random bytes → 43 base64url characters, inside the
 * 43–128 the RFC allows) and its S256 challenge. Gluecron refuses "plain".
 * @returns {{ verifier: string, challenge: string, method: 'S256' }}
 */
function pkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: pkceChallenge(verifier), method: 'S256' };
}

/** @param {unknown} v */
function isValidVerifier(v) {
  return typeof v === 'string' && v.length >= 43 && v.length <= 128 && /^[A-Za-z0-9\-._~]+$/.test(v);
}

// ── Discovery ────────────────────────────────────────────────────────────────

/** @type {Map<string, Promise<ReturnType<typeof fixedEndpoints>>>} */
const discoveryCache = new Map();

/**
 * fetch with a hard deadline. Rejects (AbortError) when the deadline passes;
 * the caller treats every rejection the same way.
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} timeoutMs
 */
function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetchImpl(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

/**
 * Merge a metadata document over the fixed endpoints. Only a same-origin
 * absolute URL replaces a fixed one; a foreign host, a relative path or a
 * non-string is ignored, so a tampered or half-written document can never
 * send the browser (or our access token) somewhere else.
 *
 * @param {string} baseUrl
 * @param {unknown} metadata
 */
function endpointsFromMetadata(baseUrl, metadata) {
  const out = fixedEndpoints(baseUrl);
  if (!metadata || typeof metadata !== 'object') return out;
  const origin = new URL(baseUrl).origin;
  const doc = /** @type {Record<string, unknown>} */ (metadata);
  for (const key of ENDPOINT_KEYS) {
    const v = doc[key];
    if (typeof v !== 'string') continue;
    try {
      const u = new URL(v);
      if (u.origin === origin) out[key] = v;
    } catch {
      /* error-ok — not a URL; keep the fixed one */
    }
  }
  if (typeof doc.issuer === 'string') {
    try { if (new URL(doc.issuer).origin === origin) out.issuer = doc.issuer; } catch { /* error-ok — keep the fixed issuer */ }
  }
  out.discovered = true;
  return out;
}

/**
 * The authorization server's endpoints: the metadata document, read once
 * per process per base URL with a 5 s deadline, over the fixed URLs. If the
 * document is unreachable, not JSON, or not 2xx, the fixed URLs are used —
 * an endpoint rename on Gluecron's side is picked up without a deploy here,
 * and an outage of the metadata document alone does not take sign-in down.
 *
 * @param {string} baseUrl
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<ReturnType<typeof fixedEndpoints>>}
 */
function discoverEndpoints(baseUrl, opts = {}) {
  const base = baseUrl.replace(/\/+$/, '');
  const cached = discoveryCache.get(base);
  if (cached) return cached;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? GLUECRON_OAUTH_TIMEOUT_MS;
  const p = (async () => {
    try {
      const res = await fetchWithTimeout(fetchImpl, `${base}${METADATA_PATH}`, { headers: { accept: 'application/json' } }, timeoutMs);
      if (!res || !res.ok) return fixedEndpoints(base);
      return endpointsFromMetadata(base, await res.json());
    } catch {
      /* error-ok — unreachable, timed out, or not JSON: the fixed URLs still work */
      return fixedEndpoints(base);
    }
  })();
  discoveryCache.set(base, p);
  return p;
}

/** Tests only: forget what was discovered. */
function resetDiscoveryCache() {
  discoveryCache.clear();
}

// ── Request shapes ───────────────────────────────────────────────────────────

/**
 * The authorize redirect. response_type=code, the one scope, S256.
 * @param {{ authorization_endpoint: string }} endpoints
 * @param {{ clientId: string, redirectUri: string, state: string, challenge: string }} p
 */
function authorizeUrl(endpoints, { clientId, redirectUri, state, challenge }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GLUECRON_OAUTH_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${endpoints.authorization_endpoint}?${params.toString()}`;
}

/**
 * The token-exchange body. With a client secret this is client_secret_post
 * plus PKCE; without one it is a public client with PKCE only — both shapes
 * Gluecron accepts. Never logged: it carries the secret and the code.
 * @param {{ clientId: string, clientSecret?: string, code: string, redirectUri: string, verifier: string }} p
 * @returns {URLSearchParams}
 */
function tokenRequestBody({ clientId, clientSecret, code, redirectUri, verifier }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  if (clientSecret) body.set('client_secret', clientSecret);
  return body;
}

/**
 * What the session needs from a userinfo answer, or why it cannot be used.
 *
 * `ok: false, reason: 'user_failed'` covers every shape of "no profile":
 * a non-2xx status (404 while Gluecron's userinfo endpoint is not deployed
 * yet — their PR #5839 — fails closed here rather than signing in an
 * unknown person), a body that is not an object, or no usable login.
 * `email_unverified` is a profile with an email Gluecron has not confirmed:
 * the customer row is keyed by email, so an unconfirmed one is refused.
 *
 * @param {number} status HTTP status of the userinfo response
 * @param {unknown} body parsed JSON body (or anything, if parsing failed)
 * @returns {{ ok: true, login: string, email: string } | { ok: false, reason: 'user_failed' | 'email_unverified' }}
 */
function profileFromUserinfo(status, body) {
  if (status < 200 || status >= 300) return { ok: false, reason: 'user_failed' };
  if (!body || typeof body !== 'object') return { ok: false, reason: 'user_failed' };
  const u = /** @type {Record<string, unknown>} */ (body);
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const login = str(u.login) || str(u.preferred_username) || str(u.name) || str(u.sub);
  const email = str(u.email);
  if (!login) return { ok: false, reason: 'user_failed' };
  if (!email || u.email_verified !== true) return { ok: false, reason: 'email_unverified' };
  return { ok: true, login, email };
}

module.exports = {
  DEFAULT_GLUECRON_BASE_URL,
  GLUECRON_OAUTH_TIMEOUT_MS,
  GLUECRON_OAUTH_SCOPE,
  METADATA_PATH,
  ENDPOINT_KEYS,
  gluecronOAuthBaseUrl,
  fixedEndpoints,
  pkceChallenge,
  pkcePair,
  isValidVerifier,
  endpointsFromMetadata,
  discoverEndpoints,
  resetDiscoveryCache,
  fetchWithTimeout,
  authorizeUrl,
  tokenRequestBody,
  profileFromUserinfo,
};
