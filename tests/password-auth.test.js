'use strict';
// =============================================================================
// EMAIL + PASSWORD SIGN-IN — owner directive 2026-09-29.
// =============================================================================
// The rules are ONE definition, website/app/lib/password-auth-core.js, with
// the database behind a store interface. These tests run the real core over
// an in-memory store: hash format and verify, token issue / consume / expiry,
// the throttle, enumeration-safe answers, the CSRF check, the copy map, and
// a source-level check that the routes and pages are wired the way the core
// expects. Route handlers cannot be require()d outside the Next build; the
// live half is tests/heavy/password-auth-live.test.js.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../website/app/lib/password-auth-core.js');
const { ensureSchema } = require('../website/app/lib/password-auth-store.js');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const ORIGIN = 'https://gatetest.io';
const GOOD = 'correct-horse-battery-staple-9';
const T0 = Date.parse('2026-09-29T10:00:00Z');

// ─── in-memory store implementing the interface the core documents ──────────
function memoryStore() {
  const customers = new Map(); // email → row
  const tokens = [];
  const failures = [];
  let n = 0;
  return {
    customers, tokens, failures,
    async findCustomerByEmail(email) { return customers.get(email) ? { ...customers.get(email) } : null; },
    async ensureCustomer(email) {
      if (!customers.has(email)) customers.set(email, { id: `c${++n}`, email, github_login: null, password_hash: null, email_verified_at: null });
      return { ...customers.get(email) };
    },
    async setPassword(id, hash, { verifiedAt, now }) {
      for (const c of customers.values()) if (c.id === id) {
        c.password_hash = hash; c.password_updated_at = now;
        c.email_verified_at = c.email_verified_at || (verifiedAt ? new Date(verifiedAt) : null);
      }
    },
    async insertToken(t) { tokens.push({ ...t, used_at: null }); },
    async findToken(kind, tokenHash) {
      const t = tokens.find((x) => x.kind === kind && x.tokenHash === tokenHash);
      if (!t) return null;
      const c = [...customers.values()].find((x) => x.id === t.customerId);
      return { id: t.id, customer_id: t.customerId, kind: t.kind, payload: t.payload, expires_at: new Date(t.expiresAt), used_at: t.used_at, email: c.email, github_login: c.github_login };
    },
    async consumeToken(id, now) { const t = tokens.find((x) => x.id === id); if (t && !t.used_at) t.used_at = now; },
    async invalidateTokens(customerId, kind, now) { for (const t of tokens) if (t.customerId === customerId && t.kind === kind && !t.used_at) t.used_at = now; },
    async countFailures(key, since) { return failures.filter((f) => f.key === key && f.at > since).length; },
    async recordFailure(key, at) { failures.push({ key, at }); },
    async clearFailures(key) { for (let i = failures.length - 1; i >= 0; i--) if (failures[i].key === key) failures.splice(i, 1); },
  };
}

function mailbox() {
  const sent = [];
  const mail = async (msg) => { sent.push(msg); return { ok: true }; };
  mail.sent = sent;
  return mail;
}

function linkToken(msg) {
  const m = /[?&]token=([A-Za-z0-9_%-]+)/.exec(msg.text);
  return m ? decodeURIComponent(m[1]) : null;
}

// ─── hash format + verify ────────────────────────────────────────────────────
describe('hashPassword / verifyPassword — scrypt, per-user salt, stored as scrypt$N$r$p$salt$hash', () => {
  it('produces the documented format with N=2^15, r=8, p=1, 16-byte salt, 64-byte hash', async () => {
    const h = await core.hashPassword(GOOD);
    const parts = h.split('$');
    assert.equal(parts.length, 6);
    assert.equal(parts[0], 'scrypt');
    assert.equal(Number(parts[1]), 32768);
    assert.equal(Number(parts[2]), 8);
    assert.equal(Number(parts[3]), 1);
    const parsed = core.parseStoredHash(h);
    assert.equal(parsed.salt.length, 16);
    assert.equal(parsed.hash.length, 64);
  });
  it('salts per user: the same password hashes differently twice', async () => {
    assert.notEqual(await core.hashPassword(GOOD), await core.hashPassword(GOOD));
  });
  it('verifies the right password and refuses a wrong one', async () => {
    const h = await core.hashPassword(GOOD);
    assert.equal(await core.verifyPassword(GOOD, h), true);
    assert.equal(await core.verifyPassword(GOOD + 'x', h), false);
    assert.equal(await core.verifyPassword('', h), false);
  });
  it('a malformed or foreign stored value is "no match", never a throw', async () => {
    for (const bad of [null, '', 'bcrypt$2b$12$abc', 'scrypt$3$8$1$YWJj$YWJj', 'scrypt$32768$8$1$$', '$2b$12$hash']) {
      assert.equal(await core.verifyPassword(GOOD, bad), false, String(bad));
    }
  });
  it('the module uses node:crypto only — no bcrypt / argon2 native addon', () => {
    const src = read('website/app/lib/password-auth-core.js');
    assert.doesNotMatch(src, /require\(['"](bcrypt|argon2|@node-rs\/[a-z0-9]+)['"]\)/);
    assert.match(src, /crypto\.scrypt\(/);
    assert.match(src, /timingSafeEqual/);
  });
});

// ─── password policy ─────────────────────────────────────────────────────────
describe('validatePassword — 12+ characters, not on the small deny-list', () => {
  it('rejects short, accepts a 12-character one', () => {
    assert.equal(core.validatePassword('short-pass1').code, 'password_short');
    assert.equal(core.validatePassword('twelve-chars').ok, true);
  });
  it('rejects the common ones even when padded past 12', () => {
    for (const pw of ['password1234', 'Password12345!', 'qwertyuiop12', '123456789012', 'aaaaaaaaaaaa', 'iloveyou1234', 'administrator']) {
      assert.equal(core.validatePassword(pw).code, 'password_common', pw);
    }
  });
  it('rejects a password containing the address itself', () => {
    assert.equal(core.validatePassword('craig-is-here-2026', 'craig@example.com').code, 'password_common');
    assert.equal(core.validatePassword('unrelated-phrase-2026', 'craig@example.com').ok, true);
  });
});

// ─── tokens ──────────────────────────────────────────────────────────────────
describe('tokens — 32 random bytes, sha256 stored, single use, 1 h', () => {
  it('newToken is base64url of 32 bytes and hashToken is sha256 hex', () => {
    const { token, tokenHash } = core.newToken();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.match(tokenHash, /^[0-9a-f]{64}$/);
    assert.equal(core.hashToken(token), tokenHash);
    assert.equal(core.isTokenShape(token), true);
    assert.equal(core.isTokenShape('short'), false);
  });
  it('TOKEN_TTL_MS is one hour', () => assert.equal(core.TOKEN_TTL_MS, 3_600_000));

  it('register issues a verify token whose payload is the pending hash; verify consumes it once', async () => {
    const store = memoryStore(); const mail = mailbox();
    const r = await core.register({ store, mail, origin: ORIGIN, email: 'New@Example.com', password: GOOD, now: T0 });
    assert.deepEqual([r.ok, r.status, r.code], [true, 200, 'verify_sent']);
    assert.equal(mail.sent.length, 1);
    assert.equal(mail.sent[0].to, 'new@example.com');
    assert.match(mail.sent[0].text, new RegExp(`${ORIGIN}/api/auth/password/verify\\?token=`));
    const token = linkToken(mail.sent[0]);
    // Not active yet: the password does not sign in before the click.
    const before = await core.login({ store, email: 'new@example.com', password: GOOD, ip: '1.1.1.1', now: T0 });
    assert.equal(before.code, 'bad_credentials');
    assert.equal(store.tokens[0].payload.startsWith('scrypt$'), true);
    assert.notEqual(store.tokens[0].tokenHash, token, 'the token itself is never stored');

    const v = await core.verify({ store, token, now: T0 + 1000 });
    assert.deepEqual([v.ok, v.code, v.email], [true, 'verified', 'new@example.com']);
    assert.equal(v.customer, undefined, 'verify hands out no sign-in identity');
    const c = store.customers.get('new@example.com');
    assert.equal(c.password_hash, store.tokens[0].payload);
    assert.ok(c.email_verified_at);

    const again = await core.verify({ store, token, now: T0 + 2000 });
    assert.deepEqual([again.ok, again.code], [false, 'token_invalid'], 'single use');
    const after = await core.login({ store, email: 'new@example.com', password: GOOD, ip: '1.1.1.1', now: T0 + 3000 });
    assert.equal(after.ok, true);
  });

  it('a new verify token kills every outstanding one: after a re-register the older link is token_invalid, the newest works', async () => {
    const store = memoryStore(); const mail = mailbox();
    // Someone registers the address first (with their password)...
    await core.register({ store, mail, origin: ORIGIN, email: 'pre@example.com', password: 'attacker-chosen-secret', now: T0 });
    const older = linkToken(mail.sent[0]);
    // ...then the mailbox owner registers it with theirs.
    await core.register({ store, mail, origin: ORIGIN, email: 'pre@example.com', password: GOOD, now: T0 + 1 });
    const newest = linkToken(mail.sent[1]);
    assert.notEqual(older, newest);
    assert.ok(store.tokens[0].used_at, 'the older token was invalidated when the newer one was issued');

    const dead = await core.verify({ store, token: older, now: T0 + 2 });
    assert.deepEqual([dead.ok, dead.code], [false, 'token_invalid']);
    assert.equal(store.customers.get('pre@example.com').password_hash, null, 'nothing activated');

    const live = await core.verify({ store, token: newest, now: T0 + 3 });
    assert.deepEqual([live.ok, live.code], [true, 'verified']);
    assert.equal((await core.login({ store, email: 'pre@example.com', password: GOOD, ip: '1.1.1.1', now: T0 + 4 })).ok, true);
    assert.equal((await core.login({ store, email: 'pre@example.com', password: 'attacker-chosen-secret', ip: '1.1.1.2', now: T0 + 5 })).code, 'bad_credentials');
  });

  it('the verify link carries next, and the unverified-login resend also retires older links', async () => {
    const store = memoryStore(); const mail = mailbox();
    await core.register({ store, mail, origin: ORIGIN, email: 'nx@example.com', password: GOOD, next: '/dashboard/usage', now: T0 });
    assert.match(mail.sent[0].text, /\/api\/auth\/password\/verify\?token=[A-Za-z0-9_-]+&next=%2Fdashboard%2Fusage/);
    store.customers.get('nx@example.com').password_hash = store.tokens[0].payload; // pending-but-stored hash
    const r = await core.login({ store, mail, origin: ORIGIN, email: 'nx@example.com', password: GOOD, ip: '7.7.7.7', now: T0 + 1 });
    assert.equal(r.code, 'unverified');
    assert.equal(store.tokens.length, 2);
    assert.ok(store.tokens[0].used_at, 'first link retired by the resend');
    assert.equal(store.tokens[1].used_at, null);
  });

  it('an expired verify token is refused', async () => {
    const store = memoryStore(); const mail = mailbox();
    await core.register({ store, mail, origin: ORIGIN, email: 'a@example.com', password: GOOD, now: T0 });
    const token = linkToken(mail.sent[0]);
    const v = await core.verify({ store, token, now: T0 + core.TOKEN_TTL_MS + 1 });
    assert.deepEqual([v.ok, v.code], [false, 'token_invalid']);
  });

  it('forgot + reset: the reset token is consumed and every other outstanding reset token dies', async () => {
    const store = memoryStore(); const mail = mailbox();
    await store.ensureCustomer('oauth@example.com'); // GitHub-only customer, no password
    const f1 = await core.forgot({ store, mail, origin: ORIGIN, email: 'oauth@example.com', now: T0 });
    const f2 = await core.forgot({ store, mail, origin: ORIGIN, email: 'oauth@example.com', now: T0 + 1 });
    assert.deepEqual([f1.code, f2.code], ['reset_sent', 'reset_sent']);
    assert.equal(mail.sent.length, 2);
    assert.match(mail.sent[0].text, new RegExp(`${ORIGIN}/login/password/reset\\?token=`));
    const t1 = linkToken(mail.sent[0]); const t2 = linkToken(mail.sent[1]);
    const r = await core.reset({ store, token: t2, password: 'brand-new-secret-phrase', now: T0 + 10 });
    assert.deepEqual([r.ok, r.code], [true, 'reset_ok']);
    const dead = await core.reset({ store, token: t1, password: 'another-new-secret-phrase', now: T0 + 20 });
    assert.equal(dead.code, 'token_invalid', 'the older outstanding token was invalidated');
    const reused = await core.reset({ store, token: t2, password: 'another-new-secret-phrase', now: T0 + 20 });
    assert.equal(reused.code, 'token_invalid', 'single use');
    // The reset link proved the mailbox: the OAuth customer now signs in with the password.
    const l = await core.login({ store, email: 'oauth@example.com', password: 'brand-new-secret-phrase', ip: '2.2.2.2', now: T0 + 30 });
    assert.equal(l.ok, true);
  });

  it('reset enforces the password policy before touching anything', async () => {
    const store = memoryStore(); const mail = mailbox();
    await store.ensureCustomer('p@example.com');
    await core.forgot({ store, mail, origin: ORIGIN, email: 'p@example.com', now: T0 });
    const token = linkToken(mail.sent[0]);
    const r = await core.reset({ store, token, password: 'short', now: T0 + 1 });
    assert.equal(r.code, 'password_short');
    assert.equal(store.tokens[0].used_at, null, 'token survives a policy rejection');
  });
});

// ─── throttle ────────────────────────────────────────────────────────────────
describe('login throttle — 10 failures per email + IP per 15 min, counted in the store', () => {
  it('the 11th attempt is 429 even with the right password; another IP is unaffected; the window expires', async () => {
    const store = memoryStore(); const mail = mailbox();
    await core.register({ store, mail, origin: ORIGIN, email: 't@example.com', password: GOOD, now: T0 });
    await core.verify({ store, token: linkToken(mail.sent[0]), now: T0 });
    for (let i = 0; i < 10; i++) {
      const r = await core.login({ store, email: 't@example.com', password: 'wrong-password-here', ip: '3.3.3.3', now: T0 + i });
      assert.equal(r.status, 401, `attempt ${i + 1}`);
    }
    const blocked = await core.login({ store, email: 't@example.com', password: GOOD, ip: '3.3.3.3', now: T0 + 100 });
    assert.deepEqual([blocked.status, blocked.code], [429, 'throttled']);
    const otherIp = await core.login({ store, email: 't@example.com', password: GOOD, ip: '4.4.4.4', now: T0 + 100 });
    assert.equal(otherIp.ok, true);
    const later = await core.login({ store, email: 't@example.com', password: GOOD, ip: '3.3.3.3', now: T0 + core.THROTTLE_WINDOW_MS + 101 });
    assert.equal(later.ok, true, 'window expired');
  });
  it('a success clears the counter', async () => {
    const store = memoryStore(); const mail = mailbox();
    await core.register({ store, mail, origin: ORIGIN, email: 'u@example.com', password: GOOD, now: T0 });
    await core.verify({ store, token: linkToken(mail.sent[0]), now: T0 });
    for (let i = 0; i < 9; i++) await core.login({ store, email: 'u@example.com', password: 'wrong-password-here', ip: '5.5.5.5', now: T0 + i });
    assert.equal(store.failures.length, 9);
    assert.equal((await core.login({ store, email: 'u@example.com', password: GOOD, ip: '5.5.5.5', now: T0 + 20 })).ok, true);
    assert.equal(store.failures.length, 0);
  });
  it('the key never holds the address in clear', () => {
    const k = core.throttleKey('Someone@Example.com', '9.9.9.9');
    assert.match(k, /^[0-9a-f]{64}$/);
    assert.equal(k, core.throttleKey('someone@example.com', '9.9.9.9'), 'case-normalised');
  });
  it('the store counts in the database, not a process Map', () => {
    const src = read('website/app/lib/password-auth-store.js');
    assert.match(src, /INSERT INTO auth_login_failures/);
    assert.match(src, /SELECT COUNT\(\*\)::int AS n FROM auth_login_failures/);
    assert.doesNotMatch(src, /new Map\(/);
  });
});

// ─── enumeration-safe answers ────────────────────────────────────────────────
describe('no user enumeration', () => {
  it('login: unknown email, OAuth-only account and wrong password all answer bad_credentials', async () => {
    const store = memoryStore(); const mail = mailbox();
    await store.ensureCustomer('gh@example.com');
    await core.register({ store, mail, origin: ORIGIN, email: 'pw@example.com', password: GOOD, now: T0 });
    await core.verify({ store, token: linkToken(mail.sent[0]), now: T0 });
    const answers = await Promise.all([
      core.login({ store, email: 'nobody@example.com', password: GOOD, ip: '6.6.6.6', now: T0 }),
      core.login({ store, email: 'gh@example.com', password: GOOD, ip: '6.6.6.6', now: T0 }),
      core.login({ store, email: 'pw@example.com', password: 'wrong-password-here', ip: '6.6.6.6', now: T0 }),
      core.login({ store, email: 'not-an-email', password: GOOD, ip: '6.6.6.6', now: T0 }),
    ]);
    for (const a of answers) assert.deepEqual([a.ok, a.status, a.code], [false, 401, 'bad_credentials']);
  });
  it('forgot: known and unknown addresses get the identical result shape; only the known one gets mail', async () => {
    const store = memoryStore(); const mail = mailbox();
    await store.ensureCustomer('known@example.com');
    const known = await core.forgot({ store, mail, origin: ORIGIN, email: 'known@example.com', now: T0 });
    const unknown = await core.forgot({ store, mail, origin: ORIGIN, email: 'unknown@example.com', now: T0 });
    assert.deepEqual([known.ok, known.status, known.code], [unknown.ok, unknown.status, unknown.code]);
    assert.deepEqual([known.ok, known.status, known.code], [true, 200, 'reset_sent']);
    assert.equal(mail.sent.length, 1);
    assert.equal(mail.sent[0].to, 'known@example.com');
  });
  it('register: an address that already has a working password gets the same answer, and the owner a notice, never an overwrite', async () => {
    const store = memoryStore(); const mail = mailbox();
    await core.register({ store, mail, origin: ORIGIN, email: 'own@example.com', password: GOOD, now: T0 });
    await core.verify({ store, token: linkToken(mail.sent[0]), now: T0 });
    const hashBefore = store.customers.get('own@example.com').password_hash;
    const again = await core.register({ store, mail, origin: ORIGIN, email: 'own@example.com', password: 'attacker-chosen-secret', now: T0 + 1 });
    assert.deepEqual([again.ok, again.status, again.code], [true, 200, 'verify_sent']);
    assert.equal(mail.sent.length, 2);
    assert.match(mail.sent[1].subject, /already exists/);
    assert.match(mail.sent[1].text, /\/login\/password\/forgot/);
    assert.equal(store.tokens.length, 1, 'no second verify token');
    assert.ok(store.tokens[0].used_at, 'the original verify token was consumed by the click, not reissued');
    assert.equal(store.customers.get('own@example.com').password_hash, hashBefore);
  });
  it('a right password on an unverified address is told so and gets the link again (the password proves ownership)', async () => {
    const store = memoryStore(); const mail = mailbox();
    await core.register({ store, mail, origin: ORIGIN, email: 'wait@example.com', password: GOOD, now: T0 });
    // simulate a pending-but-stored hash (e.g. an older row) so the branch is reachable
    store.customers.get('wait@example.com').password_hash = store.tokens[0].payload;
    const r = await core.login({ store, mail, origin: ORIGIN, email: 'wait@example.com', password: GOOD, ip: '7.7.7.7', now: T0 });
    assert.deepEqual([r.ok, r.status, r.code], [false, 403, 'unverified']);
    assert.equal(mail.sent.length, 2);
    assert.equal(store.failures.length, 0, 'not a failed guess');
  });
});

// ─── change ──────────────────────────────────────────────────────────────────
describe('change — signed-in, current + new', () => {
  it('wrong current password, policy, then success which kills outstanding reset links', async () => {
    const store = memoryStore(); const mail = mailbox();
    await core.register({ store, mail, origin: ORIGIN, email: 'ch@example.com', password: GOOD, now: T0 });
    await core.verify({ store, token: linkToken(mail.sent[0]), now: T0 });
    await core.forgot({ store, mail, origin: ORIGIN, email: 'ch@example.com', now: T0 });
    assert.equal((await core.change({ store, email: 'ch@example.com', currentPassword: 'nope-nope-nope', newPassword: 'a-fresh-long-secret', now: T0 })).code, 'current_wrong');
    assert.equal((await core.change({ store, email: 'ch@example.com', currentPassword: GOOD, newPassword: 'short', now: T0 })).code, 'password_short');
    assert.equal((await core.change({ store, email: 'ch@example.com', currentPassword: GOOD, newPassword: 'a-fresh-long-secret', now: T0 + 1 })).code, 'changed');
    assert.equal(store.tokens.filter((t) => t.kind === 'reset' && !t.used_at).length, 0);
    assert.equal((await core.login({ store, email: 'ch@example.com', password: 'a-fresh-long-secret', ip: '8.8.8.8', now: T0 + 2 })).ok, true);
  });
  it('an OAuth-only account is pointed at the reset link; no session is not_signed_in', async () => {
    const store = memoryStore();
    await store.ensureCustomer('gh@example.com');
    assert.equal((await core.change({ store, email: 'gh@example.com', currentPassword: 'x', newPassword: 'a-fresh-long-secret' })).code, 'no_password');
    assert.equal((await core.change({ store, email: '', currentPassword: 'x', newPassword: 'a-fresh-long-secret' })).code, 'not_signed_in');
  });
});

// ─── CSRF ────────────────────────────────────────────────────────────────────
describe('checkSameOrigin — Sec-Fetch-Site / Origin, fails closed', () => {
  const canon = 'https://gatetest.io';
  it('accepts Sec-Fetch-Site: same-origin', () => {
    assert.equal(core.checkSameOrigin({ secFetchSite: 'same-origin' }, canon).ok, true);
  });
  it('refuses cross-site, same-site and none', () => {
    for (const s of ['cross-site', 'same-site', 'none']) assert.equal(core.checkSameOrigin({ secFetchSite: s, origin: canon }, canon).ok, false, s);
  });
  it('without Sec-Fetch-Site, Origin must equal the canonical origin or the request host', () => {
    assert.equal(core.checkSameOrigin({ origin: 'https://gatetest.io' }, canon).ok, true);
    assert.equal(core.checkSameOrigin({ origin: 'https://GateTest.io' }, canon).ok, true);
    assert.equal(core.checkSameOrigin({ origin: 'http://localhost:3000', host: 'localhost:3000', forwardedProto: 'http' }, canon).ok, true);
    assert.equal(core.checkSameOrigin({ origin: 'https://evil.example', host: 'gatetest.io' }, canon).ok, false);
    assert.equal(core.checkSameOrigin({ origin: 'null' }, canon).ok, false);
  });
  it('no header at all is refused', () => {
    assert.equal(core.checkSameOrigin({}, canon).ok, false);
    assert.equal(core.checkSameOrigin({ host: 'gatetest.io' }, canon).ok, false);
  });
});

// ─── copy ────────────────────────────────────────────────────────────────────
describe('ERROR_COPY / NOTICE_COPY — every code a route can redirect with has a sentence', () => {
  const routeDir = 'website/app/api/auth/password';
  const routes = fs.readdirSync(path.join(ROOT, routeDir)).map((d) => `${routeDir}/${d}/route.ts`);
  it('lists six routes', () => assert.equal(routes.length, 6));
  it('every code named in a route header or body is in a copy map', () => {
    const known = new Set([...Object.keys(core.ERROR_COPY), ...Object.keys(core.NOTICE_COPY), 'signed_in']);
    for (const r of routes) {
      const src = read(r);
      for (const m of src.matchAll(/code:\s*"([a-z_]+)"/g)) assert.ok(known.has(m[1]), `${r}: ${m[1]}`);
      for (const m of src.matchAll(/error:\s*"([a-z_]+)"/g)) assert.ok(known.has(m[1]), `${r}: ${m[1]}`);
    }
  });
  it('every result code the core returns is in a copy map', () => {
    const src = read('website/app/lib/password-auth-core.js');
    const known = new Set([...Object.keys(core.ERROR_COPY), ...Object.keys(core.NOTICE_COPY), 'signed_in']);
    for (const m of src.matchAll(/result\((?:true|false), \d+, '([a-z_]+)'/g)) assert.ok(known.has(m[1]), m[1]);
    for (const m of src.matchAll(/code: '([a-z_]+)'/g)) assert.ok(known.has(m[1]), m[1]);
  });
  it('the generic sign-in failure is one sentence with no hint', () => {
    assert.equal(core.ERROR_COPY.bad_credentials, 'Email or password is wrong.');
  });
  it('mail copy is vendor-neutral', () => {
    for (const msg of [core.verifyEmail({ to: 'a@b.co', link: 'https://x/y' }), core.resetEmail({ to: 'a@b.co', link: 'https://x/y' }), core.accountExistsEmail({ to: 'a@b.co', forgotLink: 'https://x/f' })]) {
      assert.doesNotMatch(msg.text + msg.html, /vapron|tallrig|resend|claude|anthropic/i);
      assert.match(msg.text, /one hour/);
      assert.match(msg.html, /href="https:\/\/x\//);
    }
  });
});

// ─── wiring (source level) ───────────────────────────────────────────────────
describe('wiring — routes, pages, schema, gate', () => {
  const PUBLIC = ['register', 'login', 'verify', 'forgot', 'reset'];
  for (const name of PUBLIC) {
    it(`/api/auth/password/${name} carries the auth-public marker in the comment block attached to the handler`, () => {
      const src = read(`website/app/api/auth/password/${name}/route.ts`);
      assert.match(src, /\/\/ auth-public[\s\S]{0,600}?export async function (POST|GET)\(/);
    });
  }
  it('/api/auth/password/change is NOT auth-public and takes identity from the session cookie', () => {
    const src = read('website/app/api/auth/password/change/route.ts');
    assert.doesNotMatch(src, /auth-public/);
    assert.match(src, /currentSessionEmail\(\)/);
  });
  it('every POST route runs the same-origin check before any work, and the JSON/form parser', () => {
    for (const name of ['register', 'login', 'forgot', 'reset', 'change']) {
      const src = read(`website/app/api/auth/password/${name}/route.ts`);
      assert.match(src, /if \(!csrfOk\(req\)\) return/, name);
      assert.match(src, /readFields\(req\)/, name);
      assert.match(src, /export async function POST\(/, name);
    }
    assert.match(read('website/app/api/auth/password/verify/route.ts'), /export async function GET\(/);
  });
  it('verify never sets a session cookie: it 303s to /login/password?notice=verified with next carried', () => {
    const src = read('website/app/api/auth/password/verify/route.ts');
    assert.doesNotMatch(src, /signInCookie|Set-Cookie|signCustomerSession/);
    assert.match(src, /redirectTo\(PAGE, \{ notice: result\.code, next \}\)/);
    assert.match(src, /safeNext\(req\.nextUrl\.searchParams\.get\("next"\)\)/);
    assert.equal(core.NOTICE_COPY.verified.length > 0, true);
    // Only login sets the cookie among the six routes.
    for (const name of ['register', 'verify', 'forgot', 'reset', 'change']) {
      assert.doesNotMatch(read(`website/app/api/auth/password/${name}/route.ts`), /signInCookie/, name);
    }
    assert.match(read('website/app/api/auth/password/login/route.ts'), /signInCookie\(/);
  });
  it('no route or helper logs the password field, the fields object or the body', () => {
    const files = [
      ...PUBLIC.map((n) => `website/app/api/auth/password/${n}/route.ts`),
      'website/app/api/auth/password/change/route.ts',
      'website/app/lib/password-auth-http.ts',
      'website/app/lib/password-auth-core.js',
      'website/app/lib/password-auth-store.js',
    ];
    for (const f of files) {
      const lines = read(f).split(/\r?\n/);
      lines.forEach((line, i) => {
        if (!/console\.(log|error|warn|info|debug)\(/.test(line)) return;
        // Fixed string literals (the "[password-auth]" prefix) are fine; an
        // IDENTIFIER named password / fields / body / email / token is not.
        const identifiers = line.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '""');
        assert.doesNotMatch(identifiers, /\b(password|fields|body|email|token|newPassword|currentPassword)\b/, `${f}:${i + 1} logs a sensitive field: ${line.trim()}`);
      });
    }
  });
  it('the session cookie is signed by signCustomerSession with the OAuth callbacks\' flags', () => {
    const http = read('website/app/lib/password-auth-http.ts');
    const cb = read('website/app/api/auth/callback/route.ts');
    assert.match(http, /signCustomerSession\(/);
    for (const flag of ['`Max-Age=${CUSTOMER_MAX_AGE_SECONDS}`', '"Path=/"', '"HttpOnly"', '"SameSite=Lax"', '...(isProduction ? ["Secure"] : [])']) {
      assert.ok(http.includes(flag), `http helper: ${flag}`);
      assert.ok(cb.includes(flag), `callback: ${flag}`);
    }
  });
  it('links are built on the canonical origin (site-url.js), never NEXT_PUBLIC_BASE_URL by hand', () => {
    const http = read('website/app/lib/password-auth-http.ts');
    assert.match(http, /from "\.\/site-url\.js"/);
    assert.doesNotMatch(http, /NEXT_PUBLIC_BASE_URL/);
    assert.match(read('website/app/lib/password-auth-core.js'), /`\$\{origin\}\/api\/auth\/password\/verify\?\$\{q\.toString\(\)\}`/);
  });
  it('mail goes through the one transport (mail-transport.js deliver)', () => {
    assert.match(read('website/app/lib/password-auth-http.ts'), /from "\.\/mail-transport\.js"/);
    assert.match(read('website/app/lib/password-auth-http.ts'), /deliver\(msg\)/);
  });
  it('the schema is additive and reaches every apply path: store ensureSchema, schema.sql, /api/db/init', () => {
    const store = read('website/app/lib/password-auth-store.js');
    const sql = read('website/app/lib/schema.sql');
    const init = read('website/app/api/db/init/route.ts');
    for (const col of ['password_hash TEXT', 'email_verified_at TIMESTAMPTZ', 'password_updated_at TIMESTAMPTZ']) {
      assert.match(store, new RegExp(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS ${col}`));
      assert.match(sql, new RegExp(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS ${col}`));
    }
    for (const t of ['auth_tokens', 'auth_login_failures']) {
      assert.match(store, new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\(`));
      assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\(`));
    }
    assert.match(store, /kind TEXT NOT NULL CHECK \(kind IN \('verify', 'reset'\)\)/);
    assert.match(store, /token_hash TEXT NOT NULL UNIQUE/);
    assert.match(init, /ensurePasswordAuthSchema\(sql\)/);
    assert.doesNotMatch(store, /DROP |ALTER COLUMN|RENAME/);
  });
  it('ensureSchema issues only IF NOT EXISTS statements (run against a recording sql)', async () => {
    const seen = [];
    const sql = async (strings) => { seen.push(strings.join('')); return []; };
    await ensureSchema(sql);
    assert.ok(seen.length >= 9);
    for (const s of seen) assert.match(s, /IF NOT EXISTS/, s.slice(0, 60));
  });
  it('the five pages exist, are server components with plain forms posting to the routes, and 404 when the feature is off', () => {
    const pages = {
      'website/app/login/password/page.tsx': '/api/auth/password/login',
      'website/app/login/password/register/page.tsx': '/api/auth/password/register',
      'website/app/login/password/forgot/page.tsx': '/api/auth/password/forgot',
      'website/app/login/password/reset/page.tsx': '/api/auth/password/reset',
      'website/app/account/password/page.tsx': '/api/auth/password/change',
    };
    for (const [file, action] of Object.entries(pages)) {
      const src = read(file);
      assert.doesNotMatch(src, /^"use client"/m, `${file} must be a server component`);
      assert.ok(src.includes(`action="${action}"`), `${file} posts to ${action}`);
      assert.match(src, /method="post"/);
      assert.match(src, /if \(!PASSWORD_AUTH_ENABLED\) notFound\(\)/);
      assert.match(src, /copyFor\(/, `${file} renders copy from the query code map`);
      assert.doesNotMatch(src, /onSubmit|useState|fetch\(/, `${file} works without JavaScript`);
    }
    assert.match(read('website/app/login/password/page.tsx'), /name="next"/);
    assert.match(read('website/app/login/password/page.tsx'), /\/login\/password\/forgot\$\{q\}/);
    assert.match(read('website/app/login/password/page.tsx'), /\/login\/password\/register\$\{q\}/);
  });
  it('/account/password is behind the server-side sign-in gate', () => {
    const { PROTECTED_PREFIXES, requireSession } = require('../website/app/lib/session-gate.js');
    assert.ok(PROTECTED_PREFIXES.includes('/account/password'));
    assert.deepEqual(requireSession({ pathname: '/account/password', search: '', cookie: undefined, secret: 's' }),
      { ok: false, location: '/login?next=%2Faccount%2Fpassword' });
  });
  it('the feature switch exists and the routes and pages read it', () => {
    const feat = read('website/app/lib/auth-features.ts');
    assert.match(feat, /export const PASSWORD_AUTH_ENABLED = (true|false);/);
    assert.match(read('website/app/lib/password-auth-http.ts'), /PASSWORD_AUTH_ENABLED === true/);
  });
});
