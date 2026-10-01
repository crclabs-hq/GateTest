'use strict';
/**
 * The admin panel must never report success for a call that failed, and
 * never show "healthy" / "empty" for a read that failed (CLAUDE.md
 * ENGINEERING DOCTRINE 1: ok / found / NOT CHECKED — print the third).
 *
 * Ten defects, one block each. Pure logic (tick auth, compliance-status,
 * admin-platforms, the tallrig route, the feed's backoff) is transpiled with
 * the vendored `typescript` (the harness tests/admin-route-guard.test.js
 * uses) and run for real against stand-ins for the DB / store. The client
 * components are pinned by source contract: each assertion names the exact
 * shape the old file had and the new one must not.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'website');
const APP = path.join(WEB, 'app');
const LIB = path.join(APP, 'lib');
const TS_COMPILER_PATH = path.join(WEB, 'node_modules', 'typescript', 'lib', 'typescript.js');
const read = (p) => fs.readFileSync(p, 'utf8');
const app = (rel) => path.join(APP, rel);

// ─── harness ────────────────────────────────────────────────────────────────

function loadTs(file, mocks) {
  const ts = require(TS_COMPILER_PATH);
  const { outputText } = ts.transpileModule(read(file), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
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

/** A tagged-template stand-in for the Neon client. `route(text)` answers each query. */
function fakeSql(route) {
  return async (strings) => route(strings.join('?').replace(/\s+/g, ' ').trim());
}

// ─── 1. Run Tick Now — the admin session may run a tick ─────────────────────

describe('1. /api/watches/tick accepts the admin session as well as CRON_SECRET', () => {
  const ENV_KEYS = [
    'GATETEST_ADMIN_PASSWORD', 'CRON_SECRET', 'NODE_ENV', 'NEXT_PUBLIC_BASE_URL', 'SESSION_SECRET',
    'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GATETEST_ADMIN_USERNAMES', 'GATETEST_ADMIN_EMAILS',
  ];
  const PASSWORD = 'tick-test-' + crypto.randomBytes(6).toString('hex');
  const CRON = 'cron-' + crypto.randomBytes(8).toString('hex');
  const adminCookie = crypto.createHmac('sha256', PASSWORD).update('gatetest-admin-v1').digest('hex');
  let route, saved;

  before(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.GATETEST_ADMIN_PASSWORD = PASSWORD;
    process.env.CRON_SECRET = CRON;
    process.env.NODE_ENV = 'test'; // never "development" — that branch authorises everything
    process.env.NEXT_PUBLIC_BASE_URL = 'https://gatetest.example';
    process.env.SESSION_SECRET = crypto.randomBytes(24).toString('hex');
    process.env.GITHUB_CLIENT_ID = 'test-client';
    process.env.GITHUB_CLIENT_SECRET = 'test-secret';
    delete process.env.GATETEST_ADMIN_USERNAMES;
    delete process.env.GATETEST_ADMIN_EMAILS;

    // The real admin gate, wired exactly as tests/admin-route-guard.test.js does.
    const policy = require(path.join(LIB, 'password-auth-policy.js'));
    const { siteUrl } = require(path.join(LIB, 'site-url.js'));
    const csrfOk = (req) => {
      const h = req.headers;
      return policy.checkSameOrigin({
        origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site'), host: h.get('host'),
        forwardedHost: h.get('x-forwarded-host'), forwardedProto: h.get('x-forwarded-proto'),
      }, siteUrl()).ok;
    };
    const auth = loadTs(path.join(LIB, 'admin-auth.ts'), { 'next/server': fakeNextServer });
    const allowlist = loadTs(path.join(LIB, 'admin-allowlist.ts'), {});
    const customerSession = loadTs(path.join(LIB, 'customer-session.ts'), {});
    const session = loadTs(path.join(LIB, 'admin-session.ts'), {
      './admin-auth': auth, './admin-allowlist': allowlist, './customer-session': customerSession,
    });
    const guard = loadTs(path.join(LIB, 'admin-guard.ts'), {
      'next/server': fakeNextServer, './admin-auth': auth, './admin-session': session,
      './password-auth-http': { csrfOk },
    });

    route = loadTs(app('api/watches/tick/route.ts'), {
      'next/server': fakeNextServer,
      '../../../lib/db': { getDb: () => fakeSql(() => []) }, // no watches due
      '../../../lib/admin-auth': auth,
      '@/app/lib/admin-guard': guard,
      '@/app/lib/site-url': { SITE_URL: 'https://gatetest.example' },
      '@/app/lib/engine-models': { CHEAP_MODEL: 'cheap-model' },
      '@/app/lib/anthropic-config': { apiUrl: () => 'http://127.0.0.1:9/never', apiVersion: () => 'x' },
      '@/app/lib/server-spend-guard': {
        checkServerSpend: async () => ({ allowed: false, spentMicros: 0, ceilingMicros: 0, reason: 'test' }),
        recordServerSpend: async () => ({ recorded: false }),
      },
      '@/app/lib/watchdog-intelligence': { detectAnomalies: () => [], diagnoseWatchEvent: async () => ({ ok: false }) },
    });
  });

  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('the scheduler bearer still runs the tick (unchanged)', async () => {
    const r = await route.GET(fakeReq({ headers: { authorization: `Bearer ${CRON}` } }));
    assert.equal(r.status, 200);
    assert.equal(r.body.checked, 0);
  });

  it('the admin cookie from the admin panel (same-origin POST) runs the tick — was a 401', async () => {
    const r = await route.POST(fakeReq({
      method: 'POST', cookies: { gt_admin: adminCookie }, headers: { 'sec-fetch-site': 'same-origin' },
    }));
    assert.equal(r.status, 200, `admin "Run Tick Now" must run the tick, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.checked, 0);
  });

  it('no credentials → 401; wrong bearer → 401', async () => {
    assert.equal((await route.GET(fakeReq())).status, 401);
    assert.equal((await route.GET(fakeReq({ headers: { authorization: 'Bearer nope' } }))).status, 401);
  });

  it('the admin cookie from another site → 403 (a tick spends budget, so writes are same-origin)', async () => {
    const r = await route.POST(fakeReq({
      method: 'POST', cookies: { gt_admin: adminCookie }, headers: { 'sec-fetch-site': 'cross-site' },
    }));
    assert.equal(r.status, 403);
  });

  it('the button reports the real result or the real error, never "complete" on a non-ok response', () => {
    const src = read(app('admin/tabs/WatchdogTab.tsx'));
    assert.ok(!/Tick complete/.test(src), 'the old alert said "Tick complete" whatever the status was');
    assert.match(src, /fetch\("\/api\/watches\/tick", \{ method: "POST" \}\)/);
    const body = src.slice(src.indexOf('async function runTick'));
    const okCheck = body.indexOf('if (!res.ok)');
    const success = body.indexOf('Tick ran');
    assert.ok(okCheck !== -1 && success !== -1 && okCheck < success, 'res.ok is checked before success is reported');
    assert.match(body, /Tick failed — \$\{httpFailure\(res, data\)\}/);
  });

  it('the daily spend guard still gates the tick\'s diagnosis call', () => {
    const src = read(app('api/watches/tick/route.ts'));
    assert.match(src, /const spendCheck = await checkServerSpend\(\{ sql \}\);\s*if \(!spendCheck\.allowed\)/);
  });
});

// ─── 2. Scan & Fix checks the scan and fix responses ────────────────────────

describe('2. WatchdogPanel Scan & Fix shows a failed scan as a failure', () => {
  const src = read(app('admin/tabs/WatchdogPanel.tsx'));
  it('checks scanRes.ok before reading totalIssues, and fixRes.ok before reporting done', () => {
    const scanOk = src.indexOf('if (!scanRes.ok)');
    const issues = src.indexOf('const issues =');
    assert.ok(scanOk !== -1 && scanOk < issues, 'a 500 from /api/scan/run must not become "done, 0 issues"');
    assert.match(src, /if \(!fixRes\.ok\)/);
    assert.ok(!/\(scanData\.totalIssues as number\) \|\| 0/.test(src), 'a missing totalIssues is not zero');
    assert.match(src, /Scan failed — \$\{httpFailure\(scanRes, scanData\)\}/);
    assert.match(src, /Fix failed — \$\{httpFailure\(fixRes, fixData\)\}/);
  });
});

// ─── 3. WatchdogTab pause / remove / load surface their errors ──────────────

describe('3. WatchdogTab surfaces failed loads and row actions', () => {
  const src = read(app('admin/tabs/WatchdogTab.tsx'));
  it('a failed /api/watches read renders an error, not the stale list', () => {
    assert.ok(!/if \(res\.ok\) \{\s*const data = await res\.json\(\);\s*setWatches/.test(src), 'old silent-on-!ok shape');
    assert.match(src, /setWatchesLoadError\(`Could not load watches — \$\{httpFailure\(res, data\)\}`\)/);
    assert.match(src, /: watchesLoadError \? \(/);
  });
  it('pause / resume / remove read the response and show the failure', () => {
    assert.ok(!/await fetch\(`\/api\/watches\?id=\$\{w\.id\}`, \{ method: "DELETE" \}\);\s*loadWatches\(\);/.test(src));
    assert.match(src, /rowAction\("Remove", `\/api\/watches\?id=\$\{w\.id\}`/);
    assert.match(src, /setRowActionError\(`\$\{label\} failed — \$\{httpFailure\(res, data\)\}`\)/);
  });
});

// ─── 4. KeysTab — error state with the HTTP status ──────────────────────────

describe('4. KeysTab never shows "Loading..." forever or "No keys" on a failed read', () => {
  const src = read(app('admin/tabs/KeysTab.tsx'));
  it('non-ok GET and thrown fetch set an error that is rendered', () => {
    assert.ok(!/surface as empty/.test(src), 'the old catch rendered a failure as "No keys issued yet"');
    assert.match(src, /setKeysLoadError\(`Could not load keys — \$\{httpFailure\(res, data\)\}`\)/);
    assert.match(src, /\{keysLoadError \? \(/);
  });
  it('revoke checks the response', () => {
    assert.match(src, /const res = await fetch\(`\/api\/admin\/keys\?revoke=/);
    assert.match(src, /setRevokeError\(`Revoke \$\{id\} failed — \$\{httpFailure\(res, data\)\}/);
  });
});

// ─── 5. compliance-status — NOT CHECKED is its own state ────────────────────

describe('5. compliance-status reports not-checked instead of intact / zero', () => {
  function load({ getDb, verifyChain }) {
    return loadTs(path.join(LIB, 'compliance-status.ts'), {
      './db': { getDb },
      './audit-log-store': { verifyChain },
    });
  }
  // A healthy DB: every table present, 5 audit rows, 2 locked accounts.
  const healthy = (overrides = {}) => fakeSql((q) => {
    for (const [needle, fn] of Object.entries(overrides)) if (q.includes(needle)) return fn(q);
    if (q.includes('to_regclass')) return [{ r: 'x' }];
    if (q.includes('MAX(id)')) return [{ m: 5 }];
    if (q.includes('admin_auth_attempts')) return [{ count: 2 }];
    return [{ count: 5 }];
  });

  it('control: a readable, intact chain is chainOk:true with no reason', async () => {
    const lib = load({ getDb: () => healthy(), verifyChain: async () => ({ ok: true }) });
    const s = await lib.buildComplianceSnapshot();
    assert.equal(s.audit.chainOk, true);
    assert.equal(s.audit.chainNotCheckedReason, null);
    assert.equal(s.audit.totalEvents, 5);
    assert.equal(s.notCheckedReason, null);
  });

  it('a hash-chain probe that THROWS is not checked — it used to read "intact"', async () => {
    const lib = load({ getDb: () => healthy(), verifyChain: async () => { throw new Error('verify blew up'); } });
    const s = await lib.buildComplianceSnapshot();
    assert.notEqual(s.audit.chainOk, true, 'a probe that threw verified nothing');
    assert.equal(s.audit.chainOk, null);
    assert.match(String(s.audit.chainNotCheckedReason), /verify blew up/);
  });

  it('DATABASE_URL unset → the whole snapshot is marked not checked, with the reason', async () => {
    const lib = load({ getDb: () => { throw new Error('DATABASE_URL is not set'); }, verifyChain: async () => ({ ok: true }) });
    const s = await lib.buildComplianceSnapshot();
    assert.match(String(s.notCheckedReason), /DATABASE_URL is not set/);
    assert.match(String(s.audit.countsNotCheckedReason), /DATABASE_URL/);
    assert.match(String(s.adminAuth.notCheckedReason), /DATABASE_URL/);
  });

  it('a failing audit_log count query carries countsNotCheckedReason instead of a silent 0', async () => {
    const lib = load({
      getDb: () => healthy({ 'FROM audit_log': () => { throw new Error('audit read denied'); } }),
      verifyChain: async () => ({ ok: true }),
    });
    const s = await lib.buildComplianceSnapshot();
    assert.match(String(s.audit.countsNotCheckedReason), /audit read denied/);
    assert.equal(s.audit.chainOk, null);
  });

  it('a failing admin_auth_attempts query carries adminAuth.notCheckedReason', async () => {
    const lib = load({
      getDb: () => healthy({ 'FROM admin_auth_attempts': () => { throw new Error('lockout read denied'); } }),
      verifyChain: async () => ({ ok: true }),
    });
    const s = await lib.buildComplianceSnapshot();
    assert.match(String(s.adminAuth.notCheckedReason), /lockout read denied/);
  });

  it('the page renders "Not checked — <reason>" distinctly from intact / broken', () => {
    const src = read(app('admin/compliance/page.tsx'));
    assert.match(src, /Hash chain: Not checked — \{data\.audit\.chainNotCheckedReason\}/);
    assert.match(src, /data\.audit\.countsNotCheckedReason \? \(\s*<NotChecked/);
    assert.match(src, /data\.adminAuth\.notCheckedReason \? \(\s*<NotChecked/);
    assert.match(src, /data\?\.notCheckedReason &&/);
  });
});

// ─── 6. health page rows match the route's check ids ────────────────────────

describe('6. /admin/health expects exactly the check ids the route returns', () => {
  const page = read(app('admin/health/page.tsx'));
  const routeSrc = read(app('api/admin/health/route.ts'));
  const block = page.slice(page.indexOf('const EXPECTED'), page.indexOf('];', page.indexOf('const EXPECTED')));
  const expectedIds = [...block.matchAll(/id: "([a-z]+)"/g)].map((m) => m[1]);
  const routeIds = new Set([...routeSrc.matchAll(/\bid: "([a-z]+)"/g)].map((m) => m[1]));

  it('every row the page waits for is an id the route can return (the "github" row never resolved)', () => {
    assert.ok(expectedIds.length >= 8);
    for (const id of expectedIds) assert.ok(routeIds.has(id), `page expects "${id}" but the route never returns it`);
    for (const id of routeIds) assert.ok(expectedIds.includes(id), `route returns "${id}" but the page has no row`);
  });

  it('the module expectation is derived from TIERS, not a typed number', () => {
    assert.ok(!/names\.length < 22/.test(routeSrc) && !/expected 22/.test(routeSrc), 'typed 22');
    assert.ok(!/All 90 scan modules/.test(routeSrc), 'header claimed 90 while the code checked 22');
    assert.match(routeSrc, /Object\.values\(TIERS\)\.flat\(\)/);
  });

  it('a finished report with no answer for a row says "Not checked", not pending', () => {
    assert.match(page, /Not checked — the self-test returned no result for check id/);
  });
});

// ─── 7. LiveScanFeed — real reconnect, truthful label, server errors shown ──

describe('7. LiveScanFeed reconnects with backoff and says what is true', () => {
  const FEED = app('admin/pipeline-trace/LiveScanFeed.tsx');
  const src = read(FEED);

  it('backoff is 1s, 2s, 5s, … capped at 30s', () => {
    const feed = require(app('admin/pipeline-trace/reconnect-backoff.js'));
    assert.match(src, /import \{ reconnectDelayMs \} from "\.\/reconnect-backoff"/, 'the feed uses this backoff');
    assert.equal(typeof feed.reconnectDelayMs, 'function', 'there was no reconnect at all');
    assert.equal(feed.reconnectDelayMs(0), 1000);
    assert.equal(feed.reconnectDelayMs(1), 2000);
    assert.equal(feed.reconnectDelayMs(2), 5000);
    for (const n of [4, 5, 20, 1000]) assert.ok(feed.reconnectDelayMs(n) <= 30_000);
    assert.equal(feed.reconnectDelayMs(1000), 30_000);
  });

  it('the label no longer claims "reconnecting" after closing for good', () => {
    assert.ok(!/stream closed — reconnecting/.test(src));
    assert.match(src, /`reconnecting in \$\{feedStatus\.inSeconds\}s — \$\{feedStatus\.reason\}`/);
    assert.match(src, /`disconnected: \$\{feedStatus\.reason\}`/);
    assert.match(src, /retryTimer = setTimeout\(connect, delayMs\)/);
  });

  it('server-sent error events are rendered, not only console.error', () => {
    assert.ok(!/console\.error\("\[LiveScanFeed\] server error:"/.test(src));
    assert.match(src, /setServerError\(message\)/);
    assert.match(src, /Server error: \{serverError\}/);
  });

  it('the stream route reports a failing poll instead of swallowing it', () => {
    const routeSrc = read(app('api/admin/pipeline-trace/stream/route.ts'));
    assert.ok(!/ignore transient DB errors during polling/.test(routeSrc));
    assert.match(routeSrc, /sse\("error", \{ message: `scan poll failed: \$\{msg\}` \}\)/);
  });
});

// ─── 8. admin-platforms — a DB failure is not an empty registry ─────────────

describe('8. listAdminPlatforms propagates a read failure', () => {
  const load = (getDb) => loadTs(path.join(LIB, 'admin-platforms.ts'), { './db': { getDb } });

  it('DATABASE_URL unset → rejects with the reason (was: resolved [])', async () => {
    const lib = load(() => { throw new Error('DATABASE_URL is not set'); });
    await assert.rejects(lib.listAdminPlatforms(), /admin platform registry not readable: DATABASE_URL is not set/);
  });

  it('query error → rejects with the reason', async () => {
    const lib = load(() => fakeSql((q) => {
      if (q.startsWith('CREATE TABLE')) return [];
      throw new Error('permission denied for table admin_platforms');
    }));
    await assert.rejects(lib.listAdminPlatforms(), /permission denied/);
  });

  it('control: a readable empty registry is still []', async () => {
    const lib = load(() => fakeSql(() => []));
    assert.deepEqual(await lib.listAdminPlatforms(), []);
  });

  it('PlatformsTab renders a failed GET instead of "No admin platforms registered yet"', () => {
    const src = read(app('admin/tabs/PlatformsTab.tsx'));
    assert.ok(!/if \(res\.ok\) \{ const d = await res\.json\(\); setPlatforms/.test(src));
    assert.match(src, /setPlatformsLoadError\(`Could not read the platform registry — \$\{httpFailure\(res, d\)\}`\)/);
    assert.match(src, /: platformsLoadError \? \(/);
  });
});

// ─── 9. tallrig events route — unreadable ledger is not "no events" ─────────

describe('9. /api/admin/integrations/tallrig reports an unreadable ledger', () => {
  const load = (listRecent) => loadTs(app('api/admin/integrations/tallrig/route.ts'), {
    'next/server': fakeNextServer,
    '@/app/lib/admin-guard': { requireAdminRoute: () => null },
    '@/app/lib/tallrig-push-event-store': { listRecent },
  });
  const quiet = (fn) => async () => {
    const warn = console.warn;
    console.warn = () => {};
    try { await fn(); } finally { console.warn = warn; }
  };

  it('store throws → 503 ok:false notChecked with the reason (was: 200 ok:true events:[])', quiet(async () => {
    const route = load(() => { throw new Error('EACCES ledger.jsonl'); });
    const r = await route.GET(fakeReq());
    assert.equal(r.status, 503);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.notChecked, true);
    assert.match(r.body.error, /EACCES ledger\.jsonl/);
    assert.equal(r.body.events, undefined, 'no event list when none was read');
  }));

  it('control: a readable ledger is 200 ok:true with its events', async () => {
    const route = load(() => [{ dedupeKey: 'a' }]);
    const r = await route.GET(fakeReq());
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.deepEqual(r.body.events, [{ dedupeKey: 'a' }]);
  });

  it('the page renders "Not checked — HTTP <status>: <reason>"', () => {
    const src = read(app('admin/integrations/tallrig/page.tsx'));
    assert.match(src, /else if \(json\.notChecked\) setError\(`Not checked — HTTP \$\{res\.status\}: /);
  });
});

// ─── 10. FleetIntelligencePanel renders the route's note ────────────────────

describe('10. FleetIntelligencePanel shows the route note as not-checked', () => {
  it('a `note` (scan table missing) renders as "Not checked — <note>", not as "No fleet data yet"', () => {
    const src = read(app('admin/triage/FleetIntelligencePanel.tsx'));
    const noteIdx = src.indexOf('data?.note ? (');
    const emptyIdx = src.indexOf('No fleet data yet');
    assert.ok(noteIdx !== -1 && noteIdx < emptyIdx, 'the note branch must come before the empty branch');
    assert.match(src, /Not checked — \{data\.note\}/);
    assert.match(src, /setError\(`HTTP \$\{res\.status\}: /);
  });
});
