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

    // Repo URL reconstruction
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
      makeScanResult({ status: 'failed', error: 'GitHub 404' });
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
    assert.match(qs.calls.markFailed[0].err, /GitHub 404/);
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
    assert.strictEqual(tierUsed, 'quick');
  });

  it('stays on quick when the repo has no active continuous subscription', async () => {
    const qs = makeQueueStore({ nextJob: makeJob() });
    const cs = makeContinuousStore({ subscription: null });
    let tierUsed = null;
    const runScan = async (_repoUrl, tier) => {
      tierUsed = tier;
      return makeScanResult();
    };
    await runWorkerTick({ sql: SQL, queueStore: qs, runScan, sendCallback: async () => ({}), continuousStore: cs });
    assert.strictEqual(tierUsed, 'quick');
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
    assert.strictEqual(tierUsed, 'quick', 'exhausted budget must not grant AI-inclusive tier');
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
    assert.strictEqual(tierUsed, 'quick', 'a budget-check error must never grant unmetered AI spend');
    assert.strictEqual(result.ok, true, 'the tick itself still completes');
  });

  it('fails CLOSED to quick when findActiveByRepo throws', async () => {
    const qs = makeQueueStore({ nextJob: makeJob() });
    const cs = makeContinuousStore({ findThrows: new Error('db down') });
    let tierUsed = null;
    const runScan = async (_repoUrl, tier) => {
      tierUsed = tier;
      return makeScanResult();
    };
    await runWorkerTick({ sql: SQL, queueStore: qs, runScan, sendCallback: async () => ({}), continuousStore: cs });
    assert.strictEqual(tierUsed, 'quick');
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
