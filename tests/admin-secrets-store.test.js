'use strict';
/**
 * Admin secrets panel — crypto, reserved names, the store and its audit chain.
 * Control pairs throughout: the thing that must be refused beside the thing
 * that must pass. No database, no network: the store runs on the in-memory
 * adapter in tests/helpers/secrets-memory-adapter.js.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'website', 'app', 'lib', 'secrets');
const sc = require(path.join(LIB, 'crypto.js'));
const reserved = require(path.join(LIB, 'reserved.js'));
const { appendAudit, verifyAuditChain } = require(path.join(LIB, 'audit.js'));
const { createSecretsStore, SecretsError } = require(path.join(LIB, 'store.js'));
const { createMemoryAdapter } = require('./helpers/secrets-memory-adapter');

const KEY_A = crypto.randomBytes(32).toString('base64');
const KEY_B = crypto.randomBytes(32).toString('hex');
const NO_EXAMPLES = { exampleFiles: [] };
const env = (extra = {}) => ({ GATETEST_SECRETS_MASTER_KEY: KEY_A, ...extra });

describe('crypto: AES-256-GCM with the name bound into the AAD', () => {
  it('round-trips a value, with a fresh 12-byte IV per write', () => {
    const ring = sc.loadKeyring(env(), NO_EXAMPLES);
    const a = sc.encrypt(ring, 'STRIPE_SECRET_KEY', 'sk_' + 'live_round_trip_value_123');
    const b = sc.encrypt(ring, 'STRIPE_SECRET_KEY', 'sk_' + 'live_round_trip_value_123');
    assert.equal(Buffer.from(a.iv, 'base64').length, 12);
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.ciphertext, b.ciphertext);
    assert.equal(sc.decrypt(ring, 'STRIPE_SECRET_KEY', a), 'sk_' + 'live_round_trip_value_123');
    assert.match(a.keyVersion, /^v1:[0-9a-f]{16}$/);
  });

  it('a ciphertext made for name A does NOT decrypt as name B (AAD binding)', () => {
    const ring = sc.loadKeyring(env(), NO_EXAMPLES);
    const sealed = sc.encrypt(ring, 'NAME_A', 'value-for-a-only');
    assert.equal(sc.decrypt(ring, 'NAME_A', sealed), 'value-for-a-only');
    assert.throws(() => sc.decrypt(ring, 'NAME_B', sealed), (e) => e.name === 'DecryptFailed');
  });

  it('a tampered tag throws — never passes the bytes through as plaintext', () => {
    const ring = sc.loadKeyring(env(), NO_EXAMPLES);
    const sealed = sc.encrypt(ring, 'X_TOKEN', 'abc-def-ghi-jkl');
    const tag = Buffer.from(sealed.tag, 'base64');
    tag[0] ^= 1;
    assert.throws(() => sc.decrypt(ring, 'X_TOKEN', { ...sealed, tag: tag.toString('base64') }), (e) => e.name === 'DecryptFailed');
    assert.throws(() => sc.decrypt(ring, 'X_TOKEN', { ...sealed, ciphertext: Buffer.from('plain').toString('base64') }), (e) => e.name === 'DecryptFailed');
  });

  it('refuses a missing, short, malformed, repeated-byte or shared master key (typed StoreUnavailable)', () => {
    const cases = {
      master_key_missing: {},
      master_key_wrong_length: { GATETEST_SECRETS_MASTER_KEY: crypto.randomBytes(16).toString('base64') },
      master_key_malformed: { GATETEST_SECRETS_MASTER_KEY: 'not a key!' },
      master_key_weak: { GATETEST_SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') },
      master_key_not_dedicated: { GATETEST_SECRETS_MASTER_KEY: KEY_A, SESSION_SECRET: KEY_A },
    };
    for (const [reason, e] of Object.entries(cases)) {
      assert.throws(() => sc.loadKeyring(e, NO_EXAMPLES), (err) => err.name === 'StoreUnavailable' && err.code === 'store_unavailable' && err.reason === reason, reason);
    }
    // Control: a random 32-byte key in either encoding is accepted.
    assert.ok(sc.loadKeyring(env(), NO_EXAMPLES));
    assert.ok(sc.loadKeyring({ GATETEST_SECRETS_MASTER_KEY: KEY_B }, NO_EXAMPLES));
  });

  it('refuses a key equal to any value in .env.example; the shipped placeholder is refused too', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-secrets-ex-'));
    try {
      const ex = path.join(tmp, '.env.example');
      fs.writeFileSync(ex, `# example\nSOME_KEY="${KEY_A}"\nOTHER=1\n`);
      assert.throws(() => sc.loadKeyring(env(), { exampleFiles: [ex] }), (e) => e.reason === 'master_key_is_example');
      assert.ok(sc.loadKeyring({ GATETEST_SECRETS_MASTER_KEY: KEY_B }, { exampleFiles: [ex] }), 'control: a different key passes');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    const real = path.join(__dirname, '..', 'website', '.env.example');
    const shipped = /^GATETEST_SECRETS_MASTER_KEY=(.*)$/m.exec(fs.readFileSync(real, 'utf8'));
    assert.ok(shipped, '.env.example documents GATETEST_SECRETS_MASTER_KEY');
    assert.throws(() => sc.loadKeyring({ GATETEST_SECRETS_MASTER_KEY: shipped[1] }, { exampleFiles: [real] }), (e) => e.name === 'StoreUnavailable');
  });

  it('rotation: NEXT is the write key, rows name their key, an unloaded key throws key_not_loaded', () => {
    const old = sc.loadKeyring(env(), NO_EXAMPLES);
    const sealedOld = sc.encrypt(old, 'A_TOKEN', 'old-key-value-1');
    const both = sc.loadKeyring(env({ GATETEST_SECRETS_MASTER_KEY_NEXT: KEY_B }), NO_EXAMPLES);
    assert.equal(both.writeVersion, both.nextVersion);
    assert.equal(sc.decrypt(both, 'A_TOKEN', sealedOld), 'old-key-value-1', 'old rows still read during rotation');
    const sealedNew = sc.encrypt(both, 'A_TOKEN', 'new-key-value-2');
    assert.equal(sealedNew.keyVersion, both.nextVersion);
    const onlyNew = sc.loadKeyring({ GATETEST_SECRETS_MASTER_KEY: KEY_B }, NO_EXAMPLES);
    assert.equal(sc.decrypt(onlyNew, 'A_TOKEN', sealedNew), 'new-key-value-2', 'promoting NEXT to current keeps rows readable');
    assert.throws(() => sc.decrypt(onlyNew, 'A_TOKEN', sealedOld), (e) => e.reason === 'key_not_loaded');
    assert.throws(() => sc.loadKeyring(env({ GATETEST_SECRETS_MASTER_KEY_NEXT: 'short' }), NO_EXAMPLES), (e) => e.reason === 'master_key_next_malformed' || e.reason === 'master_key_next_wrong_length');
  });
});

describe('reserved names and the name/value rules', () => {
  it('the store key, admin password, session secret and DATABASE_URL are reserved', () => {
    for (const n of ['GATETEST_SECRETS_MASTER_KEY', 'GATETEST_SECRETS_MASTER_KEY_NEXT', 'GATETEST_ADMIN_PASSWORD', 'SESSION_SECRET', 'DATABASE_URL', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED']) {
      assert.deepEqual(reserved.checkName(n).error, 'reserved_name', n);
    }
    assert.deepEqual(reserved.checkName('STRIPE_SECRET_KEY'), { ok: true }, 'control');
  });

  it('the admin password name is the one admin-auth.ts actually reads', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'website', 'app', 'lib', 'admin-auth.ts'), 'utf8');
    const read = [...src.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]);
    assert.ok(read.length > 0);
    for (const n of read) assert.ok(reserved.isReserved(n), `${n} is read by admin-auth.ts and must be reserved`);
  });

  it('name shape ^[A-Z][A-Z0-9_]{1,63}$', () => {
    for (const bad of ['', 'a', 'lower_case', '1ABC', 'A-B', 'A'.repeat(65), 'X']) assert.equal(reserved.checkName(bad).error, 'invalid_name', bad);
    for (const good of ['AB', 'MY_TOKEN_2', 'A'.repeat(64)]) assert.ok(reserved.checkName(good).ok, good);
  });

  it('values: empty, too long, NUL / CR / LF refused; an escaped-newline PEM passes', () => {
    assert.equal(reserved.checkValue('   ').error, 'value_empty');
    assert.equal(reserved.checkValue('x'.repeat(reserved.MAX_VALUE_BYTES + 1)).error, 'value_too_long');
    for (const bad of ['a\nb', 'a\rb', 'a\0b']) assert.equal(reserved.checkValue(bad).error, 'value_invalid_chars');
    assert.ok(reserved.checkValue('-----BEGIN RSA PRIVATE KEY-----\\nMIIE\\n-----END RSA PRIVATE KEY-----').ok);
  });
});

function makeStore(extraEnv) {
  const adapter = createMemoryAdapter();
  const store = createSecretsStore({ adapter, env: env(extraEnv), exampleFiles: [] });
  return { adapter, store };
}
const WHO = { actor: 'admin', ip: '203.0.113.9' };

describe('store: set / reveal / remove, audited without values', () => {
  it('set stores ciphertext + fingerprint; reveal returns the value; the list never carries it', async () => {
    const { adapter, store } = makeStore();
    const VALUE = 're_' + 'live_4f9a8b7c6d5e4f3a2b1c';
    const r = await store.set('RESEND_API_KEY', VALUE, WHO);
    assert.equal(r.fingerprint, sc.fingerprint(VALUE));
    assert.match(r.fingerprint, /^[0-9a-f]{8}$/);
    const row = adapter.rows.get('RESEND_API_KEY');
    assert.ok(!JSON.stringify(row).includes(VALUE), 'the row holds ciphertext, not the value');
    assert.equal(await store.reveal('RESEND_API_KEY', WHO), VALUE);
    assert.ok(!JSON.stringify(await store.list()).includes(VALUE));
    assert.deepEqual((await store.remove('RESEND_API_KEY', WHO)).removed, true);
  });

  it('audit rows NEVER contain the value or the ciphertext — every column searched', async () => {
    const { adapter, store } = makeStore();
    const VALUE = 'sk_' + 'live_AuditMustNeverHoldThis_9Z';
    await store.set('STRIPE_SECRET_KEY', VALUE, WHO);
    const cipher = adapter.rows.get('STRIPE_SECRET_KEY').ciphertext;
    await store.reveal('STRIPE_SECRET_KEY', WHO);
    await store.set('STRIPE_SECRET_KEY', `${VALUE}_v2`, WHO);
    await store.remove('STRIPE_SECRET_KEY', WHO);
    // A careless caller passing the value as detail is redacted, not stored.
    await store.audit({ actor: 'admin', action: 'set', name: 'STRIPE_SECRET_KEY', ip: WHO.ip, outcome: 'ok', detail: `oops ${VALUE}` }, [VALUE]);
    assert.ok(adapter.audit.length >= 5);
    for (const row of adapter.audit) {
      for (const [col, v] of Object.entries(row)) {
        const s = String(v);
        assert.ok(!s.includes(VALUE), `audit column ${col} holds the value`);
        assert.ok(!s.includes(cipher), `audit column ${col} holds the ciphertext`);
      }
    }
    // Control: the audit does record what happened.
    assert.deepEqual(adapter.audit.map((a) => a.action).slice(0, 4), ['set', 'reveal', 'set', 'delete']);
  });

  it('refuses reserved and malformed names with the contract codes and statuses', async () => {
    const { store } = makeStore();
    await assert.rejects(store.set('SESSION_SECRET', 'abcdefghijklmnop', WHO), (e) => e instanceof SecretsError && e.code === 'reserved_name' && e.status === 409);
    await assert.rejects(store.set('bad-name', 'abcdefghijklmnop', WHO), (e) => e.code === 'invalid_name' && e.status === 400);
    await assert.rejects(store.set('GOOD_NAME', 'a\nb', WHO), (e) => e.code === 'value_invalid_chars' && e.status === 400);
    await assert.rejects(store.set('GOOD_NAME', '', WHO), (e) => e.code === 'value_empty');
  });

  it('warns same_value_as:<OTHER> when the value is already stored under another name', async () => {
    const { store } = makeStore();
    await store.set('FIRST_TOKEN', 'shared-value-1234567890', WHO);
    const r = await store.set('SECOND_TOKEN', 'shared-value-1234567890', WHO);
    assert.deepEqual(r.warnings, ['same_value_as:FIRST_TOKEN']);
    const c = await store.set('THIRD_TOKEN', 'different-value-0987654321', WHO);
    assert.deepEqual(c.warnings, [], 'control: a different value has no warning');
  });

  it('a store with no usable key is not ready and refuses writes with StoreUnavailable', async () => {
    const adapter = createMemoryAdapter();
    const store = createSecretsStore({ adapter, env: {}, exampleFiles: [] });
    assert.deepEqual(store.status(), { storeReady: false, storeError: 'master_key_missing', keyVersion: null });
    await assert.rejects(store.set('SOME_TOKEN', 'abcdefghijklmnop', WHO), (e) => e.name === 'StoreUnavailable');
  });
});

describe('audit hash chain', () => {
  it('verifies an untouched chain and breaks at a tampered row', async () => {
    const adapter = createMemoryAdapter();
    for (const action of ['set', 'reveal', 'delete', 'apply']) {
      await appendAudit(adapter, { actor: 'admin', action, name: 'A_TOKEN', ip: '198.51.100.1', outcome: 'ok' });
    }
    assert.deepEqual(verifyAuditChain(adapter.audit), { ok: true, count: 4 });
    const tampered = adapter.audit.map((r) => ({ ...r }));
    tampered[2].outcome = 'not_found';
    assert.deepEqual(verifyAuditChain(tampered), { ok: false, brokenAt: 2, reason: 'hash_mismatch' });
    const deleted = adapter.audit.filter((_, i) => i !== 1);
    assert.equal(verifyAuditChain(deleted).brokenAt, 1, 'a removed row breaks the next link');
  });

  it('two writers on the same tail: the loser retries onto the new tail (prev_hash is unique)', async () => {
    const adapter = createMemoryAdapter();
    await appendAudit(adapter, { actor: 'admin', action: 'set', outcome: 'ok' });
    const staleTail = await adapter.lastAudit();
    let first = true;
    const racing = { ...adapter, lastAudit: async () => { if (first) { first = false; await appendAudit(adapter, { actor: 'other', action: 'list', outcome: 'ok' }); return staleTail; } return adapter.lastAudit(); } };
    await appendAudit(racing, { actor: 'admin', action: 'reveal', outcome: 'ok' });
    assert.equal(adapter.audit.length, 3);
    assert.equal(verifyAuditChain(adapter.audit).ok, true);
  });
});
