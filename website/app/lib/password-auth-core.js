'use strict';
/**
 * Email + password sign-in — the ONE definition of the flows (Doctrine #4).
 *
 * Owner directive (2026-09-29): customers must be able to sign in with an
 * email address and a password alongside GitHub / Google. Everything that
 * decides an outcome lives here, with the database behind a small `store`
 * interface (password-auth-store.js implements it on Neon; the tests
 * implement it in memory) and mail behind a `send(msg)` function (the site's
 * one transport, mail-transport.js). The Next.js routes under
 * app/api/auth/password/* are thin: parse, call, respond.
 *
 * The rules with no database behind them — scrypt hashing, the password
 * policy, token helpers, the throttle key, the same-origin check, the copy
 * maps and the mail bodies — live in password-auth-policy.js and are
 * re-exported from here so there is one import for callers and tests.
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
 * ── Activation ──────────────────────────────────────────────────────────────
 * A verify token carries the pending password hash as its payload: the
 * password is NOT active until the mailbox owner clicks the link, which is
 * what "attach a password to an existing OAuth customer only after email
 * verification" means in practice. Issuing a verify token retires every
 * outstanding one, and the click sets no session.
 */

const crypto = require('node:crypto');
const policy = require('./password-auth-policy');

const {
  TOKEN_TTL_MS, THROTTLE_MAX_FAILURES, THROTTLE_WINDOW_MS,
  validatePassword, normaliseEmail, isValidEmail,
  hashPassword, verifyPassword, parseStoredHash,
  newToken, hashToken, isTokenShape, throttleKey,
  verifyEmail, resetEmail, accountExistsEmail, toMs,
} = policy;

// A fixed hash to burn the same scrypt cost when the email is unknown, so an
// attacker cannot tell "no such account" from "wrong password" by the clock.
const DUMMY_HASH_PROMISE = hashPassword('not-a-real-password-timing-equaliser');

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

/** The login name a password session carries: the GitHub login when the
 *  customer has one, else the address's local part (what Google sign-in does). */
function sessionLogin(customer) {
  if (customer && customer.github_login) return customer.github_login;
  return String(customer && customer.email || '').split('@')[0] || 'customer';
}

module.exports = {
  ...policy,
  register, verify, login, forgot, reset, change,
  sessionLogin,
};
