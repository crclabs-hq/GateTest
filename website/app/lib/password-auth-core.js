'use strict';
/**
 * Email + password sign-in — the ONE definition of the rules (Doctrine #4).
 *
 * Owner directive (2026-09-29): customers must be able to sign in with an
 * email address and a password alongside GitHub / Google. Everything that
 * decides an outcome lives here, with the database behind a small `store`
 * interface (password-auth-store.js implements it on Neon; the tests
 * implement it in memory) and mail behind a `send(msg)` function (the site's
 * one transport, mail-transport.js). The Next.js routes under
 * app/api/auth/password/* are thin: parse, call, respond.
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
 * use. A verify token carries the pending password hash as its payload: the
 * password is NOT active until the mailbox owner clicks the link, which is
 * what "attach a password to an existing OAuth customer only after email
 * verification" means in practice.
 *
 * ── Throttle ────────────────────────────────────────────────────────────────
 * 10 failed sign-ins per (email, IP) per 15 minutes → 429. The counter is a
 * database table (auth_login_failures), never an in-process Map: the site
 * runs multi-process and a per-process counter is 10 × N attempts.
 *
 * ── Enumeration ─────────────────────────────────────────────────────────────
 * register and forgot answer the same way whether or not the address is
 * known. login answers "email or password is wrong" for an unknown email, a
 * missing password and a wrong password alike, and hashes a dummy value on
 * the unknown-email path so the timing matches.
 *
 * ── CSRF ────────────────────────────────────────────────────────────────────
 * Every POST is same-origin checked: `Sec-Fetch-Site: same-origin`, or an
 * `Origin` equal to the canonical site origin / the request's own host.
 * No header at all is a refusal — every browser sends one of them on a
 * form post or a fetch.
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

// A fixed hash to burn the same scrypt cost when the email is unknown, so an
// attacker cannot tell "no such account" from "wrong password" by the clock.
// Pre-computed for the string "not-a-real-password-timing-equaliser".
const DUMMY_HASH_PROMISE = hashPassword('not-a-real-password-timing-equaliser');

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

// ─── flows ───────────────────────────────────────────────────────────────────
//
// Every flow takes `{ store, mail, origin, now }`:
//   store  — the interface below (password-auth-store.js / in-memory in tests)
//   mail   — async (msg) => { ok: boolean }   — mail-transport.deliver
//   origin — canonical site origin for links (site-url.js siteUrl())
//   now    — ms clock, injectable
//
// Store interface:
//   findCustomerByEmail(email) → { id, email, github_login, password_hash, email_verified_at } | null
//   ensureCustomer(email)      → same row (inserts when missing)
//   setPassword(customerId, hash, { verifiedAt, now })
//   insertToken({ id, customerId, kind, tokenHash, payload, expiresAt, now })
//   findToken(kind, tokenHash) → { id, customer_id, kind, payload, expires_at, used_at, email } | null
//   consumeToken(id, now)
//   invalidateTokens(customerId, kind, now)
//   countFailures(key, sinceMs) → number
//   recordFailure(key, now)
//   clearFailures(key)

function result(ok, status, code, extra) {
  return Object.assign({ ok, status, code }, extra || {});
}

function verifyLink(origin, token, next) {
  const q = new URLSearchParams({ token });
  if (next) q.set('next', next);
  return `${origin}/api/auth/password/verify?${q.toString()}`;
}

/**
 * Issue a verify token for a customer and mail the link. Every outstanding
 * verify token for that customer is invalidated first (the rule reset already
 * has), so only the NEWEST mail can ever activate a password: an earlier
 * registration by someone else against the same address cannot be completed
 * by a click on a later link, and the other way round.
 */
async function issueVerify({ store, mail, origin, customer, pendingHash, next, now }) {
  await store.invalidateTokens(customer.id, 'verify', now);
  const { token, tokenHash } = newToken();
  await store.insertToken({
    id: crypto.randomUUID(), customerId: customer.id, kind: 'verify', tokenHash,
    payload: pendingHash, expiresAt: now + TOKEN_TTL_MS, now,
  });
  return mail(verifyEmail({ to: customer.email, link: verifyLink(origin, token, next) }));
}
function resetLink(origin, token) {
  return `${origin}/login/password/reset?token=${encodeURIComponent(token)}`;
}

/** POST /api/auth/password/register — `next` (already safeNext-checked by the
 *  route) rides along in the verify link so the sign-in page after the click
 *  can carry it on. */
async function register({ store, mail, origin, email, password, next = /** @type {string|null} */ (null), now = Date.now() }) {
  const e = normaliseEmail(email);
  if (!isValidEmail(e)) return result(false, 400, 'email_invalid');
  const v = validatePassword(password, e);
  if (!v.ok) return result(false, 400, v.code);

  const hash = await hashPassword(password);
  const customer = await store.ensureCustomer(e);

  // Already has a working password: never overwrite it from an anonymous
  // request. Tell the mailbox owner instead — and answer exactly as below.
  if (customer.password_hash && customer.email_verified_at) {
    const sent = await mail(accountExistsEmail({ to: e, forgotLink: `${origin}/login/password/forgot` }));
    if (!sent || !sent.ok) return result(false, 503, 'mail_unavailable');
    return result(true, 200, 'verify_sent');
  }

  const sent = await issueVerify({ store, mail, origin, customer, pendingHash: hash, next, now });
  if (!sent || !sent.ok) return result(false, 503, 'mail_unavailable');
  return result(true, 200, 'verify_sent');
}

/**
 * GET /api/auth/password/verify?token= — activates the pending password and
 * marks the address verified. It does NOT sign the caller in: the click
 * proves the mailbox, the password proves the person, and the sign-in page
 * asks for the second one. (A click on a link somebody else requested can
 * therefore never hand out a session.)
 */
async function verify({ store, token, now = Date.now() }) {
  if (!isTokenShape(token)) return result(false, 400, 'token_invalid');
  const row = await store.findToken('verify', hashToken(token));
  if (!row || row.used_at || toMs(row.expires_at) <= now || !parseStoredHash(row.payload)) {
    return result(false, 400, 'token_invalid');
  }
  await store.consumeToken(row.id, now);
  await store.setPassword(row.customer_id, row.payload, { verifiedAt: now, now });
  return result(true, 200, 'verified', { email: row.email });
}

/** POST /api/auth/password/login */
async function login({ store, mail, origin, email, password, ip, now = Date.now() }) {
  const e = normaliseEmail(email);
  const key = throttleKey(e, ip);
  const failures = await store.countFailures(key, now - THROTTLE_WINDOW_MS);
  if (failures >= THROTTLE_MAX_FAILURES) return result(false, 429, 'throttled');

  if (!isValidEmail(e) || typeof password !== 'string' || !password) {
    await store.recordFailure(key, now);
    return result(false, 401, 'bad_credentials');
  }

  const customer = await store.findCustomerByEmail(e);
  if (!customer || !customer.password_hash) {
    await verifyPassword(password, await DUMMY_HASH_PROMISE); // same cost as a real check
    await store.recordFailure(key, now);
    return result(false, 401, 'bad_credentials');
  }
  const good = await verifyPassword(password, customer.password_hash);
  if (!good) {
    await store.recordFailure(key, now);
    return result(false, 401, 'bad_credentials');
  }
  if (!customer.email_verified_at) {
    // The password is right, so the caller owns it: it is safe to say why
    // they cannot get in, and to send the link again.
    if (typeof mail === 'function' && origin) {
      await issueVerify({ store, mail, origin, customer, pendingHash: customer.password_hash, next: null, now });
    }
    return result(false, 403, 'unverified');
  }
  await store.clearFailures(key);
  return result(true, 200, 'signed_in', { customer: { id: customer.id, email: customer.email, github_login: customer.github_login || null } });
}

/** POST /api/auth/password/forgot — always 200 for a well-formed address. */
async function forgot({ store, mail, origin, email, now = Date.now() }) {
  const e = normaliseEmail(email);
  if (!isValidEmail(e)) return result(false, 400, 'email_invalid');
  const customer = await store.findCustomerByEmail(e);
  if (customer) {
    const { token, tokenHash } = newToken();
    await store.insertToken({
      id: crypto.randomUUID(), customerId: customer.id, kind: 'reset', tokenHash,
      payload: null, expiresAt: now + TOKEN_TTL_MS, now,
    });
    // A delivery failure here is logged by the route, never surfaced: a 503
    // only for known addresses would be an oracle.
    const sent = await mail(resetEmail({ to: e, link: resetLink(origin, token) }));
    return result(true, 200, 'reset_sent', { delivered: Boolean(sent && sent.ok) });
  }
  return result(true, 200, 'reset_sent', { delivered: null });
}

/** POST /api/auth/password/reset */
async function reset({ store, token, password, now = Date.now() }) {
  if (!isTokenShape(token)) return result(false, 400, 'token_invalid');
  const row = await store.findToken('reset', hashToken(token));
  if (!row || row.used_at || toMs(row.expires_at) <= now) return result(false, 400, 'token_invalid');
  const v = validatePassword(password, row.email);
  if (!v.ok) return result(false, 400, v.code);
  const hash = await hashPassword(password);
  await store.consumeToken(row.id, now);
  await store.invalidateTokens(row.customer_id, 'reset', now);
  // A reset link proves the mailbox, so this also verifies the address.
  await store.setPassword(row.customer_id, hash, { verifiedAt: now, now });
  return result(true, 200, 'reset_ok');
}

/** POST /api/auth/password/change — signed-in customer. */
async function change({ store, email, currentPassword, newPassword, now = Date.now() }) {
  const e = normaliseEmail(email);
  const customer = e ? await store.findCustomerByEmail(e) : null;
  if (!customer) return result(false, 401, 'not_signed_in');
  if (!customer.password_hash || !customer.email_verified_at) return result(false, 400, 'no_password');
  const good = await verifyPassword(currentPassword, customer.password_hash);
  if (!good) return result(false, 400, 'current_wrong');
  const v = validatePassword(newPassword, e);
  if (!v.ok) return result(false, 400, v.code);
  const hash = await hashPassword(newPassword);
  await store.setPassword(customer.id, hash, { verifiedAt: toMs(customer.email_verified_at), now });
  await store.invalidateTokens(customer.id, 'reset', now);
  return result(true, 200, 'changed');
}

function toMs(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** The login name a password session carries: the GitHub login when the
 *  customer has one, else the address's local part (what Google sign-in does). */
function sessionLogin(customer) {
  if (customer && customer.github_login) return customer.github_login;
  return String(customer && customer.email || '').split('@')[0] || 'customer';
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
  register, verify, login, forgot, reset, change,
  sessionLogin, toMs,
};
