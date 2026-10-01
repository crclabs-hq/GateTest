'use strict';
/**
 * Live-operations snapshot (website/app/lib/admin-ops.js → GET /api/admin/ops).
 *
 * Every source is injected; the fakes below stand in for the real queue,
 * launch-metrics, pull-deploy and spend-guard modules. The contract under
 * test is Doctrine #1: each section has its own three-state answer, one
 * failing source never blanks another, and a failed read is never zeros.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildOpsSnapshot } = require('../website/app/lib/admin-ops');

const NOW = new Date('2026-10-01T12:00:00Z');

function fakeSql() {
  return async (strings) => {
    const text = strings.join('?');
    if (/COUNT\(\*\)::int AS total/.test(text)) return [{ total: 0, last24h: 0 }];
    if (/ORDER BY id DESC LIMIT 10/.test(text)) return [];
    throw new Error(`no handler for: ${text.slice(0, 60)}`);
  };
}

function deps(overrides = {}) {
  return {
    now: () => NOW,
    getSql: () => fakeSql(),
    getQueueStats: async () => ({ queued: 2, running: 1, done: 40, dead: 0, oldest_queued_age_s: 30 }),
    getLaunchMetrics: async () => ({
      pipeline: { '2026-10-01': { queued: 2, running: 1, done: 9, dead: 0 } },
      latency: { completed: 9, queue_wait_s: { avg: 5, p95: 12 }, push_to_result_s: { avg: 40, p95: 95 }, avg_attempts: 1 },
    }),
    readLastPullDeploy: () => ({
      at: '2026-10-01T11:58:00Z', result: 'up-to-date', reason: '', from: 'abc1234', to: 'abc1234',
      consecutiveFailures: 0, firstFailedAt: null,
    }),
    checkServerSpend: async () => ({ allowed: true, spentMicros: 1_500_000, ceilingMicros: 10_000_000, reason: 'ok' }),
    summarizeUsage: async () => ({
      totals: {},
      series: [
        { day: '2026-09-30', usdEstimated: 2, aiCalls: 3, tokensIn: 100, tokensOut: 50 },
        { day: '2026-10-01', usdEstimated: 1.5, aiCalls: 2, tokensIn: 80, tokensOut: 20 },
      ],
    }),
    serverAccountKey: 'server:gatetest',
    ...overrides,
  };
}

const SECTIONS = ['queue', 'latency', 'deadLetters', 'deploy', 'spend'];

describe('buildOpsSnapshot', () => {
  it('all sources ok — every section ok with a reason and real numbers', async () => {
    const s = await buildOpsSnapshot(deps());
    assert.equal(s.generatedAt, NOW.toISOString());
    for (const k of SECTIONS) {
      assert.equal(s[k].state, 'ok', `${k}: ${s[k].reason}`);
      assert.ok(s[k].reason && typeof s[k].reason === 'string', `${k} must carry a reason`);
    }
    assert.equal(s.overall, 'ok');
    assert.equal(s.queue.queued, 2);
    assert.equal(s.queue.oldestQueuedAgeSec, 30);
    assert.equal(s.latency.p95TotalSec, 95);
    assert.equal(s.latency.p95WaitSec, 12);
    assert.deepEqual(s.latency.last24h, { queued: 2, running: 1, done: 9, dead: 0 });
    assert.deepEqual(s.latency.recentDead, []);
    assert.equal(s.spend.todayUsd, 1.5);
    assert.equal(s.spend.ceilingUsd, 10);
    assert.equal(s.spend.pctOfCeiling, 15);
    assert.equal(s.spend.last7d.length, 2);
    assert.equal(s.deploy.result, 'up-to-date');
  });

  it('one source throws — that section is not_checked with the reason, the others stay populated', async () => {
    const s = await buildOpsSnapshot(deps({
      getQueueStats: async () => { throw new Error('connection refused'); },
    }));
    assert.equal(s.queue.state, 'not_checked');
    assert.match(s.queue.reason, /connection refused/);
    assert.equal(s.queue.queued, undefined, 'a failed read must not be reported as zeros');
    assert.equal(s.latency.state, 'ok');
    assert.equal(s.latency.p95TotalSec, 95);
    assert.equal(s.spend.state, 'ok');
    assert.equal(s.deploy.state, 'ok');
  });

  it('a hanging source times out into not_checked without blocking the rest', async () => {
    const s = await buildOpsSnapshot(deps({
      timeoutMs: 50,
      getLaunchMetrics: () => new Promise(() => {}),
    }));
    assert.equal(s.latency.state, 'not_checked');
    assert.match(s.latency.reason, /timed out/);
    assert.equal(s.queue.state, 'ok');
  });

  it('no database — DB-backed sections are not_checked with a reason, never zeros; deploy still reads', async () => {
    const s = await buildOpsSnapshot(deps({
      getSql: () => { throw new Error('DATABASE_URL is not set.'); },
      checkServerSpend: async () => ({ allowed: true, spentMicros: 0, ceilingMicros: null, reason: 'not-configured' }),
    }));
    for (const k of ['queue', 'latency', 'deadLetters', 'spend']) {
      assert.equal(s[k].state, 'not_checked', k);
      assert.match(s[k].reason, /DATABASE_URL unset/, k);
    }
    assert.equal(s.queue.queued, undefined);
    assert.equal(s.spend.todayUsd, undefined);
    assert.match(s.spend.reason, /GATETEST_DAILY_API_BUDGET_USD unset/);
    assert.equal(s.deploy.state, 'ok');
  });

  it('spend with no ceiling set is warn, not ok', async () => {
    const s = await buildOpsSnapshot(deps({
      checkServerSpend: async () => ({ allowed: true, spentMicros: 0, ceilingMicros: null, reason: 'not-configured' }),
    }));
    assert.equal(s.spend.state, 'warn');
    assert.match(s.spend.reason, /no ceiling set — GATETEST_DAILY_API_BUDGET_USD unset/);
    assert.equal(s.spend.ceilingUsd, null);
    assert.equal(s.spend.pctOfCeiling, null);
    assert.equal(s.spend.todayUsd, 1.5);
  });

  it('spend ceiling reached or misconfigured is fail', async () => {
    const reached = await buildOpsSnapshot(deps({
      checkServerSpend: async () => ({ allowed: false, spentMicros: 10_000_000, ceilingMicros: 10_000_000, reason: 'daily-budget-reached' }),
    }));
    assert.equal(reached.spend.state, 'fail');
    const bad = await buildOpsSnapshot(deps({
      checkServerSpend: async () => ({ allowed: false, spentMicros: 0, ceilingMicros: null, reason: 'misconfigured' }),
    }));
    assert.equal(bad.spend.state, 'fail');
  });

  it('deploy with consecutiveFailures > 0 is fail and names the reason', async () => {
    const s = await buildOpsSnapshot(deps({
      readLastPullDeploy: () => ({
        at: '2026-10-01T11:58:00Z', result: 'failed', reason: 'npm ci failed', from: 'a', to: 'a',
        consecutiveFailures: 3, firstFailedAt: '2026-10-01T11:45:00Z',
      }),
    }));
    assert.equal(s.deploy.state, 'fail');
    assert.match(s.deploy.reason, /3 consecutive failed deploy/);
    assert.match(s.deploy.reason, /npm ci failed/);
    assert.equal(s.overall, 'fail');
  });

  it('deploy status file unreadable is not_checked, not ok', async () => {
    const s = await buildOpsSnapshot(deps({
      readLastPullDeploy: () => ({ result: 'unknown', reason: 'status file not readable' }),
    }));
    assert.equal(s.deploy.state, 'not_checked');
    assert.match(s.deploy.reason, /status file not readable/);
  });

  it('queue with dead letters is warn; a long-waiting job is fail', async () => {
    const dead = await buildOpsSnapshot(deps({
      getQueueStats: async () => ({ queued: 0, running: 0, done: 5, dead: 2, oldest_queued_age_s: null }),
    }));
    assert.equal(dead.queue.state, 'warn');
    assert.match(dead.queue.reason, /2 dead letter/);
    const stuck = await buildOpsSnapshot(deps({
      getQueueStats: async () => ({ queued: 4, running: 0, done: 5, dead: 1, oldest_queued_age_s: 3600 }),
    }));
    assert.equal(stuck.queue.state, 'fail');
  });

  it('dead letters in the last 24h are fail and listed with id/repo/reason/at', async () => {
    const sql = async (strings) => {
      const text = strings.join('?');
      if (/COUNT\(\*\)::int AS total/.test(text)) return [{ total: 3, last24h: 1 }];
      if (/ORDER BY id DESC LIMIT 10/.test(text)) {
        return [{ id: 42, repository: 'acme/app', last_error: '[terminal] 404 not found', at: '2026-10-01T10:00:00Z' }];
      }
      throw new Error('unexpected');
    };
    const s = await buildOpsSnapshot(deps({ getSql: () => sql }));
    assert.equal(s.deadLetters.state, 'fail');
    assert.deepEqual(s.latency.recentDead, [
      { id: '42', repo: 'acme/app', terminal: true, reason: '404 not found', at: '2026-10-01T10:00:00Z' },
    ]);
  });

  it('latency with nothing completed in 24h is not_checked, not a green zero', async () => {
    const s = await buildOpsSnapshot(deps({
      getLaunchMetrics: async () => ({
        pipeline: {},
        latency: { completed: 0, queue_wait_s: { avg: null, p95: null }, push_to_result_s: { avg: null, p95: null } },
      }),
    }));
    assert.equal(s.latency.state, 'not_checked');
    assert.match(s.latency.reason, /no scan completed/);
  });
});
