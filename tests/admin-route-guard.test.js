'use strict';
/**
 * The one admin gate — website/app/lib/admin-guard.ts requireAdminRoute().
 *
 * Two halves:
 *
 *  1. Behaviour. admin-guard.ts, admin-auth.ts and admin-session.ts are
 *     transpiled with the vendored `typescript` (the harness
 *     tests/gluecron-client-resolve-sha.test.js uses) and run for real;
 *     only `next/server` (NextResponse.json) and the csrfOk import are
 *     stood in for — csrfOk's stand-in calls the SAME checkSameOrigin +
 *     siteUrl() the real one does (pinned by source below).
 *
 *  2. Inventory. Every route file under website/app/api/admin/** and every
 *     admin-only route elsewhere calls requireAdminRoute as its first
 *     statement (same-origin on writes); the few that do not are an explicit
 *     allowlist with reasons. No file under website/app reads a cookie named
 *     `gatetest_admin` (three routes once passed ANY value of it — the real
 *     cookie is gt_admin) or a plaintext-password header, and no API route
 *     re-derives the admin HMAC for itself.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'website');
const LIB = path.join(WEB, 'app', 'lib');
const TS_COMPILER_PATH = path.join(WEB, 'node_modules', 'typescript', 'lib', 'typescript.js');
const read = (p) => fs.readFileSync(p, 'utf8');
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

// ─── harness ────────────────────────────────────────────────────────────────

function loadTs(file, mocks) {
  const ts = require(TS_COMPILER_PATH);
  const { outputText } = ts.transpileModule(read(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: file,
  });
  const m = new Module(file, module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  const realRequire = m.require.bind(m);
  m.require = (id) => (Object.prototype.hasOwnProperty.call(mocks, id) ? mocks[id] : realRequire(id));
  m._compile(outputText, file);
  return m.exports;
}

const fakeNextServer = {
  NextResponse: {
    json(body, init = {}) {
      return { body, status: init.status ?? 200, headers: { ...(init.headers || {}) } };
    },
  },
};

function fakeReq({ method = 'GET', cookies = {}, headers = {} } = {}) {
  return {
    method,
    headers: new Headers(headers),
    cookies: {
      get(name) {
        return Object.prototype.hasOwnProperty.call(cookies, name) ? { name, value: cookies[name] } : undefined;
      },
    },
  };
}

const ENV_KEYS = [
  'GATETEST_ADMIN_PASSWORD', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'NEXT_PUBLIC_BASE_URL',
  'GITHUB_OAUTH_REDIRECT_URI', 'SESSION_SECRET', 'GATETEST_ADMIN_USERNAMES',
];
const PASSWORD = 'route-guard-test-' + crypto.randomBytes(6).toString('hex');
const SESSION_SECRET = crypto.randomBytes(24).toString('hex');
const passwordToken = (pw) => crypto.createHmac('sha256', pw).update('gatetest-admin-v1').digest('hex');

let guard, session, saved;

before(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.GATETEST_ADMIN_PASSWORD = PASSWORD;
  process.env.GITHUB_CLIENT_ID = 'test-client';
  process.env.GITHUB_CLIENT_SECRET = 'test-secret';
  process.env.NEXT_PUBLIC_BASE_URL = 'https://gatetest.example';
  process.env.SESSION_SECRET = SESSION_SECRET;
  process.env.GATETEST_ADMIN_USERNAMES = 'owner-login';

  const policy = require(path.join(LIB, 'password-auth-policy.js'));
  const { siteUrl } = require(path.join(LIB, 'site-url.js'));
  // Same call as csrfOk() in app/lib/password-auth-http.ts (pinned below).
  const csrfOk = (req) => {
    const h = req.headers;
    return policy.checkSameOrigin({
      origin: h.get('origin'),
      secFetchSite: h.get('sec-fetch-site'),
      host: h.get('host'),
      forwardedHost: h.get('x-forwarded-host'),
      forwardedProto: h.get('x-forwarded-proto'),
    }, siteUrl()).ok;
  };
  const auth = loadTs(path.join(LIB, 'admin-auth.ts'), { 'next/server': fakeNextServer });
  session = loadTs(path.join(LIB, 'admin-session.ts'), { './admin-auth': auth });
  guard = loadTs(path.join(LIB, 'admin-guard.ts'), {
    'next/server': fakeNextServer,
    './admin-auth': auth,
    './admin-session': session,
    './password-auth-http': { csrfOk },
  });
});

after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ─── 1. behaviour ───────────────────────────────────────────────────────────

describe('requireAdminRoute — who gets in', () => {
  it('no credentials → 401 unauthorized, no-store', () => {
    const r = guard.requireAdminRoute(fakeReq());
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: 'unauthorized' });
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  it('a cookie merely NAMED gatetest_admin, any value → 401 (the presence-only hole)', () => {
    for (const value of ['1', 'anything', passwordToken(PASSWORD)]) {
      const r = guard.requireAdminRoute(fakeReq({ cookies: { gatetest_admin: value } }));
      assert.equal(r && r.status, 401, `gatetest_admin=${value.slice(0, 8)}… must not pass`);
    }
  });

  it('gt_admin with a wrong value → 401', () => {
    assert.equal(guard.requireAdminRoute(fakeReq({ cookies: { gt_admin: passwordToken('not-the-password') } })).status, 401);
  });

  it('gt_admin with the HMAC of the admin password → passes (GET)', () => {
    assert.equal(guard.requireAdminRoute(fakeReq({ cookies: { gt_admin: passwordToken(PASSWORD) } })), null);
  });

  it('X-Admin-Token with the same HMAC (server-to-server) → passes (GET)', () => {
    assert.equal(guard.requireAdminRoute(fakeReq({ headers: { 'x-admin-token': passwordToken(PASSWORD) } })), null);
  });

  it('the GitHub OAuth admin session on the allowlist → passes; off the allowlist → 401', () => {
    const ok = session.signSession('owner-login', SESSION_SECRET);
    assert.equal(guard.requireAdminRoute(fakeReq({ cookies: { gatetest_admin_session: ok } })), null);
    const stranger = session.signSession('someone-else', SESSION_SECRET);
    assert.equal(guard.requireAdminRoute(fakeReq({ cookies: { gatetest_admin_session: stranger } })).status, 401);
    const forged = session.signSession('owner-login', 'wrong-secret');
    assert.equal(guard.requireAdminRoute(fakeReq({ cookies: { gatetest_admin_session: forged } })).status, 401);
  });

  it('with GATETEST_ADMIN_PASSWORD unset, the password cookie opens nothing', () => {
    const cookie = passwordToken(PASSWORD);
    delete process.env.GATETEST_ADMIN_PASSWORD;
    try {
      assert.equal(guard.requireAdminRoute(fakeReq({ cookies: { gt_admin: cookie } })).status, 401);
    } finally {
      process.env.GATETEST_ADMIN_PASSWORD = PASSWORD;
    }
  });
});

describe('requireAdminRoute — writes must be same-origin', () => {
  const admin = () => ({ gt_admin: passwordToken(PASSWORD) });

  it('POST from this site (sec-fetch-site: same-origin) → passes', () => {
    const req = fakeReq({ method: 'POST', cookies: admin(), headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(guard.requireAdminRoute(req, { mutating: true }), null);
  });

  it('POST with a matching Origin and no sec-fetch-site → passes', () => {
    const req = fakeReq({ method: 'POST', cookies: admin(), headers: { origin: 'https://gatetest.example', host: 'gatetest.example' } });
    assert.equal(guard.requireAdminRoute(req, { mutating: true }), null);
  });

  it('POST from another site → 403 cross_origin, no-store', () => {
    const req = fakeReq({ method: 'POST', cookies: admin(), headers: { 'sec-fetch-site': 'cross-site' } });
    const r = guard.requireAdminRoute(req, { mutating: true });
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { error: 'cross_origin' });
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  it('POST with no origin evidence at all → 403', () => {
    const req = fakeReq({ method: 'POST', cookies: admin() });
    assert.equal(guard.requireAdminRoute(req, { mutating: true }).status, 403);
  });

  it('the method decides when `mutating` is left out: DELETE cross-site → 403, GET cross-site → passes', () => {
    const del = fakeReq({ method: 'DELETE', cookies: admin(), headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(guard.requireAdminRoute(del).status, 403);
    const get = fakeReq({ method: 'GET', cookies: admin(), headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(guard.requireAdminRoute(get), null);
  });

  it('a GET that spends money opts in: { mutating: true } refuses a cross-site GET', () => {
    const get = fakeReq({ method: 'GET', cookies: admin(), headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(guard.requireAdminRoute(get, { mutating: true }).status, 403);
  });

  it('an explicit { mutating: false } is honoured (the secrets gate passes its own flag through)', () => {
    const post = fakeReq({ method: 'POST', cookies: admin(), headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(guard.requireAdminRoute(post, { mutating: false }), null);
  });

  it('401 wins over 403: a cross-site write with no credentials is unauthorized', () => {
    const req = fakeReq({ method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(guard.requireAdminRoute(req, { mutating: true }).status, 401);
  });
});

describe('adminLoginOf', () => {
  it('names the OAuth login, else "admin"', () => {
    const ok = session.signSession('owner-login', SESSION_SECRET);
    assert.equal(guard.adminLoginOf(fakeReq({ cookies: { gatetest_admin_session: ok } })), 'owner-login');
    assert.equal(guard.adminLoginOf(fakeReq({ cookies: { gt_admin: passwordToken(PASSWORD) } })), 'admin');
  });
});

describe('the csrfOk stand-in mirrors the real one', () => {
  it('password-auth-http.ts csrfOk is checkSameOrigin(headers, siteUrl())', () => {
    const src = read(path.join(LIB, 'password-auth-http.ts'));
    assert.match(src, /export function csrfOk\(req: NextRequest\): boolean \{\s*const h = req\.headers;\s*return checkSameOrigin\(\s*\{\s*origin: h\.get\("origin"\),\s*secFetchSite: h\.get\("sec-fetch-site"\),\s*host: h\.get\("host"\),\s*forwardedHost: h\.get\("x-forwarded-host"\),\s*forwardedProto: h\.get\("x-forwarded-proto"\),\s*\},\s*siteUrl\(\)\s*\)\.ok;/);
  });
});

// ─── 2. inventory ───────────────────────────────────────────────────────────

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

const ADMIN_API = path.join(WEB, 'app', 'api', 'admin');
const ADMIN_ROUTES = walk(ADMIN_API).filter((f) => /route\.(ts|tsx|js)$/.test(f));

/** Admin-only routes that live outside app/api/admin. */
const EXTRA_ADMIN_ROUTES = [
  'website/app/api/watches/route.ts',
  'website/app/api/db/init/route.ts',
  'website/app/api/dissent/route.ts',
  'website/app/api/dashboard/intelligence/route.ts',
  'website/app/api/scan/history/route.ts',
  'website/app/api/heal/ssh/route.ts',
];

/**
 * Route files under app/api/admin that do NOT call requireAdminRoute
 * directly — each with the reason. A new file must either use the gate or
 * be added here with a reason a reviewer can check.
 */
const ALLOWLIST = new Map([
  ['website/app/api/admin/auth/route.ts', 'the login route itself: POST verifies the password (with lockout) and sets gt_admin; DELETE clears it'],
  ['website/app/api/admin/learning/cron/route.ts', 'a cron trigger, gated by the CRON_SECRET bearer — the caller is a machine with no admin session'],
  ['website/app/api/admin/step-up/route.ts', 'secrets panel: requireAdmin() from lib/secrets/http.ts, which delegates to requireAdminRoute (asserted below)'],
  ['website/app/api/admin/secrets/route.ts', 'secrets panel: lib/secrets/http.ts requireAdmin() → requireAdminRoute'],
  ['website/app/api/admin/secrets/audit/route.ts', 'secrets panel: lib/secrets/http.ts requireAdmin() → requireAdminRoute'],
  ['website/app/api/admin/secrets/apply/route.ts', 'secrets panel: lib/secrets/http.ts requireAdmin() → requireAdminRoute (+ step-up)'],
  ['website/app/api/admin/secrets/[name]/route.ts', 'secrets panel: lib/secrets/http.ts requireAdmin() → requireAdminRoute (+ step-up)'],
  ['website/app/api/admin/secrets/[name]/reveal/route.ts', 'secrets panel: lib/secrets/http.ts requireAdmin() → requireAdminRoute (+ step-up)'],
  ['website/app/api/admin/secrets/[name]/verify/route.ts', 'secrets panel: lib/secrets/http.ts requireAdmin() → requireAdminRoute'],
]);

function handlers(src) {
  const out = [];
  const re = /export async function (GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\(([^)]*)\)[^{]*\{\n/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    const body = src.slice(start).split(/\nexport /)[0];
    out.push({ method: m[1], params: m[2], body });
  }
  return out;
}

describe('every admin API route goes through requireAdminRoute', () => {
  it('finds the admin route tree (anti-vacuity)', () => {
    assert.ok(ADMIN_ROUTES.length >= 30, `only ${ADMIN_ROUTES.length} admin route files found`);
  });

  it('the allowlist names only files that exist, and each has a reason', () => {
    for (const [file, reason] of ALLOWLIST) {
      assert.ok(fs.existsSync(path.join(ROOT, file)), `allowlisted file is gone: ${file} — drop it from the allowlist`);
      assert.ok(reason.length > 20, `${file}: give a reason`);
    }
  });

  it('the secrets gate delegates to requireAdminRoute', () => {
    const http = read(path.join(LIB, 'secrets', 'http.ts'));
    assert.match(http, /import \{ requireAdminRoute \} from "@\/app\/lib\/admin-guard"/);
    assert.match(http, /const refused = requireAdminRoute\(req, \{ mutating: Boolean\(opts\.mutating\) \}\);\s*if \(refused\) return refused;/);
    for (const [file, reason] of ALLOWLIST) {
      if (!reason.startsWith('secrets panel')) continue;
      assert.match(read(path.join(ROOT, file)), /from "@\/app\/lib\/secrets\/http"/, `${file} must use the secrets gate`);
    }
  });

  const guarded = [
    ...ADMIN_ROUTES.map(rel).filter((f) => !ALLOWLIST.has(f)),
    ...EXTRA_ADMIN_ROUTES,
  ];
  for (const file of guarded) {
    it(`${file}: every handler starts with requireAdminRoute (same-origin on writes)`, () => {
      const src = stripComments(read(path.join(ROOT, file)));
      assert.match(src, /import \{[^}]*\brequireAdminRoute\b[^}]*\} from "@\/app\/lib\/admin-guard"/, 'imports the gate');
      const hs = handlers(src);
      assert.ok(hs.length > 0, 'at least one exported handler');
      for (const h of hs) {
        assert.match(h.params, /^req: NextRequest$/, `${h.method}: takes (req: NextRequest)`);
        const first = h.body.replace(/^\s*try \{\s*/, '').trim().split('\n')[0].trim();
        assert.match(first, /^const refused = requireAdminRoute\(req(, \{ mutating: true \})?\);$/, `${h.method}: the gate is the first statement, got: ${first}`);
        if (!['GET', 'HEAD', 'OPTIONS'].includes(h.method)) {
          assert.match(first, /\{ mutating: true \}/, `${h.method}: writes run the same-origin check`);
        }
        const second = h.body.replace(/^\s*try \{\s*/, '').trim().split('\n')[1].trim();
        assert.equal(second, 'if (refused) return refused;', `${h.method}: the refusal is returned`);
      }
    });
  }

  it('no API route keeps its own copy of the admin check', () => {
    const offenders = walk(path.join(WEB, 'app', 'api'))
      .filter((f) => /\.(ts|tsx|js)$/.test(f))
      .filter((f) => /gatetest-admin-v1|function (isAuthenticatedAdmin|checkPwCookie|checkPasswordCookie)\b/.test(read(f)))
      .map(rel);
    assert.deepEqual(offenders, [], 'the admin HMAC is derived only in lib/admin-auth.ts and lib/admin-session.ts');
  });
});

describe('no legacy admin credentials anywhere under website/app', () => {
  const files = walk(path.join(WEB, 'app')).filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f));

  it('scans the app tree (anti-vacuity)', () => {
    assert.ok(files.length > 200, `only ${files.length} files`);
  });

  it('nothing reads a cookie named gatetest_admin', () => {
    const offenders = files.filter((f) => /cookies\.get\(\s*["'`]gatetest_admin["'`]\s*\)/.test(read(f))).map(rel);
    assert.deepEqual(offenders, []);
    assert.ok(/cookies\.get\(\s*["'`]gatetest_admin["'`]\s*\)/.test('req.cookies.get("gatetest_admin")'), 'positive control');
  });

  it('nothing sends or reads a plaintext-password header', () => {
    const offenders = files.filter((f) => /x-admin-password/i.test(read(f))).map(rel);
    assert.deepEqual(offenders, []);
  });
});
