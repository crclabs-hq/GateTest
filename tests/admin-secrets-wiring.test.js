'use strict';
/**
 * Admin secrets panel — source-level wiring guards, the env catalogue drift
 * check, the systemd exposure guard and the box-side scripts' pure plans.
 *
 * Route files are compiled by Next, so their wiring is pinned by source, the
 * same way tests/status-readiness-honesty.test.js pins /api/status. Every
 * guard has a positive control so a vacuous match cannot pass.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'website');
const read = (p) => fs.readFileSync(p, 'utf8');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.next') continue;
      walk(p, out);
    } else out.push(p);
  }
  return out;
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^[ \t]*\/\/[^\n]*/gm, '')
    .replace(/([;{}(,)])[ \t]*\/\/[^\n]*/g, '$1');
}

const ROUTE_DIRS = [path.join(WEB, 'app', 'api', 'admin', 'secrets'), path.join(WEB, 'app', 'api', 'admin', 'step-up')];
const ROUTES = ROUTE_DIRS.flatMap((d) => walk(d)).filter((f) => f.endsWith('route.ts'));
const HTTP = read(path.join(WEB, 'app', 'lib', 'secrets', 'http.ts'));

describe('every secrets route is admin-gated, same-origin checked when mutating, and no-store', () => {
  it('finds all seven route files (anti-vacuity)', () => {
    assert.equal(ROUTES.length, 7, ROUTES.join('\n'));
  });

  it('the shared guard checks the admin session first and every answer is no-store', () => {
    assert.match(HTTP, /export function requireAdmin\([\s\S]*?if \(!isAdminRequest\(req\) && !getAdminLoginFromCookies\(req\.cookies\)\) return noStoreJson\(\{ error: "unauthorized" \}, 401\)/);
    assert.match(HTTP, /opts\.mutating && !csrfOk\(req\)/);
    assert.match(HTTP, /opts\.fresh[\s\S]*?verifyFreshToken\(/);
    assert.match(HTTP, /"cache-control": "no-store"/);
    assert.match(HTTP, /NextResponse\.json\(body, \{ status, headers: \{ \.\.\.NO_STORE_HEADERS/);
  });

  for (const file of ROUTES) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const src = stripComments(read(file));
    it(`${rel}: each handler calls requireAdmin() first and answers only through noStoreJson`, () => {
      const handlers = [...src.matchAll(/export async function (GET|POST|PUT|DELETE|PATCH)\(/g)].map((m) => m[1]);
      assert.ok(handlers.length > 0, 'at least one handler');
      for (const h of handlers) {
        const body = src.slice(src.indexOf(`export async function ${h}(`)).split(/\nexport /)[0];
        const sig = /\)\s*\{\s*\n/.exec(body);
        const firstStmt = body.slice(sig.index + sig[0].length).trim().split('\n')[0];
        assert.match(firstStmt, /const refused = requireAdmin\(req/, `${h} must start with requireAdmin()`);
        if (h !== 'GET') assert.match(firstStmt, /mutating: true/, `${h} must run the same-origin check`);
      }
      assert.doesNotMatch(src, /NextResponse\.json\(|new Response\(/, 'no response bypasses noStoreJson');
      assert.doesNotMatch(src, /console\./, 'no console output in a secrets route');
    });
  }

  it('set, delete, reveal and apply require step-up; list, verify, audit and step-up itself do not', () => {
    const fresh = (rel) => read(path.join(WEB, 'app', 'api', 'admin', ...rel.split('/'), 'route.ts')).match(/requireAdmin\(req, \{[^}]*fresh: true/g) || [];
    assert.equal(fresh('secrets/[name]').length, 2, 'PUT and DELETE');
    assert.equal(fresh('secrets/[name]/reveal').length, 1);
    assert.equal(fresh('secrets/apply').length, 1);
    assert.equal(fresh('secrets').length, 0);
    assert.equal(fresh('secrets/[name]/verify').length, 0);
    assert.equal(fresh('secrets/audit').length, 0);
    assert.equal(fresh('step-up').length, 0);
  });

  it('only the step-up route mints the fresh cookie, and only after verifyAdminPassword', () => {
    const minters = walk(path.join(WEB, 'app'))
      .filter((f) => /\.(tsx?|jsx?)$/.test(f))
      .filter((f) => { const raw = read(f); return raw.includes('mintFreshToken(') && /mintFreshToken\(/.test(stripComments(raw)); })
      .map((f) => path.relative(WEB, f).split(path.sep).join('/'));
    assert.deepEqual(minters.sort(), ['app/api/admin/step-up/route.ts', 'app/lib/secrets/step-up.js']);
    const src = stripComments(read(path.join(WEB, 'app', 'api', 'admin', 'step-up', 'route.ts')));
    assert.ok(src.indexOf('verifyAdminPassword(password)') > 0 && src.indexOf('verifyAdminPassword(password)') < src.indexOf('mintFreshToken('));
    assert.ok(src.indexOf('stepUpAttempts(') < src.indexOf('verifyAdminPassword('), 'the DB throttle runs before the password compare');
  });
});

describe('no console line in the secrets code names a value', () => {
  const files = [
    ...walk(path.join(WEB, 'app', 'lib', 'secrets')),
    ...ROUTES,
    path.join(ROOT, 'scripts', 'ops', 'secrets-import-env.js'),
    path.join(ROOT, 'scripts', 'ops', 'secrets-rekey.js'),
    path.join(ROOT, 'scripts', 'ops', 'secrets-common.js'),
  ];
  it('library and route files have no console.* at all; scripts print names, fingerprints and outcomes only', () => {
    let scriptLines = 0;
    for (const f of files) {
      const lines = stripComments(read(f)).split('\n').filter((l) => /console\.\w+\(/.test(l));
      if (!f.includes(`${path.sep}scripts${path.sep}`)) {
        assert.deepEqual(lines, [], `${f} must not write to the console`);
        continue;
      }
      scriptLines += lines.length;
      for (const l of lines) {
        assert.doesNotMatch(l, /\b(value|plain|plaintext|ciphertext|password|secret|appEnv\.get|key|writeKey|MASTER_KEY)\b/i, `console line may leak: ${l.trim()}`);
      }
    }
    assert.ok(scriptLines >= 4, 'control: the scripts do print their progress');
  });
});

describe('env catalogue drift — every process.env read is catalogued or ignored with a reason', () => {
  const catalogue = require(path.join(WEB, 'app', 'lib', 'env-catalogue.js'));
  const known = new Set([
    ...catalogue.REQUIRED.map((v) => v.name), ...catalogue.IMPORTANT.map((v) => v.name), ...catalogue.OPTIONAL,
    ...Object.values(catalogue.ALIASES).flat(),
  ]);
  const ignored = new Set(catalogue.IGNORED.flatMap((g) => g.names));

  let cached = null;
  function reads() {
    if (cached) return cached;
    const out = new Map();
    cached = out;
    for (const f of [...walk(path.join(WEB, 'app')), ...walk(path.join(ROOT, 'src'))]) {
      if (!/\.(ts|tsx|js|mjs|cjs)$/.test(f)) continue;
      const raw = read(f);
      if (!raw.includes('process.env')) continue;
      const src = stripComments(raw);
      for (const m of src.matchAll(/process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\])/g)) {
        const n = m[1] || m[2];
        if (!out.has(n)) out.set(n, path.relative(ROOT, f));
      }
    }
    return out;
  }

  it('no uncatalogued read', () => {
    const found = reads();
    assert.ok(found.size > 50, 'control: the walk sees the codebase');
    const missing = [...found].filter(([n]) => !known.has(n) && !ignored.has(n)).map(([n, f]) => `${n} (${f})`);
    assert.deepEqual(missing, [], 'add these to REQUIRED/IMPORTANT/OPTIONAL with a why, or to IGNORED with a reason');
  });

  it('every OPTIONAL name has a why; every IGNORED group has a reason and no stale name', () => {
    for (const n of catalogue.OPTIONAL) assert.ok(catalogue.OPTIONAL_WHY[n], `OPTIONAL ${n} needs a why`);
    const found = reads();
    for (const g of catalogue.IGNORED) {
      assert.ok(g.reason && g.reason.length > 20);
      for (const n of g.names) {
        assert.ok(!known.has(n), `${n} is both catalogued and ignored`);
        assert.ok(found.has(n) || n === 'GATETEST_UNIT_ENV_PATH' || n === 'GATETEST_APP_ENV_PATH', `${n} is ignored but no longer read`);
      }
    }
  });

  it('the drift check fires on a planted read (positive control)', () => {
    assert.ok(!known.has('GATETEST_PLANTED_DRIFT_PROBE') && !ignored.has('GATETEST_PLANTED_DRIFT_PROBE'));
  });
});

describe('systemd: credentials only via EnvironmentFile, and the store file is the web unit\'s last', () => {
  const UNIT_DIR = path.join(ROOT, 'scripts', 'deploy', 'systemd');
  const units = fs.readdirSync(UNIT_DIR).filter((f) => /\.(service|path|timer)$/.test(f));
  const CRED = /(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY|MASTER_KEY|DATABASE_URL)/i;

  it('no unit puts a credential-looking variable in Environment= (systemctl show exposes those to every local user)', () => {
    let envLines = 0;
    for (const u of units) {
      for (const line of read(path.join(UNIT_DIR, u)).split('\n')) {
        const m = /^\s*Environment=(.*)$/.exec(line);
        if (!m) continue;
        envLines += 1;
        for (const assign of m[1].split(/\s+/)) {
          const name = assign.replace(/^"/, '').split('=')[0];
          assert.doesNotMatch(name, CRED, `${u}: ${name} must come from an EnvironmentFile`);
        }
      }
    }
    assert.ok(envLines >= 1, 'control: Environment=PORT=%i is seen');
    assert.match('Environment=STRIPE_SECRET_KEY=x'.split('=')[1], CRED, 'control: the pattern catches a credential name');
  });

  it('gatetest-web@.service loads platform.env as its LAST EnvironmentFile', () => {
    const lines = read(path.join(UNIT_DIR, 'gatetest-web@.service')).split('\n').filter((l) => /^EnvironmentFile=/.test(l));
    assert.equal(lines[lines.length - 1], 'EnvironmentFile=-/var/lib/gatetest/unit-env/platform.env');
    assert.ok(lines.length >= 2, 'the app env file still loads first');
  });

  it('only the web template references the unit-env dir, except to hide it (InaccessiblePaths=)', () => {
    for (const u of units) {
      const src = read(path.join(UNIT_DIR, u));
      const refs = src.split('\n').filter((l) => !/^\s*#/.test(l) && l.includes('/var/lib/gatetest/unit-env'));
      for (const l of refs) {
        const allowed = (u === 'gatetest-web@.service' && /^EnvironmentFile=-/.test(l))
          || (u === 'gatetest-secrets-apply.path' && /^PathChanged=/.test(l))
          || /^InaccessiblePaths=-\/var\/lib\/gatetest\/unit-env$/.test(l);
        assert.ok(allowed, `${u}: ${l}`);
      }
      if (u.endsWith('.service') && u !== 'gatetest-web@.service') {
        assert.match(src, /^InaccessiblePaths=-\/var\/lib\/gatetest\/unit-env$/m, `${u} must hide the rendered secrets`);
      }
    }
  });
});

describe('box scripts: plans print names and fingerprints only', () => {
  const { planImport } = require(path.join(ROOT, 'scripts', 'ops', 'secrets-import-env.js'));
  const { planRekey } = require(path.join(ROOT, 'scripts', 'ops', 'secrets-rekey.js'));
  const sc = require(path.join(WEB, 'app', 'lib', 'secrets', 'crypto.js'));

  it('import: catalogue names only; reserved, filler and unchanged are skipped; differing kept unless OVERWRITE', () => {
    const app = new Map([
      ['STRIPE_SECRET_KEY', 'sk_' + 'live_abcdefghijklmnopqrstuvwx'],
      ['SESSION_SECRET', 'a-real-looking-session-secret-123'],
      ['RESEND_API_KEY', 'changeme'],
      ['CRON_SECRET', 'cron-secret-value-1234567'],
      ['NOT_IN_CATALOGUE', 'whatever-123456'],
      ['GITHUB_CLIENT_ID', 'Iv1.abcdef123456'],
    ]);
    const stored = [{ name: 'CRON_SECRET', fingerprint: sc.fingerprint('cron-secret-value-1234567') }, { name: 'GITHUB_CLIENT_ID', fingerprint: 'deadbeef' }];
    const plan = Object.fromEntries(planImport(app, stored).map((p) => [p.name, p.action]));
    assert.deepEqual(plan, {
      STRIPE_SECRET_KEY: 'import', SESSION_SECRET: 'skip-reserved', RESEND_API_KEY: 'skip-placeholder',
      CRON_SECRET: 'unchanged', GITHUB_CLIENT_ID: 'differs-kept',
    });
    assert.equal(planImport(app, stored, { overwrite: true }).find((p) => p.name === 'GITHUB_CLIENT_ID').action, 'import');
    assert.ok(planImport(app, stored).every((p) => /^[0-9a-f]{8}$/.test(p.fingerprint) && !('value' in p)));
  });

  it('rekey: rows off the write key are planned; rows on it are not; an unloaded key is flagged', () => {
    const oldKey = crypto.randomBytes(32).toString('base64');
    const newKey = crypto.randomBytes(32).toString('base64');
    const ring = sc.loadKeyring({ GATETEST_SECRETS_MASTER_KEY: oldKey, GATETEST_SECRETS_MASTER_KEY_NEXT: newKey }, { exampleFiles: [] });
    const rows = [
      { name: 'A_TOKEN', keyVersion: ring.currentVersion },
      { name: 'B_TOKEN', keyVersion: ring.nextVersion },
      { name: 'C_TOKEN', keyVersion: 'v1:0000000000000000' },
    ];
    assert.deepEqual(planRekey(rows, ring), [
      { name: 'A_TOKEN', from: ring.currentVersion, loaded: true },
      { name: 'C_TOKEN', from: 'v1:0000000000000000', loaded: false },
    ]);
  });

  it('rekey: re-encrypts onto the write key, readable with NEXT alone; a row changed meanwhile is not overwritten', async () => {
    const { rekeyOne } = require(path.join(ROOT, 'scripts', 'ops', 'secrets-rekey.js'));
    const { createMemoryAdapter } = require('./helpers/secrets-memory-adapter');
    const oldKey = crypto.randomBytes(32).toString('base64');
    const newKey = crypto.randomBytes(32).toString('base64');
    const oldRing = sc.loadKeyring({ GATETEST_SECRETS_MASTER_KEY: oldKey }, { exampleFiles: [] });
    const ring = sc.loadKeyring({ GATETEST_SECRETS_MASTER_KEY: oldKey, GATETEST_SECRETS_MASTER_KEY_NEXT: newKey }, { exampleFiles: [] });
    const adapter = createMemoryAdapter();
    for (const n of ['A_TOKEN', 'B_TOKEN']) {
      await adapter.upsertSecret({ name: n, ...sc.encrypt(oldRing, n, `${n}-plain-1234`), fingerprint: sc.fingerprint(`${n}-plain-1234`) });
    }
    const [a, b] = planRekey(await adapter.listSecrets(), ring);
    assert.equal(await rekeyOne(adapter, ring, a), 'rekeyed');
    const onlyNew = sc.loadKeyring({ GATETEST_SECRETS_MASTER_KEY: newKey }, { exampleFiles: [] });
    assert.equal(sc.decrypt(onlyNew, 'A_TOKEN', await adapter.getSecret('A_TOKEN')), 'A_TOKEN-plain-1234');
    await adapter.upsertSecret({ name: 'B_TOKEN', ...sc.encrypt(ring, 'B_TOKEN', 'edited-meanwhile-99'), fingerprint: 'x' });
    assert.equal(await rekeyOne(adapter, ring, b), 'changed-concurrently');
    assert.deepEqual(planRekey(await adapter.listSecrets(), ring), [], 'a second run finds nothing left');
  });
});
