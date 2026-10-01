'use strict';
/**
 * Admin Overview + build bar — never green on a read that did not happen.
 *
 *  1. Worker card: an empty or missing scan_queue used to come back as
 *     { stale: false }, which the card painted "Healthy" — a worker that has
 *     never done anything read as a healthy one (Doctrine #1).
 *  2. Build bar: any build older than 24h was flagged bad even when it was
 *     identical to main — a quiet week read as a broken deploy. Age matters
 *     only when main has moved past the deployed commit.
 *
 * admin-overview.ts and admin-build-status.ts are transpiled with the
 * website's own `typescript` (the harness tests/admin-route-guard.test.js
 * uses) and run for real; only their imports are stood in for.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const WEB = path.join(__dirname, '..', 'website');
const TS_COMPILER_PATH = path.join(WEB, 'node_modules', 'typescript', 'lib', 'typescript.js');

function loadTs(rel, mocks) {
  const file = path.join(WEB, rel);
  const ts = require(TS_COMPILER_PATH);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true, resolveJsonModule: true },
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

function overviewWith(sqlImpl) {
  return loadTs('app/lib/admin-overview.ts', {
    'next/server': { NextRequest: class { constructor(url) { this.url = url; } } },
    '@/app/api/status/route': {
      GET: async () => ({ status: 200, json: async () => ({ ready: true, queue: { depth: 0 }, missing_required: [] }) }),
      REQUIRED: [],
      IMPORTANT: [],
    },
    '@/app/lib/site-url': { siteUrl: (p) => `http://localhost${p}` },
    '@/app/lib/db': { getDb: () => sqlImpl },
    '@/app/lib/tallrig-push-event-store': { listRecent: () => [] },
    '@/app/lib/marketplace-purchase-store': { summarize: async () => ({ counts: {}, activeInstalls: 0 }) },
    '@/app/lib/env-placeholder': { inspectEnvValue: () => ({ ok: true }) },
  });
}

function sqlReturning(handler) {
  return async (strings) => handler(strings.join('?'));
}

describe('Overview worker card — no data is not "Healthy"', () => {
  it('an empty scan_queue (no activity ever) is not reported as a fresh worker', async () => {
    const sql = sqlReturning((text) => {
      if (/last_activity/.test(text)) return [{ last_activity: null }];
      if (/FROM scans/.test(text)) return [{ today: 0, this_week: 0, total_scans: 0, total_revenue: 0, avg_score: 0 }];
      if (/FROM customers/.test(text)) return [{ total: 0 }];
      return [{}];
    });
    const { getOverviewFacts } = overviewWith(sql);
    const facts = await getOverviewFacts();
    assert.equal(facts.worker.checked, true);
    assert.equal(facts.worker.value.state, 'no_activity', 'the card must say "no activity yet", not Healthy');
    assert.match(facts.worker.value.reason, /no scan has been claimed/i);
  });

  it('a missing scan_queue table is not_checked with the reason, not a healthy null', async () => {
    const sql = sqlReturning((text) => {
      if (/scan_queue/.test(text)) throw new Error('relation "scan_queue" does not exist');
      if (/FROM scans/.test(text)) return [{ today: 0, this_week: 0, total_scans: 0, total_revenue: 0, avg_score: 0 }];
      if (/FROM customers/.test(text)) return [{ total: 0 }];
      return [{}];
    });
    const { getOverviewFacts } = overviewWith(sql);
    const facts = await getOverviewFacts();
    assert.equal(facts.worker.checked, false);
    assert.match(facts.worker.reason, /scan_queue/);
  });

  it('a missing scans table is not_checked, not a row of zeros', async () => {
    const sql = sqlReturning((text) => {
      if (/last_activity/.test(text)) return [{ last_activity: new Date().toISOString() }];
      if (/FROM scans/.test(text)) throw new Error('relation "scans" does not exist');
      return [{}];
    });
    const { getOverviewFacts } = overviewWith(sql);
    const facts = await getOverviewFacts();
    assert.equal(facts.scans.checked, false);
    assert.equal(facts.worker.value.state, 'active');
  });

  it('a public (unauthorised) readiness body is not read as "every secret present"', async () => {
    // /api/status answers a caller without an admin session with a minimal
    // body that lists nothing missing (GT-02). Read naively, every secret
    // came back "present" while DATABASE_URL was unset.
    const mod = loadTs('app/lib/admin-overview.ts', {
      'next/server': { NextRequest: class { constructor(url, init) { this.url = url; this.init = init; } } },
      '@/app/api/status/route': {
        GET: async () => ({ status: 200, json: async () => ({ ok: true, healthy: false, version: 'x', commit: 'y' }) }),
        REQUIRED: [{ name: 'DATABASE_URL', why: 'db' }],
        IMPORTANT: [],
      },
      '@/app/lib/site-url': { siteUrl: (p) => `http://localhost${p}` },
      '@/app/lib/db': { getDb: () => { throw new Error('DATABASE_URL is not set.'); } },
      '@/app/lib/tallrig-push-event-store': { listRecent: () => [] },
      '@/app/lib/marketplace-purchase-store': { summarize: async () => ({ counts: {}, activeInstalls: 0 }) },
      '@/app/lib/env-placeholder': { inspectEnvValue: () => ({ ok: true }) },
    });
    const facts = await mod.getOverviewFacts();
    assert.equal(facts.secrets.checked, false, 'secrets must be not checked, not all-present');
    assert.equal(facts.readiness.checked, false);
    assert.match(facts.secrets.reason, /operator detail/);
  });

  it('the admin request cookie is forwarded to the in-process readiness probe', async () => {
    let seen = null;
    const mod = loadTs('app/lib/admin-overview.ts', {
      'next/server': { NextRequest: class { constructor(url, init) { this.url = url; this.init = init; } } },
      '@/app/api/status/route': {
        GET: async (req) => { seen = req; return { status: 200, json: async () => ({ ready: true, missing_required: [] }) }; },
        REQUIRED: [],
        IMPORTANT: [],
      },
      '@/app/lib/site-url': { siteUrl: (p) => `http://localhost${p}` },
      '@/app/lib/db': { getDb: () => { throw new Error('DATABASE_URL is not set.'); } },
      '@/app/lib/tallrig-push-event-store': { listRecent: () => [] },
      '@/app/lib/marketplace-purchase-store': { summarize: async () => ({ counts: {}, activeInstalls: 0 }) },
      '@/app/lib/env-placeholder': { inspectEnvValue: () => ({ ok: true }) },
    });
    await mod.getOverviewFacts({ cookie: 'gt_admin=abc' });
    assert.equal(seen.init.headers.cookie, 'gt_admin=abc');
  });

  it('readiness.queue reaches the overview facts', async () => {
    const { getOverviewFacts } = overviewWith(sqlReturning(() => [{}]));
    const facts = await getOverviewFacts();
    assert.deepEqual(facts.readiness.value.queue, { depth: 0 });
  });
});

describe('Build bar — age is only a problem when main has moved on', () => {
  const DAY = 24 * 60 * 60 * 1000;

  async function statusFor(compareStatus, behindBy) {
    const realFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ status: compareStatus, behind_by: behindBy, base_commit: { sha: 'm'.repeat(40) } }),
    });
    try {
      const { getBuildStatus } = loadTs('app/lib/admin-build-status.ts', {
        '@/app/data/build-info.json': { commit: 'a'.repeat(40), builtAt: new Date(Date.now() - 3 * DAY).toISOString() },
      });
      return await getBuildStatus();
    } finally {
      global.fetch = realFetch;
    }
  }

  it('a 3-day-old build identical to main is not stale', async () => {
    const s = await statusFor('identical', 0);
    assert.equal(s.buildStale, false);
  });

  it('a 3-day-old build behind main is stale', async () => {
    const s = await statusFor('behind', 4);
    assert.equal(s.buildStale, true);
  });
});
