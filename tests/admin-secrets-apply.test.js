'use strict';
/**
 * Admin secrets panel — rendering, the atomic write, the shadow detector,
 * liveness probes, the step-up cookie and the panel service flows.
 * No network (fake fetch), no database (memory adapter), no real /var/lib.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'website', 'app', 'lib', 'secrets');
const { renderEnv, parseEnvFile, escapeValue, readHeader } = require(path.join(LIB, 'render-env.js'));
const { materialize } = require(path.join(LIB, 'materialize.js'));
const { detectShadow } = require(path.join(LIB, 'shadow.js'));
const { probeLiveness } = require(path.join(LIB, 'liveness.js'));
const stepUp = require(path.join(LIB, 'step-up.js'));
const { fingerprint } = require(path.join(LIB, 'crypto.js'));
const { createSecretsStore } = require(path.join(LIB, 'store.js'));
const panel = require(path.join(LIB, 'panel.js'));
const { createMemoryAdapter } = require('./helpers/secrets-memory-adapter');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gt-secrets-'));
const isWin = process.platform === 'win32';

describe('render: systemd double-quote escaping', () => {
  it('escapes $, backtick, double quote and backslash, and parses back to the exact value', () => {
    const nasty = 'a$HOME`id`"q"\\n\\end $$ ${X}';
    const text = renderEnv([{ name: 'NASTY_TOKEN', value: nasty }, { name: 'A_TOKEN', value: 'plain' }], { now: 0 });
    const line = text.split('\n').find((l) => l.startsWith('NASTY_TOKEN='));
    assert.equal(line, 'NASTY_TOKEN="a\\$HOME\\`id\\`\\"q\\"\\\\n\\\\end \\$\\$ \\${X}"');
    assert.equal(parseEnvFile(text).get('NASTY_TOKEN'), nasty);
    assert.equal(parseEnvFile(text).get('A_TOKEN'), 'plain');
  });

  it('sorted, header has timestamp + count and never a value', () => {
    const text = renderEnv([{ name: 'Z_TOKEN', value: 'zzzz-value' }, { name: 'B_TOKEN', value: 'bbbb-value' }], { now: Date.UTC(2026, 8, 30) });
    const lines = text.trim().split('\n');
    assert.deepEqual(readHeader(text), { renderedAt: '2026-09-30T00:00:00.000Z', count: 2 });
    assert.ok(lines[2].startsWith('B_TOKEN=') && lines[3].startsWith('Z_TOKEN='));
    assert.ok(!lines.slice(0, 2).join('\n').includes('value'));
  });

  it('refuses NUL, CR and LF in a value; a plain value is accepted (control)', () => {
    for (const bad of ['line1\nline2', 'cr\rhere', 'nul\0here']) {
      assert.throws(() => escapeValue('X_TOKEN', bad), (e) => e.code === 'value_invalid_chars');
    }
    assert.equal(escapeValue('X_TOKEN', 'fine'), 'fine');
  });

  it('parses the app env file the way systemd does (unquoted, single, double, comments, later wins)', () => {
    const m = parseEnvFile('# c\n; c\nA=1\nB = two words \nC=\'lit $X \\n\'\nD="dq \\" \\$"\nexport E=e\nA=override\nbad line\n');
    assert.equal(m.get('A'), 'override');
    assert.equal(m.get('B'), 'two words');
    assert.equal(m.get('C'), 'lit $X \\n');
    assert.equal(m.get('D'), 'dq " $');
    assert.equal(m.get('E'), 'e');
    assert.equal(m.size, 5);
  });
});

describe('materialize: tmp + fsync + read-back + rename, never throws', () => {
  it('writes the file 0600 through a tmp in the same directory, keeps a .bak, fsyncs file and dir', () => {
    const dir = tmpDir();
    try {
      const file = path.join(dir, 'platform.env');
      const calls = [];
      const spy = new Proxy(fs, { get(t, k) { const f = t[k]; return typeof f === 'function' ? (...a) => { calls.push([k, a[0], a[1], a[2]]); return f.apply(t, a); } : f; } });
      const first = materialize({ entries: [{ name: 'A_TOKEN', value: 'one' }], path: file, fs: spy });
      assert.equal(first.applied, true, JSON.stringify(first));
      const second = materialize({ entries: [{ name: 'A_TOKEN', value: 'two$' }], path: file, fs: spy });
      assert.equal(second.applied, true);
      assert.equal(parseEnvFile(fs.readFileSync(file, 'utf8')).get('A_TOKEN'), 'two$');
      assert.equal(parseEnvFile(fs.readFileSync(`${file}.bak`, 'utf8')).get('A_TOKEN'), 'one');
      const tmpOpen = calls.find((c) => c[0] === 'openSync' && String(c[1]).includes('.tmp-'));
      assert.ok(tmpOpen, 'a tmp file is opened');
      assert.equal(path.dirname(tmpOpen[1]), dir, 'tmp lives in the same directory');
      assert.equal(tmpOpen[2], 'wx');
      assert.equal(tmpOpen[3], 0o600);
      const renames = calls.filter((c) => c[0] === 'renameSync');
      assert.ok(renames.length === 2 && renames.every((c) => String(c[1]).includes('.tmp-') && c[2] === file));
      const order = calls.map((c) => c[0]);
      assert.ok(order.indexOf('fsyncSync') < order.indexOf('renameSync'), 'fsync before rename');
      assert.ok(calls.some((c) => c[0] === 'openSync' && c[1] === dir), 'the directory is opened for fsync after rename');
      if (!isWin) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.deepEqual(fs.readdirSync(dir).sort(), ['platform.env', 'platform.env.bak'], 'no tmp left behind');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('an unwritable or missing directory → applied:false with a reason, no throw, no fallback path', () => {
    const denied = { ...fs, accessSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }, openSync: () => assert.fail('must not write anywhere') };
    assert.deepEqual(materialize({ entries: [{ name: 'A_TOKEN', value: 'x' }], path: '/var/lib/gatetest/unit-env/platform.env', fs: denied }),
      { path: '/var/lib/gatetest/unit-env/platform.env', count: 1, applied: false, reason: 'permission_denied' });
    const missing = materialize({ entries: [], path: path.join(os.tmpdir(), 'gt-no-such-dir-xyz', 'platform.env') });
    assert.equal(missing.applied, false);
    assert.equal(missing.reason, 'target-missing');
  });

  it('refuses to drop a key the caller did not name; allowRemoving lets exactly that key go', () => {
    const dir = tmpDir();
    try {
      const file = path.join(dir, 'platform.env');
      materialize({ entries: [{ name: 'A_TOKEN', value: 'a' }, { name: 'B_TOKEN', value: 'b' }], path: file });
      const refused = materialize({ entries: [{ name: 'A_TOKEN', value: 'a' }], path: file });
      assert.equal(refused.applied, false);
      assert.equal(refused.reason, 'would_drop_keys');
      assert.deepEqual(refused.dropped, ['B_TOKEN']);
      assert.ok(parseEnvFile(fs.readFileSync(file, 'utf8')).has('B_TOKEN'), 'file untouched');
      assert.equal(materialize({ entries: [{ name: 'A_TOKEN', value: 'a' }], path: file, allowRemoving: ['B_TOKEN'] }).applied, true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('a read-back mismatch aborts before rename and removes the tmp', () => {
    const dir = tmpDir();
    try {
      const file = path.join(dir, 'platform.env');
      const lying = { ...fs, readFileSync: (p, enc) => (String(p).includes('.tmp-') ? 'A_TOKEN="not what was written"\n' : fs.readFileSync(p, enc)) };
      const r = materialize({ entries: [{ name: 'A_TOKEN', value: 'real' }], path: file, fs: lying });
      assert.equal(r.applied, false);
      assert.equal(r.reason, 'readback_mismatch');
      assert.deepEqual(fs.readdirSync(dir), []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('a value with a newline is reported render_failed, not thrown', () => {
    const dir = tmpDir();
    try {
      const r = materialize({ entries: [{ name: 'A_TOKEN', value: 'x\ny' }], path: path.join(dir, 'platform.env') });
      assert.equal(r.applied, false);
      assert.equal(r.reason, 'render_failed: value_invalid_chars');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('shadow detector — which value wins at runtime', () => {
  const stored = fingerprint('from-the-store');
  it('store wins: runtime equals the stored value even though .env.local has another line', () => {
    const r = detectShadow({ name: 'A_TOKEN', storedFingerprint: stored, runtimeEnv: { A_TOKEN: 'from-the-store' }, appEnv: new Map([['A_TOKEN', 'old-line']]) });
    assert.equal(r.shadowed, false);
    assert.equal(r.source, 'both');
  });
  it('env wins: the raw .env.local line is what the process has → shadowed by app-env-file', () => {
    const r = detectShadow({ name: 'A_TOKEN', storedFingerprint: stored, runtimeEnv: { A_TOKEN: 'old-line' }, appEnv: new Map([['A_TOKEN', 'old-line']]) });
    assert.deepEqual([r.shadowed, r.shadowWinner], [true, 'app-env-file']);
  });
  it('a value from neither file wins → shadowed by process-env', () => {
    const r = detectShadow({ name: 'A_TOKEN', storedFingerprint: stored, runtimeEnv: { A_TOKEN: 'something-else' }, appEnv: new Map() });
    assert.deepEqual([r.shadowed, r.shadowWinner], [true, 'process-env']);
  });
  it('stored but not yet in the process is pending, not shadowed; unstored is never shadowed', () => {
    assert.equal(detectShadow({ name: 'A_TOKEN', storedFingerprint: stored, runtimeEnv: {}, appEnv: null }).shadowed, false);
    assert.equal(detectShadow({ name: 'A_TOKEN', storedFingerprint: null, runtimeEnv: { A_TOKEN: 'x' }, appEnv: null }).source, 'env');
  });
});

describe('liveness: three states, never throws', () => {
  const res = (status, body = '') => ({ status, text: async () => body });
  it('maps 200 → alive, 401 → dead, 500/429 → cannot-tell; unknown names → cannot-tell', async () => {
    const get = () => 'sk_' + 'live_abcdefghijklmnopqrstuvwxyz';
    assert.equal(await probeLiveness('STRIPE_SECRET_KEY', { get, fetch: async () => res(200) }), 'alive');
    assert.equal(await probeLiveness('STRIPE_SECRET_KEY', { get, fetch: async () => res(401) }), 'dead');
    assert.equal(await probeLiveness('STRIPE_SECRET_KEY', { get, fetch: async () => res(503) }), 'cannot-tell');
    assert.equal(await probeLiveness('STRIPE_SECRET_KEY', { get, fetch: async () => res(429) }), 'cannot-tell');
    assert.equal(await probeLiveness('CRON_SECRET', { get, fetch: async () => assert.fail('no probe') }), 'cannot-tell');
    assert.equal(await probeLiveness('SOME_CUSTOM_TOKEN', { get, fetch: async () => assert.fail('no probe') }), 'cannot-tell');
  });
  it('a hanging vendor → cannot-tell at the timeout; a throwing fetch or getter → cannot-tell', async () => {
    assert.equal(await probeLiveness('RESEND_API_KEY', { get: () => 're_' + 'abcdefghijklmnopqrst', fetch: () => new Promise(() => {}), timeoutMs: 50 }), 'cannot-tell');
    assert.equal(await probeLiveness('RESEND_API_KEY', { get: () => 're_x', fetch: async () => { throw new Error('ECONNRESET'); } }), 'cannot-tell');
    assert.equal(await probeLiveness('RESEND_API_KEY', { get: () => { throw new Error('boom'); }, fetch: async () => res(200) }), 'cannot-tell');
  });
  it('a sending-only Resend key is recognised as alive, a rejected one as dead', async () => {
    const get = () => 're_' + 'abcdefghijklmnopqrst';
    assert.equal(await probeLiveness('RESEND_API_KEY', { get, fetch: async () => res(401, '{"name":"restricted_api_key"}') }), 'alive');
    assert.equal(await probeLiveness('RESEND_API_KEY', { get, fetch: async () => res(401, '{"name":"validation_error"}') }), 'dead');
  });
  it('GitHub App: a real key signs a JWT (alive on 200); a non-key private key is dead without a call', async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).replace(/\n/g, '\\n');
    const values = { GATETEST_APP_ID: '12345', GATETEST_PRIVATE_KEY: pem };
    let auth = '';
    const ok = await probeLiveness('GATETEST_PRIVATE_KEY', { get: (n) => values[n], fetch: async (u, init) => { auth = init.headers.Authorization; return res(200); } });
    assert.equal(ok, 'alive');
    assert.match(auth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const dead = await probeLiveness('GATETEST_APP_ID', { get: (n) => ({ ...values, GATETEST_PRIVATE_KEY: 'not a key' })[n], fetch: async () => assert.fail('no call') });
    assert.equal(dead, 'dead');
  });
});

describe('step-up cookie', () => {
  const env = { GATETEST_ADMIN_PASSWORD: 'correct horse battery staple' };
  it('fresh → ok; missing, expired, forged → refused', () => {
    const key = stepUp.freshKey(env);
    const now = Date.UTC(2026, 8, 30, 12);
    const { token } = stepUp.mintFreshToken(key, now);
    assert.equal(stepUp.verifyFreshToken(token, key, now + 60_000).ok, true);
    assert.equal(stepUp.verifyFreshToken('', key, now).reason, 'missing');
    assert.equal(stepUp.verifyFreshToken(token, key, now + 16 * 60_000).reason, 'expired');
    assert.equal(stepUp.verifyFreshToken(token.replace(/.$/, (c) => (c === '0' ? '1' : '0')), key, now).reason, 'bad_signature');
    assert.equal(stepUp.verifyFreshToken(token, stepUp.freshKey({ GATETEST_ADMIN_PASSWORD: 'rotated' }), now).reason, 'bad_signature', 'a password change kills it');
  });
  it('the admin token (cookie / X-Admin-Token bytes) cannot mint a fresh cookie', () => {
    const adminToken = crypto.createHmac('sha256', env.GATETEST_ADMIN_PASSWORD).update('gatetest-admin-v1').digest('hex');
    const now = Date.UTC(2026, 8, 30, 9);
    const forged = stepUp.mintFreshToken(Buffer.from(adminToken), now).token;
    assert.equal(stepUp.verifyFreshToken(forged, stepUp.freshKey(env), now).reason, 'bad_signature');
  });
  it('cookie flags: HttpOnly, SameSite=Strict, scoped path, 15 min, Secure in production', () => {
    const h = stepUp.buildFreshCookieHeader('t', true);
    for (const f of ['gt_admin_fresh=t', 'HttpOnly', 'SameSite=Strict', 'Path=/api/admin', 'Max-Age=900', 'Secure']) assert.ok(h.includes(f), f);
    assert.ok(!stepUp.buildFreshCookieHeader('t', false).includes('Secure'));
  });
});

describe('panel flows (memory store, temp unit env file)', () => {
  const KEY = crypto.randomBytes(32).toString('base64');
  const WHO = { actor: 'admin', ip: '192.0.2.4' };
  function setup() {
    const adapter = createMemoryAdapter();
    const store = createSecretsStore({ adapter, env: { GATETEST_SECRETS_MASTER_KEY: KEY }, exampleFiles: [] });
    const dir = tmpDir();
    return { adapter, store, dir, file: path.join(dir, 'platform.env') };
  }
  it('listing: every catalogue name appears even when missing; custom names appended; no value anywhere', async () => {
    const { store, dir, file } = setup();
    try {
      const VALUE = 'custom-value-never-listed-123';
      await store.set('MY_CUSTOM_TOKEN', VALUE, WHO);
      const body = await panel.buildListing({ store, runtimeEnv: {}, appEnv: null, unitEnvFile: file });
      const names = body.items.map((i) => i.name);
      for (const n of ['DATABASE_URL', 'STRIPE_SECRET_KEY', 'GATETEST_SECRETS_MASTER_KEY']) assert.ok(names.includes(n), n);
      const custom = body.items.find((i) => i.name === 'MY_CUSTOM_TOKEN');
      assert.deepEqual([custom.tier, custom.state, custom.source, custom.liveness], ['custom', 'set', 'store', 'unchecked']);
      assert.equal(body.items.find((i) => i.name === 'DATABASE_URL').reserved, true);
      assert.equal(body.items.find((i) => i.name === 'STRIPE_SECRET_KEY').state, 'missing');
      assert.deepEqual(body.applyState, { lastAppliedAt: null, applied: false, reason: 'target-missing' });
      assert.ok(!JSON.stringify(body).includes(VALUE));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('apply renders the store; listing then reports applied; a delete whose apply failed is still dropped later', async () => {
    const { store, dir, file } = setup();
    try {
      await store.set('A_TOKEN', 'aaaa-aaaa-aaaa', WHO);
      await store.set('B_TOKEN', 'bbbb-bbbb-bbbb', WHO);
      const r = await panel.applyNow({ store, unitEnvFile: file, ctx: WHO });
      assert.deepEqual([r.applied, r.count], [true, 2]);
      const listed = await panel.buildListing({ store, runtimeEnv: {}, appEnv: null, unitEnvFile: file });
      assert.equal(listed.applyState.applied, true);
      await store.remove('B_TOKEN', WHO); // its own apply "failed" — nothing written
      const again = await panel.applyNow({ store, unitEnvFile: file, ctx: WHO });
      assert.equal(again.applied, true, JSON.stringify(again));
      assert.ok(!parseEnvFile(fs.readFileSync(file, 'utf8')).has('B_TOKEN'));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('verify persists liveness on the stored row; a store read failure is store_unavailable', async () => {
    const { store, adapter, dir, file } = setup();
    try {
      await store.set('STRIPE_SECRET_KEY', 'sk_' + 'live_abcdefghijklmnopqrstuv', WHO);
      const v = await panel.verifyOne({ store, name: 'STRIPE_SECRET_KEY', runtimeEnv: {}, fetch: async () => ({ status: 401, text: async () => '' }) });
      assert.deepEqual([v.liveness, v.persisted], ['dead', true]);
      assert.equal(adapter.rows.get('STRIPE_SECRET_KEY').liveness, 'dead');
      const broken = { ...store, readAll: async () => { throw Object.assign(new Error('x'), { name: 'DecryptFailed', code: 'decrypt_failed' }); } };
      assert.equal((await panel.applyNow({ store: broken, unitEnvFile: file, ctx: WHO })).reason, 'store_unavailable');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
