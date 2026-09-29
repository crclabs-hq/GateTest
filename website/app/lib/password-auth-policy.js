'use strict';
/**
 * Email + password sign-in — the rules with no database behind them
 * (Doctrine #4: one definition, imported). password-auth-core.js holds the
 * six flows over the store and re-exports everything here, so callers and
 * tests keep one import.
 *
 * ── Passwords ───────────────────────────────────────────────────────────────
 * bcrypt / argon2 are native addons and are forbidden in this repo (see
 * src/modules/native-bundler-guard.js — Next bundles server code). Hashing is
 * node:crypto scrypt: per-user 16-byte salt, N = 2^15, r = 8, p = 1, 64-byte
 * key, compared with timingSafeEqual. Stored as
 *
 *     scrypt$N$r$p$<salt b64url>$<hash b64url>
 *
 * so the parameters can be raised later and old rows still verify.
 *
 * ── Tokens ──────────────────────────────────────────────────────────────────
 * Verify and reset links carry 32 random bytes (base64url). Only sha256(token)
 * is stored, so a database read never yields a usable link. One hour, single
 * use.
 *
 * ── CSRF ────────────────────────────────────────────────────────────────────
 * Every POST is same-origin checked: `Sec-Fetch-Site: same-origin`, or an
 * `Origin` equal to the canonical site origin / the request's own host.
 * No header at all is a refusal — every browser sends one of them on a
 * form post or a fetch.
 *
 * Also here: the password policy and its small deny-list, the throttle key,
 * the query-code copy maps the pages render, and the (colour-free,
 * vendor-neutral) mail bodies.
 */

const crypto = require('node:crypto');

// ─── constants ───────────────────────────────────────────────────────────────

const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;
// Node refuses scrypt when 128 * N * r exceeds maxmem; the default (32 MiB)
// is exactly 128 * 2^15 * 8, so give it headroom rather than sit on the edge.
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2;

const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 256;

const TOKEN_BYTES = 32;
const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 h

const THROTTLE_MAX_FAILURES = 10;
const THROTTLE_WINDOW_MS = 15 * 60 * 1000;

const TOKEN_KINDS = Object.freeze(['verify', 'reset']);

// ─── password policy ─────────────────────────────────────────────────────────

/**
 * The small deny-list. Almost every entry on the published "most used"
 * lists is shorter than 12 characters and is already refused by length; these
 * are the ones that survive it, plus the bases people pad to reach 12
 * ("password" + "1234", "qwerty" + "uiop12"). Compared after lower-casing
 * and stripping everything but letters, so `P@ssword2024!` is `password`.
 */
const COMMON_PASSWORDS = new Set([
  'password1234', 'password12345', 'password123456', 'passwordpassword', 'passw0rd1234',
  '123456789012', '1234567890123', '12345678901234', '111111111111', '000000000000',
  'qwertyuiop12', 'qwertyuiopasdfgh', 'qwertyuiopasdfghjkl', 'qwerty123456', 'asdfghjkl123',
  'iloveyou1234', 'letmein12345', 'welcome12345', 'changeme1234', 'administrator',
  'adminadmin123', 'admin1234567', 'football1234', 'baseball1234', 'sunshine1234',
  'princess1234', 'trustno1trustno1', 'superman1234', 'abcdefghijkl', 'abc123abc123',
  'monkey123456', 'dragon123456', 'shadow123456', 'master123456', 'michael12345',
  'gatetest1234', 'gatetestgatetest', 'correcthorsebatterystaple',
]);
const COMMON_BASES = new Set([
  'password', 'passw', 'passwd', 'qwerty', 'qwertyuiop', 'qwertyuiopasdfgh', 'letmein', 'welcome',
  'iloveyou', 'admin', 'administrator', 'changeme', 'gatetest', 'abc', 'abcdef', 'abcdefghijkl',
  'monkey', 'dragon', 'football', 'baseball', 'sunshine', 'princess', 'trustno', 'master',
  'shadow', 'superman', 'michael', 'asdfghjkl', 'zxcvbnm', 'login', 'secret', 'default',
]);

function lettersOnly(s) {
  return String(s).toLowerCase().replace(/[^a-z]/g, '');
}

/** True when the password is on the deny-list or is trivially structured. */
function isCommonPassword(password, email) {
  if (typeof password !== 'string') return true;
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return true;
  const letters = lettersOnly(password);
  if (COMMON_BASES.has(letters)) return true;
  if (/^(.)\1+$/.test(password)) return true;          // one repeated character
  if (/^\d+$/.test(password)) return true;             // digits only
  if (/^(0123456789|1234567890|abcdefghijkl)/.test(lower)) return true; // keyboard-walk prefix
  if (typeof email === 'string') {
    const local = email.split('@')[0].toLowerCase();
    if (local.length >= 4 && lower.includes(local)) return true; // the address itself
  }
  return false;
}

/**
 * @returns {{ ok: true } | { ok: false, code: string }}
 * Codes: password_short | password_long | password_common
 */
function validatePassword(password, email) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, code: 'password_short' };
  }
  if (password.length > PASSWORD_MAX_LENGTH) return { ok: false, code: 'password_long' };
  if (isCommonPassword(password, email)) return { ok: false, code: 'password_common' };
  return { ok: true };
}

// ─── e-mail ──────────────────────────────────────────────────────────────────

function normaliseEmail(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase();
}

function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  if (email.length < 6 || email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ─── hashing ─────────────────────────────────────────────────────────────────

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function fromB64url(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function scryptAsync(password, salt, keylen, opts) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/**
 * Hash a password. `salt` may be injected by tests; production callers never
 * pass it.
 * @returns {Promise<string>} `scrypt$N$r$p$salt$hash`
 */
async function hashPassword(password, salt) {
  if (typeof password !== 'string' || !password) throw new Error('password required');
  const s = salt || crypto.randomBytes(SALT_BYTES);
  const key = await scryptAsync(Buffer.from(password, 'utf8'), s, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${b64url(s)}$${b64url(key)}`;
}

/** Parse a stored hash; null when it is not one of ours. */
function parseStoredHash(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const N = Number(parts[1]); const r = Number(parts[2]); const p = Number(parts[3]);
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return null;
  if ((N & (N - 1)) !== 0) return null; // scrypt needs a power of two
  const salt = fromB64url(parts[4]); const hash = fromB64url(parts[5]);
  if (salt.length < 8 || hash.length < 16) return null;
  return { N, r, p, salt, hash };
}

/**
 * Constant-time verify. Any malformed stored value is simply "no match" —
 * never an exception a caller could turn into a different response.
 */
async function verifyPassword(password, stored) {
  const parsed = parseStoredHash(stored);
  if (!parsed || typeof password !== 'string') return false;
  let key;
  try {
    key = await scryptAsync(Buffer.from(password, 'utf8'), parsed.salt, parsed.hash.length, {
      N: parsed.N, r: parsed.r, p: parsed.p, maxmem: 128 * parsed.N * parsed.r * 2,
    });
  } catch {
    return false;
  }
  if (key.length !== parsed.hash.length) return false;
  return crypto.timingSafeEqual(key, parsed.hash);
}

// ─── tokens ──────────────────────────────────────────────────────────────────

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** @returns {{ token: string, tokenHash: string }} */
function newToken() {
  const token = b64url(crypto.randomBytes(TOKEN_BYTES));
  return { token, tokenHash: hashToken(token) };
}

function isTokenShape(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{40,48}$/.test(token);
}

// ─── throttle ────────────────────────────────────────────────────────────────

/** One key per (email, IP); hashed so the table never holds addresses. */
function throttleKey(email, ip) {
  return crypto.createHash('sha256').update(`${normaliseEmail(email)}|${ip || 'unknown'}`).digest('hex');
}

// ─── CSRF: same-origin check ─────────────────────────────────────────────────

function lowerOrigin(v) {
  try { return new URL(String(v)).origin.toLowerCase(); } catch { return null; }
}

/**
 * @param {{ origin?: string|null, secFetchSite?: string|null, host?: string|null,
 *           forwardedHost?: string|null, forwardedProto?: string|null }} h — request headers
 * @param {string} canonicalOrigin — siteUrl()
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function checkSameOrigin(h, canonicalOrigin) {
  const site = (h && h.secFetchSite ? String(h.secFetchSite) : '').trim().toLowerCase();
  if (site) {
    return site === 'same-origin' ? { ok: true } : { ok: false, reason: `sec-fetch-site ${site}` };
  }
  const origin = h && h.origin ? lowerOrigin(h.origin) : null;
  if (!origin) return { ok: false, reason: 'no origin' };
  const allowed = new Set();
  const canon = lowerOrigin(canonicalOrigin);
  if (canon) allowed.add(canon);
  const host = (h.forwardedHost || h.host || '').split(',')[0].trim().toLowerCase();
  if (host) {
    const proto = (h.forwardedProto || 'https').split(',')[0].trim().toLowerCase() || 'https';
    allowed.add(`${proto}://${host}`);
  }
  return allowed.has(origin) ? { ok: true } : { ok: false, reason: 'origin mismatch' };
}

// ─── copy ────────────────────────────────────────────────────────────────────

/** Query-code → sentence, the way /login's ERROR_COPY works (#819). */
const ERROR_COPY = Object.freeze({
  bad_credentials: 'Email or password is wrong.',
  throttled: 'Too many sign-in attempts. Wait 15 minutes and try again, or reset your password.',
  unverified: 'Your email address is not verified yet. We have sent the verification link again — check your inbox.',
  email_invalid: 'Enter a valid email address.',
  password_short: `Use at least ${PASSWORD_MIN_LENGTH} characters.`,
  password_long: `Use at most ${PASSWORD_MAX_LENGTH} characters.`,
  password_common: 'That password is too easy to guess. Pick something longer and less common.',
  password_mismatch: 'The two passwords do not match.',
  token_invalid: 'This link is invalid, has been used, or has expired. Request a new one.',
  current_wrong: 'Your current password is wrong.',
  no_password: 'This account signs in with GitHub or Google and has no password yet. Use "Forgot password" to set one.',
  csrf: 'The request did not come from this site. Reload the page and try again.',
  mail_unavailable: 'Email delivery is not available on this deployment right now. Try again later or sign in with GitHub or Google.',
  db_unavailable: 'The account store is not reachable right now. Try again in a minute.',
  not_signed_in: 'Sign in first.',
  unavailable: 'Password sign-in is not available on this deployment.',
  bad_request: 'Something in the form was missing. Try again.',
});

const NOTICE_COPY = Object.freeze({
  verify_sent: 'If that address is new here, a verification link is on its way. Click it to finish creating your account.',
  reset_sent: 'If an account exists for that address, a password reset link is on its way.',
  reset_ok: 'Your password has been changed. Sign in with it now.',
  changed: 'Your password has been changed.',
  verified: 'Your email address is confirmed and your password is active. Sign in with it now.',
});

// ─── e-mail bodies (vendor-neutral, no platform names) ───────────────────────

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Colour-free HTML on purpose. Mail clients ignore CSS custom properties, so
 * the only way to colour a mail is to inline hex — which the v2 token guard
 * (tests/no-hardcoded-color-literals.test.js) forbids in any new file. A mail
 * that inherits the client's own text, link and background colours reads
 * correctly in light and dark mode and needs no palette of its own; the
 * layout (spacing, border, weight) is all that is set here. `border: 1px
 * solid` with no colour uses currentColor, which is valid CSS.
 */
function mailShell(title, lines, link, linkLabel) {
  const text = `${title}\n\n${lines.join('\n')}\n\n${link}\n\nThis link is valid for one hour and can be used once. If you did not ask for it, ignore this message.\n\n— GateTest`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;font:15px/1.6 ui-sans-serif,system-ui,sans-serif">
<div style="max-width:32rem;margin:0 auto;border:1px solid;border-radius:12px;padding:28px">
<h1 style="font-size:18px;margin:0 0 12px">${escapeHtml(title)}</h1>
${lines.map((l) => `<p style="margin:0 0 12px">${escapeHtml(l)}</p>`).join('\n')}
<p style="margin:20px 0"><a href="${escapeHtml(link)}" style="display:inline-block;padding:11px 20px;border:2px solid;border-radius:8px;font-weight:600">${escapeHtml(linkLabel)}</a></p>
<p style="font-size:13px;margin:0 0 8px">Or paste this address into your browser:<br><span style="word-break:break-all">${escapeHtml(link)}</span></p>
<p style="font-size:13px;margin:0">This link is valid for one hour and can be used once. If you did not ask for it, ignore this message.</p>
</div></body></html>`;
  return { text, html };
}

function verifyEmail({ to, link }) {
  const body = mailShell('Confirm your email address', [
    'Someone — hopefully you — asked to sign in to GateTest with this email address and a password.',
    'Click the button to confirm the address and activate the password.',
  ], link, 'Confirm email address');
  return { to, subject: 'Confirm your GateTest email address', ...body };
}

function resetEmail({ to, link }) {
  const body = mailShell('Reset your password', [
    'Someone — hopefully you — asked to reset the GateTest password for this email address.',
    'Click the button to choose a new password. Nothing changes until you do.',
  ], link, 'Choose a new password');
  return { to, subject: 'Reset your GateTest password', ...body };
}

function accountExistsEmail({ to, forgotLink }) {
  const body = mailShell('You already have a GateTest account', [
    'Someone — hopefully you — tried to create a GateTest account with this email address, but one already exists with a password.',
    'If you have forgotten the password, reset it here. If this was not you, nothing has changed and you can ignore this message.',
  ], forgotLink, 'Reset my password');
  return { to, subject: 'Your GateTest account already exists', ...body };
}

function toMs(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

module.exports = {
  SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_KEYLEN, SALT_BYTES,
  PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH,
  TOKEN_BYTES, TOKEN_TTL_MS, TOKEN_KINDS,
  THROTTLE_MAX_FAILURES, THROTTLE_WINDOW_MS,
  ERROR_COPY, NOTICE_COPY,
  isCommonPassword, validatePassword, normaliseEmail, isValidEmail,
  hashPassword, verifyPassword, parseStoredHash,
  newToken, hashToken, isTokenShape,
  throttleKey, checkSameOrigin,
  verifyEmail, resetEmail, accountExistsEmail,
  toMs,
};
