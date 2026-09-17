// ============================================================================
// SCAN-WORKER-TICK TEST — Coverage for website/app/lib/scan-worker.js
// ============================================================================
// Verifies the pure helpers behind /api/scan/worker/tick. The route is a thin
// wrapper that injects real getDb() + runScan() + sendGluecronCallback() into
// runWorkerTick; this test exercises the orchestration with doubles.
//
// Covered paths:
//   - isAuthorisedTick: admin short-circuit, cron-secret match, mismatch,
//     missing-secret-lenient mode
//   - runWorkerTick: idle case (no job), success + callback, scan failure
//     + retry, dead-letter + error callback, reclaimStuck fires first
// ============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  isAuthorisedTick,
  runWorkerTick,
  MAX_DIFF_FILES,
} = require(path.resolve(
  __dirname,
  '..',
  'website',
  'app',
  'lib',
  'scan-worker.js'
));

const { MAX_ATTEMPTS } = require(path.resolve(
  __dirname,
  '..',
  'website',
  'app',
  'lib',
  'scan-queue-store.js'
));

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

function makeQueueStore({
  reclaimCount = 0,
  reclaimThrows = null,
  nextJob = null,
  claimThrows = null,
} = {}) {
  const calls = {
    reclaimStuck: 0,
    claimNextJob: 0,
    markDone: [],
    markFailed: [],
    markNotChecked: [],
  };
  return {
    calls,
    reclaimStuck: async () => {
      calls.reclaimStuck++;
      if (reclaimThrows) throw reclaimThrows;
      return reclaimCount;
    },
    claimNextJob: async () => {
      calls.claimNextJob++;
      if (claimThrows) throw claimThrows;
      return nextJob;
    },
    markDone: async (id, result, _sql) => {
      calls.markDone.push({ id, result });
    },
    markFailed: async (id, err, willRetry, _sql) => {
      calls.markFailed.push({ id, err: String(err), willRetry });
    },
    markNotChecked: async (id, reason, _sql) => {
      calls.markNotChecked.push({ id, reason });
    },
  };
}

/**
 * Double for usage-ledger.js — just enough of the real module's surface
 * (recordUsage, resolveAccountKey, aiTotalsFromModules, countBlockingFindings)
 * for runApiHostJob's ledger write to run against.
 */
function makeUsageStore({ recordThrows = null } = {}) {
  const calls = { recordUsage: [] };
  return {
    calls,
    resolveAccountKey: (ids = {}) => `apikey:${ids.apiKeyId || ids.fallback || 'unknown'}`,
    aiTotalsFromModules: (modules) => {
      let usd = 0;
      for (const m of Array.isArray(modules) ? modules : []) usd += Number(m && m.costUsd) || 0;
      return { aiCalls: 0, tokensIn: 0, tokensOut: 0, usd };
    },
    countBlockingFindings: () => 0,
    recordUsage: async (_sql, event) => {
      calls.recordUsage.push(event);
      if (recordThrows) throw recordThrows;
      return { id: 1 };
    },
  };
}

function makeScanResult(overrides = {}) {
  return {
    status: 'complete',
    modules: [{ name: 'lint', status: 'passed', checks: 10, issues: 0, duration: 100 }],
    totalModules: 1,
    completedModules: 1,
    totalIssues: 0,
    totalFixed: 0,
    duration: 1234,
    ...overrides,
  };
}

function makeJob(overrides = {}) {
  return {
    id: 42,
    event_id: 'evt-1',
    repository: 'alice/webapp',
    sha: 'a'.repeat(40),
    ref: 'refs/heads/main',
    pull_request_number: null,
    attempts: 1,
    ...overrides,
  };
}

const SQL = () => []; // never actually invoked — queueStore is doubled

function makeContinuousStore({
  subscription = null,
  findThrows = null,
  allowance = { allowed: true },
  allowanceThrows = null,
} = {}) {
  const calls = { findActiveByRepo: [], checkAiAllowance: [], recordAiSpend: [] };
  return {
    calls,
    findActiveByRepo: async (_sql, repoUrl) => {
      calls.findActiveByRepo.push(repoUrl);
      if (findThrows) throw findThrows;
      return subscription;
    },
    checkAiAllowance: async (_sql, subscriptionId) => {
      calls.checkAiAllowance.push(subscriptionId);
      if (allowanceThrows) throw allowanceThrows;
      return allowance;
    },
    recordAiSpend: async (_sql, subscriptionId, usd) => {
      calls.recordAiSpend.push({ subscriptionId, usd });
    },
  };
}

// ---------------------------------------------------------------------------
// isAuthorisedTick
// ---------------------------------------------------------------------------

describe('isAuthorisedTick', () => {
  it('returns true when isAdmin is true', () => {
    assert.strictEqual(
      isAuthorisedTick({ cronHeader: null, isAdmin: true, env: { CRON_SECRET: 'x' } }),
      true
    );
  });

  it('returns true when cron header matches CRON_SECRET', () => {
    assert.strictEqual(
      isAuthorisedTick({
        cronHeader: 'my-cron-secret',
        isAdmin: false,
        env: { CRON_SECRET: 'my-cron-secret' },
      }),
      true
    );
  });

  it('returns false when cron header does not match', () => {
    assert.strictEqual(
      isAuthorisedTick({
        cronHeader: 'wrong',
        isAdmin: false,
        env: { CRON_SECRET: 'right' },
      }),
      false
    );
  });

  it('returns false when CRON_SECRET is unset — fails closed like every other secret check (was fail-open, a real production gap)', () => {
    assert.strictEqual(
      isAuthorisedTick({ cronHeader: null, isAdmin: false, env: {} }),
      false
    );
  });

  it('returns false when CRON_SECRET is unset even with a cron header present', () => {
    assert.strictEqual(
      isAuthorisedTick({ cronHeader: 'anything', isAdmin: false, env: {} }),
      false
    );
  });
});

// ---------------------------------------------------------------------------
// runWorkerTick
// ---------------------------------------------------------------------------

describe('runWorkerTick — idle', () => {
  it('returns { ok: true, idle: true } when claimNextJob returns null', async () => {
    const qs = makeQueueStore({ nextJob: null });
    const runScan = async () => {
      throw new Error('runScan must not be called when idle');
    };
    const sendCallback = async () => {
      throw new Error('callback must not be called when idle');
    };

    const result = await runWorkerTick({
      sql: SQL,
      queueStore: qs,
      runScan,
      sendCallback,
    });
    assert.deepStrictEqual(result, { ok: true, idle: true, reclaimed: 0 });
    assert.strictEqual(qs.calls.reclaimStuck, 1, 'always reclaims first');
    assert.strictEqual(qs.calls.claimNextJob, 1);
  });

  it('still returns when reclaimStuck throws (fail-open)', async () => {
    const qs = makeQueueStore({
      nextJob: null,
      reclaimThrows: new Error('boom'),
    });
    const result = await runWorkerTick({
      sql: SQL,
      queueStore: qs,
      runScan: async () => ({}),
      sendCallback: async () => ({}),
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.idle, true);
  });
});

// ── KI #113 Phase 2: `api`-host rows are now EXECUTED, not just recorded ────
// Phase 1 (2026-09-16) marked every host='api' row terminal without running
// it — a customer who submitted a scan through the public API got "queued"
// then a silent, empty terminal state. Phase 2 tells the two shapes apart by
// metadata.url: a git URL (github.com/gitlab.com) runs the SAME execution
// path as a repo-host job; a bare website URL is checked against the
// browser-runtime gate (web-runtime-gate.js, KI #111) and, when that isn't
// configured, marked not-checked — never 'done' with zero findings. Neither
// shape ever sends a callback (there is no Gluecron/GitHub consumer for an
// api row); repo-host rows are unchanged (the 'github' control below).

describe('runWorkerTick — api-host rows with a git URL (KI #113 Phase 2)', () => {
  it('a github.com URL is scanned via runScan, marked done, and usage is recorded once', async () => {
    const qs = makeQueueStore({
      nextJob: makeJob({
        host: 'api',
        triggered_by: 'api_key:k1',
        metadata: { url: 'https://github.com/alice/webapp' },
      }),
    });
    const us = makeUsageStore();
    let scanArgs = null;
    let callbackCalls = 0;
    const result = await runWorkerTick({
      sql: SQL,
      queueStore: qs,
      runScan: async (repoUrl, tier, opts) => { scanArgs = { repoUrl, tier, opts }; return makeScanResult({ totalIssues: 3 }); },
      sendCallback: async () => { callbackCalls++; },
      usageStore: us,
    });

    assert.strictEqual(scanArgs.repoUrl, 'https://github.com/alice/webapp', 'the same URL the caller submitted, not a reconstructed one');
    assert.strictEqual(callbackCalls, 0, 'api rows have no callback consumer');
    assert.strictEqual(qs.calls.markDone.length, 1);
    assert.strictEqual(qs.calls.markDone[0].id, 42);
    assert.strictEqual(qs.calls.markFailed.length, 0);
    assert.strictEqual(qs.calls.markNotChecked.length, 0);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.ran, 42);

    assert.strictEqual(us.calls.recordUsage.length, 1, 'usage recorded exactly once');
    const event = us.calls.recordUsage[0];
    assert.strictEqual(event.surface, 'api');
    assert.strictEqual(event.accountKey, 'apikey:k1', 'identity comes from the api_key: prefix on triggered_by');
    assert.strictEqual(event.findingsTotal, 3);
  });

  it('a gitlab.com URL is also recognised as a git URL and scanned', async () => {
    const qs = makeQueueStore({
      nextJob: makeJob({
        host: 'api',
        triggered_by: 'api_key:k2',
        metadata: { url: 'https://gitlab.com/bob/service' },
      }),
    });
    let scanCalls = 0;
    const result = await runWorkerTick({
      sql: SQL,
      queueStore: qs,
      runScan: async () => { scanCalls++; return makeScanResult(); },
      sendCallback: async () => {},
    });
    assert.strictEqual(scanCalls, 1);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(qs.calls.markDone.length, 1);
  });

  it('a failed scan retries/dead-letters exactly like a repo-host job, still with no callback', async () => {
    const qs = makeQueueStore({
      nextJob: makeJob({
        id: 55,
        attempts: 1,
        host: 'api',
        triggered_by: 'api_key:k3',
        metadata: { url: 'https://github.com/alice/private-repo' },
      }),
    });
    let callbackCalls = 0;
    const result = await runWorkerTick({
      sql: SQL,
      queueStore: qs,
      runScan: async () => makeScanResult({ status: 'failed', error: 'GitHub API 404: Not Found' }),
      sendCallback: async () => { callbackCalls++; },
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.terminal, true);
    assert.strictEqual(qs.calls.markFailed.length, 1);
    assert.strictEqual(qs.calls.markFailed[0].willRetry, false);
    assert.strictEqual(callbackCalls, 0, 'api rows never get a dead-letter callback either');
  });

  it('does not crash the tick when the usage ledger write throws', async () => {
    const qs = makeQueueStore({
      nextJob: makeJob({ host: 'api', triggered_by: 'api_key:k4', metadata: { url: 'https://github.com/alice/webapp' } }),
    });
    const us = makeUsageStore({ recordThrows: new Error('ledger down') });
    const result = await runWorkerTick({
      sql: SQL,
      queueStore: qs,
      runScan: async () => makeScanResult(),
      sendCallback: async () => {},
      usageStore: us,
    });
    assert.strictEqual(result.ok, true, 'a ledger failure must not fail a tick whose scan already ran');
    assert.strictEqual(qs.calls.markDone.length, 1);
  });
});

describe('runWorkerTick — api-host rows with a bare website URL (KI #113 Phase 2)', () => {
  it("without the browser runtime configured: not-checked, no scan, no callback, no usage", async () => {
    const qs = makeQueueStore({ nextJob: makeJob({ host: 'api', triggered_by: 'api_key:k5', metadata: { url: 'https://example.com' } }) });
    const us = makeUsageStore();
    let scanCalls = 0;
    let callbackCalls = 0;
    const result = await runWorkerTick({
      sql: SQL,
      queueStore: qs,
      runScan: async () => { scanCalls++; return makeScanResult(); },
      sendCallback: async () => { callbackCalls++; },
      usageStore: us,
      env: {}, // no TALLRIG_*/VAPRON_*/GATETEST_PUBLIC_BASE_URL — every prerequisite missing
    });

    assert.strictEqual(scanCalls, 0, 'no repo, no browser runtime — nothing to run');
    assert.strictEqual(callbackCalls, 0);
    assert.strictEqual(us.calls.recordUsage.length, 0, 'never meter a scan that did not run');
    assert.strictEqual(qs.calls.markDone.length, 0, 'never "done" with zero findings');
    assert.strictEqual(qs.calls.markFailed.length, 0);
    assert.strictEqual(qs.calls.markNotChecked.length, 1);
    assert.strictEqual(qs.calls.markNotChecked[0].id, 42);
    assert.strictEqual(qs.calls.markNotChecked[0].reason, 'web-runtime:not-configured');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.notChecked, true);
    assert.strictEqual(result.reason, 'web-runtime:not-configured');
  });

  it('a row with no metadata.url at all is terminal, not not-checked (nothing to poll for)', async () => {
    const qs = makeQueueStore({ nextJob: makeJob({ host: 'api', triggered_by: 'api_key:k6', metadata: {} }) });
    const result = await runWorkerTick({
      sql: SQL,
      queueStore: qs,
      runScan: async () => makeScanResult(),
      sendCallback: async () => {},
    });
    assert.strictEqual(qs.calls.markFailed.length, 1);
    assert.strictEqual(qs.calls.markNotChecked.length, 0);
    assert.strictEqual(result.terminal, true);
  });
});

describe('runWorkerTick — repo-host rows are unchanged by KI #113 Phase 2 (the control)', () => {
  it("host='github' with the identical shape IS scanned exactly as before", async () => {
    const qs = makeQueueStore({ nextJob: makeJob({ host: 'github', triggered_by: 'webhook:d1' }) });
    let scanCalls = 0;
    const result = await runWorkerTick({
      sql: SQL,
      queueStore: qs,
      runScan: async () => { scanCalls++; return makeScanResult(); },
      sendCallback: async () => ({ sent: true }),
    });
    assert.strictEqual(scanCalls, 1);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(qs.calls.markFailed.length, 0);
    assert.strictEqual(qs.calls.markDone.length, 1);
  });
});

describe('runWorkerTick — job success', () => {
  it('calls markDone and fires the callback on successful scan', async () => {
    const qs = makeQueueStore({ nextJob: makeJob() });
    let scanArgs = null;
    const runScan = async (repoUrl, tier) => {
      scanArgs = { repoUrl, tier };
      return makeScanResult({ totalIssues: 0 });
    };
    const callbackCalls = [];
    const sendCallback = async (args) => {
      callbackCalls.push(args);
      return { sent: true };
    };

    const result = await runWorkerTick({
      sql: SQL,
      queueStore: qs,
      runScan,
      sendCallback,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.ran, 42);
    assert.strictEqual(qs.calls.markDone.length, 1);
    assert.strictEqual(qs.calls.markDone[0].id, 42);
    assert.strictEqual(qs.calls.markFailed.length, 0);

    // Callback plumbing
    assert.strictEqual(callbackCalls.length, 1);
    assert.strictEqual(callbackCalls[0].repository, 'alice/webapp');
    assert.strictEqual(callbackCalls[0].sha, 'a'.repeat(40));
    assert.strictEqual(callbackCalls[0].ref, 'refs/heads/main');
    assert.ok(callbackCalls[0].scanResult);

    // Repo URL reconstruction carries the HOST. A job without a host column
    // is a Gluecron job (the queue's default) — until 2026-09-02 it was
    // labelled github.com, which is where findActiveByRepo then looked for
    // the org's Continuous subscription.
    assert.strictEqual(scanArgs.repoUrl, 'https://gluecron.com/alice/webapp');
  });

  it('labels a GitHub-host job with github.com so the subscription lookup hits the right host', async () => {
    const qs = makeQueueStore({ nextJob: makeJob({ host: 'github' }) });
    let scanArgs = null;
    const runScan = async (repoUrl, tier, opts) => { scanArgs = { repoUrl, tier, opts }; return { status: 'complete', totalIssues: 0, modules: [] }; };
    await runWorkerTick({ sql: SQL, queueStore: qs, runScan, sendCallback: async () => ({ sent: true }) });
    assert.strictEqual(scanArgs.repoUrl, 'https://github.com/alice/webapp');
  });

  it('does not crash when sendCallback fails', async () => {
    const qs = makeQueueStore({ nextJob: makeJob() });
    const runScan = async () => makeScanResult();
    const sendCallback = async () => {
      throw new Error('gluecron down');
    };

    const result = await runWorkerTick({
      sql: SQL,
      queueStore: qs,
      runScan,
      sendCallback,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.ran, 42);
  });
});

describe('runWorkerTick — job failure with retry', () => {
  it('calls markFailed(willRetry=true) and does NOT send callback when attempts < MAX', async () => {
    const qs = makeQueueStore({
      nextJob: makeJob({ id: 7, attempts: 2 }), // 2 < MAX_ATTEMPTS(5)
    });
    const runScan = async () =>
      // Fixture text changed 2026-08-25: '404' is now (correctly) a
      // TERMINAL error that dead-letters immediately; this test's intent is
      // the attempts-below-MAX retry path, so it needs a retryable error.
      makeScanResult({ status: 'failed', error: 'upstream returned 503' });
    const callbackCalls = [];
    const sendCallback = async (args) => {
      callbackCalls.push(args);
    };

    const result = await runWorkerTick({
      sql: SQL,
      queueStore: qs,
      runScan,
      sendCallback,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.jobId, 7);
    assert.strictEqual(result.willRetry, true);
    assert.strictEqual(qs.calls.markFailed.length, 1);
    assert.strictEqual(qs.calls.markFailed[0].willRetry, true);
    assert.match(qs.calls.markFailed[0].err, /upstream returned 503/);
    assert.strictEqual(callbackCalls.length, 0, 'no callback on retryable failure');
  });

  it('catches a throwing runScan and treats it as a failed attempt', async () => {
    const qs = makeQueueStore({ nextJob: makeJob({ attempts: 1 }) });
    const runScan = async () => {
      throw new Error('runScan blew up');
    };
    const result = await runWorkerTick({
      sql: SQL,
      queueStore: qs,
      runScan,
      sendCallback: async () => {},
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(qs.calls.markFailed.length, 1);
    assert.match(qs.calls.markFailed[0].err, /runScan blew up/);
  });
});

describe('runWorkerTick — dead-letter', () => {
  it('calls markFailed(willRetry=false) and fires error callback on final attempt', async () => {
    const qs = makeQueueStore({
      nextJob: makeJob({ id: 99, attempts: MAX_ATTEMPTS }),
    });
    const runScan = async () =>
      makeScanResult({ status: 'failed', error: 'permanent failure' });
    const callbackCalls = [];
    const sendCallback = async (args) => {
      callbackCalls.push(args);
    };

    const result = await runWorkerTick({
      sql: SQL,
      queueStore: qs,
      runScan,
      sendCallback,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.jobId, 99);
    assert.strictEqual(result.willRetry, false);
    assert.strictEqual(qs.calls.markFailed.length, 1);
    assert.strictEqual(qs.calls.markFailed[0].willRetry, false);
    assert.strictEqual(callbackCalls.length, 1, 'dead-letter must notify Gluecron');
    assert.match(callbackCalls[0].scanResult.error, /permanent failure/);
  });
});

describe('runWorkerTick — reclaim-stuck path', () => {
  it('calls reclaimStuck before claimNextJob and reports the count', async () => {
    const qs = makeQueueStore({ reclaimCount: 3, nextJob: null });
    const result = await runWorkerTick({
      sql: SQL,
      queueStore: qs,
      runScan: async () => ({}),
      sendCallback: async () => ({}),
    });
    assert.strictEqual(result.reclaimed, 3);
    assert.strictEqual(qs.calls.reclaimStuck, 1);
    assert.strictEqual(qs.calls.claimNextJob, 1);
  });
});

describe('runWorkerTick — contract guards', () => {
  it('returns { ok: false } when sql is missing', async () => {
    const result = await runWorkerTick({
      queueStore: makeQueueStore(),
      runScan: async () => ({}),
      sendCallback: async () => ({}),
    });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /sql/);
  });

  it('returns { ok: false } when queueStore is missing', async () => {
    const result = await runWorkerTick({
      sql: SQL,
      runScan: async () => ({}),
      sendCallback: async () => ({}),
    });
    assert.strictEqual(result.ok, false);
  });
});

// ---------------------------------------------------------------------------
// runWorkerTick — Continuous ($49/mo) AI budget gate (Known Issue #34)
// ---------------------------------------------------------------------------

describe('runWorkerTick — continuous AI budget gate', () => {
  it('runs the default tier unchanged when continuousStore is not provided', async () => {
    const qs = makeQueueStore({ nextJob: makeJob() });
    let tierUsed = null;
    const runScan = async (_repoUrl, tier) => {
      tierUsed = tier;
      return makeScanResult();
    };
    await runWorkerTick({ sql: SQL, queueStore: qs, runScan, sendCallback: async () => ({}) });
    assert.strictEqual(tierUsed, 'deterministic', 'every-push scans run the full deterministic engine, not the 4-module quick sample');
  });

  it('stays on deterministic when the repo has no active continuous subscription', async () => {
    const qs = makeQueueStore({ nextJob: makeJob() });
    const cs = makeContinuousStore({ subscription: null });
    let tierUsed = null;
    const runScan = async (_repoUrl, tier) => {
      tierUsed = tier;
      return makeScanResult();
    };
    await runWorkerTick({ sql: SQL, queueStore: qs, runScan, sendCallback: async () => ({}), continuousStore: cs });
    assert.strictEqual(tierUsed, 'deterministic');
    assert.strictEqual(cs.calls.checkAiAllowance.length, 0, 'never checks allowance without a subscription');
  });

  it('escalates to the full (AI-inclusive) tier when the subscription has budget remaining', async () => {
    const qs = makeQueueStore({ nextJob: makeJob() });
    const cs = makeContinuousStore({
      subscription: { stripe_subscription_id: 'sub_123' },
      allowance: { allowed: true, spentUsd: 1, remainingUsd: 9, budgetUsd: 10 },
    });
    let tierUsed = null;
    const runScan = async (_repoUrl, tier) => {
      tierUsed = tier;
      return makeScanResult();
    };
    await runWorkerTick({ sql: SQL, queueStore: qs, runScan, sendCallback: async () => ({}), continuousStore: cs });
    assert.strictEqual(tierUsed, 'full');
    assert.deepStrictEqual(cs.calls.checkAiAllowance, ['sub_123']);
  });

  it('falls back to quick when the monthly AI budget is exhausted', async () => {
    const qs = makeQueueStore({ nextJob: makeJob() });
    const cs = makeContinuousStore({
      subscription: { stripe_subscription_id: 'sub_123' },
      allowance: { allowed: false, spentUsd: 10, remainingUsd: 0, budgetUsd: 10 },
    });
    let tierUsed = null;
    const runScan = async (_repoUrl, tier) => {
      tierUsed = tier;
      return makeScanResult();
    };
    await runWorkerTick({ sql: SQL, queueStore: qs, runScan, sendCallback: async () => ({}), continuousStore: cs });
    assert.strictEqual(tierUsed, 'deterministic', 'exhausted budget must not grant AI-inclusive tier');
  });

  it('fails CLOSED to quick when checkAiAllowance throws', async () => {
    const qs = makeQueueStore({ nextJob: makeJob() });
    const cs = makeContinuousStore({
      subscription: { stripe_subscription_id: 'sub_123' },
      allowanceThrows: new Error('db down'),
    });
    let tierUsed = null;
    const runScan = async (_repoUrl, tier) => {
      tierUsed = tier;
      return makeScanResult();
    };
    const result = await runWorkerTick({ sql: SQL, queueStore: qs, runScan, sendCallback: async () => ({}), continuousStore: cs });
    assert.strictEqual(tierUsed, 'deterministic', 'a budget-check error must never grant unmetered AI spend');
    assert.strictEqual(result.ok, true, 'the tick itself still completes');
  });

  it('fails CLOSED to the deterministic tier when findActiveByRepo throws', async () => {
    const qs = makeQueueStore({ nextJob: makeJob() });
    const cs = makeContinuousStore({ findThrows: new Error('db down') });
    let tierUsed = null;
    const runScan = async (_repoUrl, tier) => {
      tierUsed = tier;
      return makeScanResult();
    };
    await runWorkerTick({ sql: SQL, queueStore: qs, runScan, sendCallback: async () => ({}), continuousStore: cs });
    assert.strictEqual(tierUsed, 'deterministic');
  });

  it('records AI spend against the subscription ledger after a scan that incurred cost', async () => {
    const qs = makeQueueStore({ nextJob: makeJob() });
    const cs = makeContinuousStore({ subscription: { stripe_subscription_id: 'sub_123' } });
    const runScan = async () =>
      makeScanResult({
        modules: [
          { name: 'lint', status: 'passed', checks: 10, issues: 0, duration: 100 },
          { name: 'aiReview', status: 'passed', checks: 3, issues: 1, duration: 900, costUsd: 0.042 },
        ],
      });
    await runWorkerTick({ sql: SQL, queueStore: qs, runScan, sendCallback: async () => ({}), continuousStore: cs });
    assert.strictEqual(cs.calls.recordAiSpend.length, 1);
    assert.strictEqual(cs.calls.recordAiSpend[0].subscriptionId, 'sub_123');
    assert.ok(Math.abs(cs.calls.recordAiSpend[0].usd - 0.042) < 1e-9);
  });

  it('does not record spend when no module incurred a cost', async () => {
    const qs = makeQueueStore({ nextJob: makeJob() });
    const cs = makeContinuousStore({ subscription: { stripe_subscription_id: 'sub_123' } });
    const runScan = async () => makeScanResult(); // default module has no costUsd
    await runWorkerTick({ sql: SQL, queueStore: qs, runScan, sendCallback: async () => ({}), continuousStore: cs });
    assert.strictEqual(cs.calls.recordAiSpend.length, 0);
  });

  it('does not crash the tick when recordAiSpend throws', async () => {
    const qs = makeQueueStore({ nextJob: makeJob() });
    const cs = makeContinuousStore({ subscription: { stripe_subscription_id: 'sub_123' } });
    cs.recordAiSpend = async () => { throw new Error('ledger write failed'); };
    const runScan = async () =>
      makeScanResult({
        modules: [{ name: 'aiReview', status: 'passed', checks: 1, issues: 0, duration: 900, costUsd: 0.01 }],
      });
    const result = await runWorkerTick({ sql: SQL, queueStore: qs, runScan, sendCallback: async () => ({}), continuousStore: cs });
    assert.strictEqual(result.ok, true);
  });
});

// ---------------------------------------------------------------------------
// MAX_DIFF_FILES — Continuous-tier ($49/mo) diff-size circuit breaker
// ---------------------------------------------------------------------------

describe('MAX_DIFF_FILES', () => {
  it('is exported as a number', () => {
    assert.strictEqual(typeof MAX_DIFF_FILES, 'number');
  });

  it('equals 20 (Continuous-tier AI-fix file cap)', () => {
    assert.strictEqual(MAX_DIFF_FILES, 20);
  });

  it('is less than 50 (the scan_fix tier fix-cap default)', () => {
    // Sanity: the $49 Continuous cap must be tighter than the $199 Scan+Fix
    // file-fix cap (default 50) to create an incentive to upgrade.
    assert.ok(MAX_DIFF_FILES < 50, 'MAX_DIFF_FILES should be below Scan+Fix cap of 50');
  });
});

// ---------------------------------------------------------------------------
// Route header contract — Vercel cron sends `Authorization: Bearer <secret>`,
// never a custom header. The internal kicks (events-push.js,
// github-events.js) send `X-Vercel-Cron-Secret`. The route must read BOTH:
// before this regression test existed, the route only read the custom header,
// so setting CRON_SECRET (fail-closed, KI #57e) would have 401'd every real
// Vercel cron invocation and silently stopped queue processing.
// ---------------------------------------------------------------------------

describe('worker tick route — cron header contract (source-text)', () => {
  const fs = require('fs');
  const routeSrc = fs.readFileSync(
    path.resolve(
      __dirname,
      '..',
      'website',
      'app',
      'api',
      'scan',
      'worker',
      'tick',
      'route.ts'
    ),
    'utf8'
  );

  it('reads the internal kick header (x-vercel-cron-secret)', () => {
    assert.match(routeSrc, /x-vercel-cron-secret/);
  });

  it('reads the Vercel cron Authorization bearer token', () => {
    assert.match(routeSrc, /headers\.get\(\s*["']authorization["']\s*\)/);
    assert.match(routeSrc, /Bearer /);
  });

  it('feeds either credential into isAuthorisedTick as cronHeader', () => {
    assert.match(
      routeSrc,
      /x-vercel-cron-secret["']\s*\)\s*\|\|\s*bearer/,
      'custom header must fall back to the bearer token'
    );
  });
});

// ── advancement #11: terminal dead-letter + callback retry ─────────────────
const { callWithRetry } = require(path.resolve(
  __dirname, '..', 'website', 'app', 'lib', 'scan-worker.js'));

describe('terminal classification in the tick', () => {
  it('a 404 scan error dead-letters on attempt 1 instead of burning retries', async () => {
    const store = makeQueueStore({ nextJob: { id: 7, event_id: 'e', repository: 'o/r', sha: 'a'.repeat(40), ref: null, pull_request_number: null, attempts: 1 } });
    const result = await runWorkerTick({
      sql: async () => [],
      queueStore: store,
      runScan: async () => ({ status: 'failed', modules: [], error: 'GitHub API 404: Not Found' }),
      sendCallback: async () => ({}),
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.terminal, true);
    assert.strictEqual(result.willRetry, false, 'terminal errors must not retry even on attempt 1');
    assert.strictEqual(store.calls.markFailed.length, 1);
    assert.strictEqual(store.calls.markFailed[0].willRetry, false);
    assert.match(store.calls.markFailed[0].err, /^\[terminal\] /);
  });

  it('a rate-limit error still retries below MAX_ATTEMPTS', async () => {
    const store = makeQueueStore({ nextJob: { id: 8, event_id: 'e', repository: 'o/r', sha: 'a'.repeat(40), ref: null, pull_request_number: null, attempts: 1 } });
    const result = await runWorkerTick({
      sql: async () => [],
      queueStore: store,
      runScan: async () => ({ status: 'failed', modules: [], error: '403 rate limit exceeded' }),
      sendCallback: async () => ({}),
    });
    assert.strictEqual(result.terminal, false);
    assert.strictEqual(result.willRetry, true);
    assert.strictEqual(store.calls.markFailed[0].willRetry, true);
  });
});

describe('callback retry', () => {
  it('callWithRetry retries transient failures then succeeds', async () => {
    let n = 0;
    const out = await callWithRetry(async () => {
      n += 1;
      if (n < 3) throw new Error('blip');
      return 'ok';
    }, { attempts: 3, delayMs: 1 });
    assert.strictEqual(out, 'ok');
    assert.strictEqual(n, 3);
  });

  it('callWithRetry throws the last error after exhausting attempts', async () => {
    let n = 0;
    await assert.rejects(
      () => callWithRetry(async () => { n += 1; throw new Error('always'); }, { attempts: 3, delayMs: 1 }),
      /always/);
    assert.strictEqual(n, 3);
  });

  it('the success callback is retried inside the tick (two blips → still delivered)', async () => {
    const store = makeQueueStore({ nextJob: { id: 9, event_id: 'e', repository: 'o/r', sha: 'a'.repeat(40), ref: null, pull_request_number: null, attempts: 1 } });
    let calls = 0;
    const result = await runWorkerTick({
      sql: async () => [],
      queueStore: store,
      runScan: async () => ({ status: 'complete', modules: [], totalModules: 1, completedModules: 1, totalIssues: 0, totalFixed: 0, duration: 1 }),
      sendCallback: async () => {
        calls += 1;
        if (calls < 3) throw new Error('network blip');
        return {};
      },
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(calls, 3, 'callback must be retried through transient failures');
  });
});
