'use strict';

/**
 * Issue #768 items 1, 2 and 5 — the hosted JSON web scan keeps its own clock,
 * hands back a shareable link, and explains a runtime pass that did not run.
 *
 * Measured 2026-09-28: `POST /api/web/scan` on gatetest.io returned nothing in
 * 240 s (curl HTTP 000) against a route declaring `maxDuration 60` — `next
 * start` does not enforce maxDuration. So the route races every await that can
 * hang against one deadline (website/app/lib/web-scan-budget.js) and answers
 * 200 + `partial: true` when it fires.
 *
 * Control pairs (Doctrine #3), run against the REAL route handler with its
 * external seams replaced (the same transpile-and-load technique as
 * tests/playground-scan-wallclock.test.js):
 *   - a target whose page fetch never resolves, on an engine that hangs
 *     mid-suite  -> answered within budget + 1 s, partial:true, the unfinished
 *     modules listed not-checked with the budget reason;
 *   - a fast target  -> partial:false, the SAME response shape;
 *   - `reportUrl` present, absolute and restorable in both;
 *   - runtime not configured -> the explanation is in the not-checked list, in
 *     `runtime.explanation` and (source contract) in what the /web page prints.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');
const ROUTE = 'website/app/api/web/scan/route.ts';
const LIB = path.join(ROOT, 'website', 'app', 'lib');
const TS_COMPILER_PATH = path.join(ROOT, 'website/node_modules/typescript/lib/typescript.js');
if (!fs.existsSync(TS_COMPILER_PATH)) {
  throw new Error(`typescript compiler not found at ${TS_COMPILER_PATH} — recreate the website/node_modules junction first`);
}
const ts = require(TS_COMPILER_PATH);

const budget = require('../website/app/lib/web-scan-budget');
const share = require('../website/app/lib/web-scan-share');
const reasons = require('../website/app/lib/web-runtime-reasons');

const BUDGET_MS = 400;
const SUITE = ['webHeaders', 'seo', 'runtimeErrors', 'liveCrawler'];

// ── the route under test ─────────────────────────────────────────────────────

let engineFile;

function loadPost() {
  const source = fs.readFileSync(path.join(ROOT, ROUTE), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: path.join(ROOT, ROUTE),
  });
  const mocks = {
    'next/server': { NextResponse: { json: (body, init) => ({ status: (init && init.status) || 200, body }) } },
    '@/app/lib/full-report-auth': { resolveFullReportAccess: async () => false },
    '@/app/lib/ssrf-guard': { resolveAndValidateUrl: async (u) => ({ ok: true, url: new URL(u) }) },
    '@/app/lib/engine-build': { engineBuild: () => 'test-build' },
    '@/app/lib/engine-entry-resolver.js': { resolveEngineEntry: () => engineFile },
    '@/app/lib/reliability/url-prober': { probeUrl: async () => ({ findings: [], durationMs: 1, status: 200 }) },
    '@lib/rate-limit': { createLimiter: () => ({ guard: async () => ({ allowed: true }) }), PRESETS: { webScan: {} } },
  };
  global.__WEB_BUDGET_MOCKS__ = mocks;
  const patched = outputText.replace(/require\("((?:@\/app\/lib|@lib|next)\/[^"]+)"\)/g, (_m, id) => {
    if (Object.prototype.hasOwnProperty.call(mocks, id)) return `global.__WEB_BUDGET_MOCKS__[${JSON.stringify(id)}]`;
    if (id.startsWith('@/app/lib/')) return `require(${JSON.stringify(path.join(LIB, id.slice('@/app/lib/'.length)))})`;
    throw new Error(`unmapped require in the route: ${id}`);
  });
  const modPath = path.join(ROOT, ROUTE);
  const mod = new Module(modPath, module);
  mod.filename = modPath;
  mod.paths = Module._nodeModulePaths(path.dirname(modPath));
  mod._compile(patched, modPath);
  return mod.exports.POST;
}

function fakeReq() {
  return {
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => ({ url: 'https://target.example' }),
  };
}

/** A TestResult-shaped module result. */
const moduleResult = (module, checks = []) => ({ module, checks, toJSON() { return { module, checks }; } });

async function runRoute({ fetchImpl, run }) {
  global.__WEB_BUDGET_ENGINE__ = { suite: SUITE, run };
  const realFetch = global.fetch;
  global.fetch = fetchImpl;
  const saved = {};
  for (const k of Object.keys(process.env)) {
    if (/^(TALLRIG|VAPRON|CRONTECH)_/.test(k)) { saved[k] = process.env[k]; delete process.env[k]; }
  }
  process.env.GATETEST_WEB_SCAN_BUDGET_MS = String(BUDGET_MS);
  try {
    const POST = loadPost();
    const t0 = Date.now();
    const res = await POST(fakeReq());
    return { res, ms: Date.now() - t0 };
  } finally {
    global.fetch = realFetch;
    delete process.env.GATETEST_WEB_SCAN_BUDGET_MS;
    Object.assign(process.env, saved);
  }
}

const neverFetch = () => new Promise(() => {}); // ignores its abort signal, like a dead socket
const okFetch = async () => ({ url: 'https://target.example/', status: 200, headers: new Headers(), text: async () => '<html><title>t</title></html>' });

before(() => {
  engineFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'web-budget-engine-')), 'engine.js');
  fs.writeFileSync(engineFile, [
    'class GateTest {',
    '  constructor(root, opts) {',
    '    this.opts = opts;',
    '    this.config = { set() {}, data: {}, getSuite: () => global.__WEB_BUDGET_ENGINE__.suite };',
    '    this.registry = { list: () => [] };',
    '  }',
    '  init() { return this; }',
    '  runSuite() { return global.__WEB_BUDGET_ENGINE__.run(this.opts); }',
    '}',
    'module.exports = { GateTest };',
    '',
  ].join('\n'));
});
after(() => {
  try { fs.rmSync(path.dirname(engineFile), { recursive: true, force: true }); } catch { /* error-ok — temp dir cleanup */ }
});

// ── the pair ─────────────────────────────────────────────────────────────────

describe('POST /api/web/scan — wall-clock budget (issue #768 item 1)', () => {
  let slow;
  let fast;

  before(async () => {
    slow = await runRoute({
      fetchImpl: neverFetch,
      // One module finishes, then the engine hangs for good.
      run: (opts) => {
        opts.onProgress('module:end', moduleResult('webHeaders', [{ name: 'hsts', passed: false, severity: 'error', message: 'Missing HSTS header' }]));
        return new Promise(() => {});
      },
    });
    fast = await runRoute({
      fetchImpl: okFetch,
      run: async (opts) => {
        const results = SUITE.map((m) => moduleResult(m, m === 'runtimeErrors'
          ? [{ name: 'runtime-errors:playwright-missing', passed: true, severity: 'info', message: 'Playwright not available' }]
          : []));
        for (const r of results) opts.onProgress('module:end', r);
        return { results: results.map((r) => r.toJSON()), gateStatus: 'PASSED' };
      },
    });
  });

  it('a never-resolving page fetch on a hanging engine answers within budget + 1 s, as a 200', () => {
    assert.equal(slow.res.status, 200, 'a slow target is never a 5xx');
    assert.ok(slow.ms < BUDGET_MS + 1000, `took ${slow.ms} ms against a ${BUDGET_MS} ms budget`);
    assert.ok(slow.ms >= BUDGET_MS - 50, `answered in ${slow.ms} ms — before the budget, so the deadline was not what ended it`);
  });

  it('says partial, keeps what finished, and lists every unfinished module with the budget reason', () => {
    const b = slow.res.body;
    assert.equal(b.partial, true);
    assert.equal(b.budgetMs, BUDGET_MS);
    assert.ok(!b.notCheckedModules.includes('webHeaders'), 'the module that finished is not listed as unchecked');
    assert.equal(b.totalModules, SUITE.length, 'the whole suite is the denominator');
    for (const m of ['seo', 'runtimeErrors', 'liveCrawler']) {
      const entry = b.notCheckedReasons.find((n) => n.module === m);
      assert.ok(entry, `${m} must be listed not-checked`);
      assert.match(entry.reason, /^budget exhausted after 0\.4 s$/);
    }
    assert.equal(b.totalFindings, 1, 'the finished module finding is in the response');
  });

  it('the partial response names the streaming route for a full crawl', () => {
    const b = slow.res.body;
    assert.match(b.streamUrl, /^https?:\/\/[^/]+\/api\/web\/scan\/stream$/);
    assert.ok(b.partialNote.includes(b.streamUrl));
  });

  it('a fast target is partial:false with the identical response shape', () => {
    const f = fast.res.body;
    assert.equal(fast.res.status, 200);
    assert.equal(f.partial, false);
    assert.equal(f.streamUrl, null);
    assert.equal(f.partialNote, null);
    assert.deepEqual(Object.keys(f).sort(), Object.keys(slow.res.body).sort());
    assert.deepEqual(Object.keys(f.runtime).sort(), Object.keys(slow.res.body.runtime).sort());
    assert.equal(f.totalModules, SUITE.length);
    assert.ok(!f.notCheckedReasons.some((n) => /budget/.test(n.reason)), 'a complete scan never blames the budget');
  });

  it('when the deadline has already passed the runtime dispatch is skipped and the reason says so', () => {
    const rt = slow.res.body.runtime;
    assert.equal(rt.status, 'unavailable');
    assert.equal(rt.reason, reasons.RUNTIME_REASONS.BUDGET_EXHAUSTED);
    assert.match(rt.explanation, /ran out of time/);
  });

  describe('reportUrl (item 2)', () => {
    for (const [label, get] of [['slow', () => slow], ['fast', () => fast]]) {
      it(`${label}: present, absolute, and it restores this exact result`, () => {
        const { body } = get().res;
        assert.match(body.reportUrl, /^https?:\/\/[^/]+\/web\?s=[A-Za-z0-9_-]+$/);
        const restored = share.decodeShareData(body.reportUrl.split('?s=')[1]);
        assert.ok(restored, 'the link must decode (and not be expired)');
        assert.equal(restored.scanId, body.scanId);
        assert.equal(restored.healthScore.grade, body.healthScore.grade);
        assert.deepEqual(restored.notCheckedReasons, body.notCheckedReasons);
      });
    }
  });

  describe('runtime not configured (item 5)', () => {
    it('the explanation is in the not-checked list AND on the runtime block, from one definition', () => {
      const b = fast.res.body;
      assert.equal(b.runtime.status, 'unavailable');
      assert.equal(b.runtime.reason, 'not-configured');
      assert.equal(b.runtime.explanation, reasons.runtimeNotRunExplanation('not-configured'));
      const entry = b.notCheckedReasons.find((n) => n.module === 'runtimeErrors');
      assert.ok(entry, 'runtimeErrors reported a pass with no browser — it must be listed not-checked');
      assert.equal(entry.reason, b.runtime.explanation);
      assert.match(entry.reason, /not switched on for this deployment/);
      assert.ok(b.notCheckedModules.includes('runtimeErrors'));
      assert.equal(b.checkedModules, b.totalModules - b.notCheckedModules.length);
    });

    it('the /web page prints the same sentence (imports the shared definition, keeps no copy)', () => {
      const ui = fs.readFileSync(path.join(ROOT, 'website/app/components/url-scan-flow-progress.tsx'), 'utf8');
      assert.match(ui, /runtimeNotRunExplanation\(reason\)/);
      assert.doesNotMatch(ui, /not switched on for this deployment/);
      const flow = fs.readFileSync(path.join(ROOT, 'website/app/components/UrlScanFlow.tsx'), 'utf8');
      assert.match(flow, /<RuntimeUnavailable reason=\{result\.runtime\.reason\} \/>/);
    });

    it('control: an already-listed module keeps its own reason; an unlisted one gains the explanation', () => {
      const cov = { totalModules: 3, checkedModules: 3, notChecked: [] };
      const listed = { totalModules: 3, checkedModules: 2, notChecked: [{ module: 'runtimeErrors', reason: 'budget exhausted after 50 s' }] };
      assert.strictEqual(reasons.markRuntimeNotChecked(listed, 'not-configured'), listed);
      assert.equal(reasons.markRuntimeNotChecked(cov, 'not-configured').checkedModules, 2);
    });
  });
});

// ── the pieces ───────────────────────────────────────────────────────────────

describe('web-scan-budget.js', () => {
  it('defaults to 50 s, honours the env override, ignores garbage, and never reaches maxDuration', () => {
    assert.equal(budget.resolveWebScanBudgetMs({}), 50_000);
    assert.equal(budget.resolveWebScanBudgetMs({ GATETEST_WEB_SCAN_BUDGET_MS: '30000' }), 30_000);
    for (const bad of ['', 'abc', '0', '-5', 'NaN']) {
      assert.equal(budget.resolveWebScanBudgetMs({ GATETEST_WEB_SCAN_BUDGET_MS: bad }), 50_000, `"${bad}"`);
    }
    assert.equal(budget.resolveWebScanBudgetMs({ GATETEST_WEB_SCAN_BUDGET_MS: '600000' }), budget.MAX_WEB_SCAN_BUDGET_MS);
    assert.ok(budget.MAX_WEB_SCAN_BUDGET_MS < budget.ROUTE_MAX_DURATION_MS);
    const declared = fs.readFileSync(path.join(ROOT, ROUTE), 'utf8').match(/export const maxDuration = (\d+);/);
    assert.equal(Number(declared[1]) * 1000, budget.ROUTE_MAX_DURATION_MS, 'the budget must track the route maxDuration');
  });

  it('per-page timeout is always strictly below the budget and never above the crawler default', () => {
    for (const b of [1000, 5000, 50_000, 55_000]) {
      const p = budget.perPageTimeoutMs(b);
      assert.ok(p < b && p <= 15_000, `${p} for ${b}`);
    }
  });

  it('raceOr returns the value when it wins and the fallback when the deadline does', async () => {
    const d1 = budget.createDeadline(200);
    assert.equal(await d1.raceOr(Promise.resolve('value'), 'fallback'), 'value');
    d1.dispose();
    const d2 = budget.createDeadline(30);
    assert.equal(await d2.raceOr(new Promise(() => {}), 'fallback'), 'fallback');
    assert.equal(d2.expired, true);
    assert.equal(d2.remainingMs(), 0);
    d2.dispose();
  });

  it('a rejection before the deadline propagates (a real error is not a timeout); after it, it is swallowed', async () => {
    const d = budget.createDeadline(200);
    await assert.rejects(d.raceOr(Promise.reject(new Error('boom')), 'x'), /boom/);
    d.dispose();
    const late = budget.createDeadline(20);
    let rejectLater;
    const p = new Promise((_, rej) => { rejectLater = rej; });
    assert.equal(await late.raceOr(p, 'fallback'), 'fallback');
    rejectLater(new Error('late')); // must not become an unhandled rejection
    await new Promise((r) => setTimeout(r, 10));
    late.dispose();
  });

  it('unfinishedModules lists exactly the suite modules with no result', () => {
    const out = budget.unfinishedModules(['a', 'b', 'c'], [{ module: 'a' }, { name: 'c' }], 50_000);
    assert.deepEqual(out, [{ module: 'b', reason: 'budget exhausted after 50 s' }]);
  });
});

describe('web-scan-share.js — reportUrl', () => {
  it('round-trips a result and expires after 48 h', () => {
    const url = share.buildReportUrl({ scanId: 'scn_1', findings: [] }, 'https://gatetest.example');
    assert.match(url, /^https:\/\/gatetest\.example\/web\?s=/);
    assert.equal(share.decodeShareData(url.split('?s=')[1]).scanId, 'scn_1');
    const old = share.encodeShareData({ scanId: 'scn_old' });
    const realNow = Date.now;
    Date.now = () => realNow() + share.SHARE_EXPIRY_MS + 1000;
    try { assert.equal(share.decodeShareData(old), null); } finally { Date.now = realNow; }
  });

  it('a full report too long for our own server is compacted, not handed out unusable', () => {
    const big = {
      scanId: 'scn_big',
      healthScore: { score: 40, grade: 'F', summary: 's' },
      findings: Array.from({ length: 40 }, (_, i) => ({ title: `finding ${i}`, module: 'seo', body: 'x'.repeat(600) })),
      moduleChecks: [{ module: 'seo', checks: Array.from({ length: 200 }, (_, i) => ({ name: `c${i}` })) }],
    };
    const url = share.buildReportUrl(big, 'https://gatetest.example');
    assert.ok(url.length <= share.MAX_REPORT_URL_LENGTH, `${url.length} chars`);
    const restored = share.decodeShareData(url.split('?s=')[1]);
    assert.equal(restored.findings.length, 40, 'every finding title survives');
    assert.equal(restored.findings[0].body, '');
    assert.equal(restored.healthScore.grade, 'F');
  });
});
