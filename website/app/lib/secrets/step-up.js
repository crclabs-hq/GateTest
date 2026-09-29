'use strict';
/**
 * Step-up ("fresh") admin proof for the secrets panel.
 *
 * set / delete / reveal / apply need more than an admin session: they need a
 * `gt_admin_fresh` cookie that ONLY POST /api/admin/step-up mints, and only
 * after the admin password is typed again. A machine-held credential cannot
 * produce one:
 *
 *   - isAdminRequest() also accepts an `X-Admin-Token` header (server-to-server
 *     calls). That token is HMAC(password, "gatetest-admin-v1") — the same
 *     bytes as the admin cookie. The fresh cookie is signed with a DIFFERENT
 *     derivation, HMAC(password, "gatetest-admin-step-up-v1"), so holding the
 *     admin token (or the admin cookie) does not let anyone mint a fresh
 *     cookie. Only the password does.
 *   - Changing GATETEST_ADMIN_PASSWORD invalidates every fresh cookie at once.
 *
 * Cookie: `<expiresAtSeconds>.<hex hmac>`, HttpOnly, SameSite=Strict,
 * Path=/api/admin, Max-Age 15 min, Secure in production.
 *
 * Attempts are throttled in Postgres (5 per 15 min per client IP, hashed) via
 * the store adapter — never in memory.
 */

const crypto = require('node:crypto');

const FRESH_COOKIE_NAME = 'gt_admin_fresh';
const FRESH_TTL_SECONDS = 15 * 60;
const STEP_UP_WINDOW_MS = 15 * 60 * 1000;
const STEP_UP_MAX_ATTEMPTS = 5;
const DERIVATION = 'gatetest-admin-step-up-v1';

/** Signing key for fresh cookies, or null when admin auth is not configured. */
function freshKey(env = process.env) {
  const password = env.GATETEST_ADMIN_PASSWORD || '';
  if (!password) return null;
  return crypto.createHmac('sha256', password).update(DERIVATION).digest();
}

function sign(key, exp) {
  return crypto.createHmac('sha256', key).update(`${DERIVATION}:${exp}`).digest('hex');
}

/** @returns {{ token:string, freshUntil:string }} */
function mintFreshToken(key, nowMs = Date.now()) {
  if (!key) throw new Error('admin auth is not configured');
  const exp = Math.floor(nowMs / 1000) + FRESH_TTL_SECONDS;
  return { token: `${exp}.${sign(key, exp)}`, freshUntil: new Date(exp * 1000).toISOString() };
}

/** @returns {{ok:true, freshUntil:string} | {ok:false, reason:'not_configured'|'missing'|'malformed'|'expired'|'bad_signature'}} */
function verifyFreshToken(token, key, nowMs = Date.now()) {
  if (!key) return { ok: false, reason: 'not_configured' };
  if (!token) return { ok: false, reason: 'missing' };
  const m = /^(\d{9,12})\.([0-9a-f]{64})$/.exec(String(token));
  if (!m) return { ok: false, reason: 'malformed' };
  const exp = Number(m[1]);
  const expected = Buffer.from(sign(key, exp), 'hex');
  const given = Buffer.from(m[2], 'hex');
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'bad_signature' };
  }
  if (exp * 1000 <= nowMs) return { ok: false, reason: 'expired' };
  if (exp * 1000 > nowMs + (FRESH_TTL_SECONDS + 60) * 1000) return { ok: false, reason: 'malformed' };
  return { ok: true, freshUntil: new Date(exp * 1000).toISOString() };
}

function buildFreshCookieHeader(token, production) {
  const parts = [
    `${FRESH_COOKIE_NAME}=${token}`,
    `Max-Age=${FRESH_TTL_SECONDS}`,
    'Path=/api/admin',
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (production) parts.push('Secure');
  return parts.join('; ');
}

/** One throttle key per client IP, hashed so the table holds no address. */
function throttleKey(ip) {
  return crypto.createHash('sha256').update(`gatetest-step-up|${ip || 'unknown'}`).digest('hex');
}

module.exports = {
  FRESH_COOKIE_NAME, FRESH_TTL_SECONDS, STEP_UP_WINDOW_MS, STEP_UP_MAX_ATTEMPTS,
  freshKey, mintFreshToken, verifyFreshToken, buildFreshCookieHeader, throttleKey,
};
