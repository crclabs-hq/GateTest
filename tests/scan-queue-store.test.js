// ============================================================================
// SCAN-QUEUE-STORE TEST
// ============================================================================
// Verifies the Signal Bus E1 queue helper used by /api/events/push (enqueue)
// and /api/scan/worker/tick (claim → mark done / failed / dead). Ensures:
//   - ensureScanQueueTable issues CREATE TABLE + indexes (idempotent)
//   - enqueueScan uses INSERT ... ON CONFLICT (event_id) DO NOTHING so a
//     retried Gluecron POST with the same eventId is a no-op
//   - claimNextJob atomically moves a queued row to running via FOR UPDATE
//     SKIP LOCKED
//   - markDone / markFailed / deadLetter update the right columns
//   - getQueueDepth returns the count of queued rows
//   - reclaimStuck requeues rows that have been running > 5 minutes
//   - Contract guards: missing sql, missing required fields throw
// ============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  ensureScanQueueTable,
  enqueueScan,
  claimNextJob,
  markDone,
  markFailed,
  deadLetter,
  getQueueDepth,
  reclaimStuck,
  getScanByEventId,
  normalizeHost,
  KNOWN_HOSTS,
  REPO_HOSTS,
  DEFAULT_HOST,
  MAX_ATTEMPTS,
} = require(path.resolve(
  __dirname,
  '..',
  'website',
  'app',
  'lib',
  'scan-queue-store.js'
));

/**
 * Build a fake tagged-template SQL function that records every call and
 * replays canned responses in FIFO order. Reproduces the Neon tagged-
 * template signature exactly.
 */
function makeFakeSql(responses = []) {
  const calls = [];
  const queue = [...responses];
  const fakeSql = (strings, ...values) => {
    const text = strings.join('?');
    calls.push({ text, values });
    const next = queue.length > 0 ? queue.shift() : [];
    return Promise.resolve(next);
  };
  fakeSql.calls = calls;
  return fakeSql;
}

describe('ensureScanQueueTable', () => {
  it('issues CREATE TABLE IF NOT EXISTS plus both indexes', async () => {
    const sql = makeFakeSql();
    await ensureScanQueueTable(sql);

    const joined = sql.calls.map((c) => c.text).join('\n');
    assert.match(joined, /CREATE TABLE IF NOT EXISTS scan_queue/);
    assert.match(joined, /event_id TEXT UNIQUE NOT NULL/);
    assert.match(joined, /CREATE INDEX IF NOT EXISTS idx_scan_queue_ready/);
    assert.match(joined, /CREATE INDEX IF NOT EXISTS idx_scan_queue_repo_sha/);
  });
});

describe('enqueueScan', () => {
  it('INSERTs with ON CONFLICT (event_id) DO NOTHING and returns id on first insert', async () => {
    const sql = makeFakeSql([[{ id: 42 }]]);
    const result = await enqueueScan({
      eventId: 'evt-abc-1',
      repository: 'alice/webapp',
      sha: '9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b',
      ref: 'refs/heads/main',
      pullRequestNumber: 7,
      sql,
    });

    assert.strictEqual(result.duplicate, false);
    assert.strictEqual(result.id, 42);

    assert.strictEqual(sql.calls.length, 1);
    const call = sql.calls[0];
    assert.match(call.text, /INSERT INTO\s+scan_queue/i);
    assert.match(call.text, /ON CONFLICT \(event_id\) DO NOTHING/i);
    assert.match(call.text, /RETURNING id/i);
    assert.deepStrictEqual(call.values, [
      'evt-abc-1',
      'alice/webapp',
      '9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b',
      'refs/heads/main',
      7,
      'gluecron',
      null, // base_sha — not supplied by this caller
      null, // triggered_by — documented default: unattributed
      null, // metadata — documented default: none
    ]);
  });

  it('reports duplicate when ON CONFLICT fires and no row is returned', async () => {
    const sql = makeFakeSql([[]]); // empty result set → conflict
    const result = await enqueueScan({
      eventId: 'evt-abc-1',
      repository: 'alice/webapp',
      sha: 'a'.repeat(40),
      sql,
    });
    assert.strictEqual(result.duplicate, true);
    assert.strictEqual(result.id, null);
  });

  it('normalises null pullRequestNumber and ref', async () => {
    const sql = makeFakeSql([[{ id: 1 }]]);
    await enqueueScan({
      eventId: 'evt-x',
      repository: 'alice/webapp',
      sha: 'b'.repeat(40),
      sql,
    });
    assert.deepStrictEqual(sql.calls[0].values, [
      'evt-x',
      'alice/webapp',
      'b'.repeat(40),
      null,
      null,
      'gluecron',
      null,
      null,
      null,
    ]);
  });

  it('passes host: github when explicitly set', async () => {
    const sql = makeFakeSql([[{ id: 5 }]]);
    await enqueueScan({
      eventId: 'evt-gh',
      repository: 'alice/webapp',
      sha: 'c'.repeat(40),
      host: 'github',
      sql,
    });
    const values = sql.calls[0].values;
    assert.strictEqual(values[5], 'github', `expected host='github', got ${values[5]}`);
  });

  // ── KI #113 control pair: host + triggeredBy + metadata persist ───────────
  // Before the fix, `host: 'api'` was relabelled 'gluecron' and triggeredBy /
  // metadata were not parameters at all — /api/v1/scans passed them and they
  // vanished, so no row could be matched back to the API key that made it.

  it('persists host, triggeredBy and metadata exactly as supplied (the positive control)', async () => {
    const sql = makeFakeSql([[{ id: 9 }]]);
    const metadata = { url: 'https://example.com/app', suite: 'web', callbackUrl: null, scanId: 'scn_1' };
    const result = await enqueueScan({
      eventId: 'scn_1',
      repository: 'example.com/app',
      sha: 'd'.repeat(40),
      host: 'api',
      triggeredBy: 'api_key:key_42',
      metadata,
      sql,
    });
    assert.strictEqual(result.duplicate, false);
    const call = sql.calls[0];
    assert.match(call.text, /INSERT INTO\s+scan_queue\s*\([^)]*\btriggered_by\b[^)]*\bmetadata\b/i,
      'the INSERT column list must name triggered_by and metadata');
    assert.strictEqual(call.values[5], 'api', 'host must be stored as supplied, not relabelled');
    assert.strictEqual(call.values[7], 'api_key:key_42', 'triggered_by must be stored verbatim');
    assert.deepStrictEqual(JSON.parse(call.values[8]), metadata, 'metadata must round-trip as JSON');
  });

  it('stores the documented defaults when host / triggeredBy / metadata are omitted (the negative control)', async () => {
    const sql = makeFakeSql([[{ id: 10 }]]);
    await enqueueScan({
      eventId: 'evt-default',
      repository: 'alice/webapp',
      sha: 'e'.repeat(40),
      sql,
    });
    const values = sql.calls[0].values;
    assert.strictEqual(values[5], DEFAULT_HOST, 'host defaults to the documented DEFAULT_HOST');
    assert.strictEqual(values[5], 'gluecron');
    assert.strictEqual(values[7], null, 'triggered_by defaults to null (unattributed)');
    assert.strictEqual(values[8], null, 'metadata defaults to null');
  });

  it('REJECTS an unknown host instead of relabelling it as a trusted producer', async () => {
    const sql = makeFakeSql([[{ id: 11 }]]);
    await assert.rejects(
      () => enqueueScan({ eventId: 'e', repository: 'a/b', sha: 'f'.repeat(40), host: 'bitbucket', sql }),
      /unknown host "bitbucket".*allowed: gluecron, github, api/,
    );
    assert.strictEqual(sql.calls.length, 0, 'nothing may be INSERTed for an unknown host');
  });

  it('rejects a malformed triggeredBy / metadata rather than storing garbage', async () => {
    const sql = makeFakeSql();
    const base = { eventId: 'e', repository: 'a/b', sha: 'f'.repeat(40), sql };
    await assert.rejects(() => enqueueScan({ ...base, triggeredBy: '' }), /triggeredBy must be a non-empty string/);
    await assert.rejects(() => enqueueScan({ ...base, triggeredBy: 42 }), /triggeredBy must be a non-empty string/);
    await assert.rejects(() => enqueueScan({ ...base, triggeredBy: 'x'.repeat(201) }), /exceeds 200 chars/);
    await assert.rejects(() => enqueueScan({ ...base, metadata: ['not', 'an', 'object'] }), /metadata must be a plain object/);
    assert.strictEqual(sql.calls.length, 0);
  });

  it('normalizeHost is the one definition: known hosts pass, empty → default, unknown throws', () => {
    for (const h of KNOWN_HOSTS) assert.strictEqual(normalizeHost(h), h);
    assert.strictEqual(normalizeHost(undefined), DEFAULT_HOST);
    assert.strictEqual(normalizeHost(null), DEFAULT_HOST);
    assert.strictEqual(normalizeHost(''), DEFAULT_HOST);
    assert.throws(() => normalizeHost('GitHub'), /unknown host/, 'case matters — no fuzzy trust');
    assert.throws(() => normalizeHost({}), /unknown host/);
    assert.ok(REPO_HOSTS.every((h) => KNOWN_HOSTS.includes(h)), 'every repo host is a known host');
    assert.ok(!REPO_HOSTS.includes('api'), 'api rows have no repository to fetch');
  });
});

describe('getScanByEventId', () => {
  it('SELECTs the attribution columns by event_id and returns the row', async () => {
    const row = {
      id: 3, event_id: 'scn_abc', repository: 'example.com/_root_', sha: 'a'.repeat(40), ref: null,
      pull_request_number: null, host: 'api', triggered_by: 'api_key:key_42',
      metadata: { url: 'https://example.com', suite: 'web' }, status: 'queued', attempts: 0,
      last_error: null, result_json: null, created_at: '2026-09-16T00:00:00Z', started_at: null, completed_at: null,
    };
    const sql = makeFakeSql([[row]]);
    const got = await getScanByEventId('scn_abc', sql);
    assert.deepStrictEqual(got, row);
    const call = sql.calls[0];
    assert.match(call.text, /SELECT[\s\S]*\bhost\b[\s\S]*\btriggered_by\b[\s\S]*\bmetadata\b[\s\S]*FROM scan_queue/i);
    assert.match(call.text, /WHERE event_id = \?/);
    assert.deepStrictEqual(call.values, ['scn_abc']);
  });

  it('returns null when no row matches, and throws on a missing sql / eventId', async () => {
    const sql = makeFakeSql([[]]);
    assert.strictEqual(await getScanByEventId('scn_missing', sql), null);
    await assert.rejects(() => getScanByEventId('scn_x'), /sql tagged-template is required/);
    await assert.rejects(() => getScanByEventId('', sql), /eventId is required/);
  });
});

describe('claimNextJob — attribution travels with the claimed row', () => {
  it('RETURNING includes triggered_by and metadata so the worker sees who asked', async () => {
    const sql = makeFakeSql([[{ id: 1, host: 'api', triggered_by: 'api_key:k', metadata: { url: 'https://x' } }]]);
    const job = await claimNextJob(sql);
    assert.match(sql.calls[0].text, /RETURNING[\s\S]*q\.triggered_by[\s\S]*q\.metadata/);
    assert.strictEqual(job.triggered_by, 'api_key:k');
  });

  it('throws when eventId / repository / sha / sql are missing', async () => {
    const sql = makeFakeSql();
    await assert.rejects(
      () => enqueueScan({ repository: 'a/b', sha: 'x', sql }),
      /eventId is required/
    );
    await assert.rejects(
      () => enqueueScan({ eventId: 'e', sha: 'x', sql }),
      /repository is required/
    );
    await assert.rejects(
      () => enqueueScan({ eventId: 'e', repository: 'a/b', sql }),
      /sha is required/
    );
    await assert.rejects(
      () => enqueueScan({ eventId: 'e', repository: 'a/b', sha: 'x' }),
      /sql tagged-template is required/
    );
  });
});

describe('claimNextJob', () => {
  it('runs a CTE with FOR UPDATE SKIP LOCKED and returns the claimed row', async () => {
    const claimed = {
      id: 1,
      event_id: 'evt-1',
      repository: 'alice/webapp',
      sha: 'c'.repeat(40),
      ref: 'refs/heads/main',
      pull_request_number: null,
      attempts: 1,
    };
    const sql = makeFakeSql([[claimed]]);
    const job = await claimNextJob(sql);
    assert.deepStrictEqual(job, claimed);

    const call = sql.calls[0];
    assert.match(call.text, /FOR UPDATE SKIP LOCKED/i);
    assert.match(call.text, /UPDATE scan_queue/i);
    assert.match(call.text, /status = 'running'/);
    assert.match(call.text, /attempts = q\.attempts \+ 1/);
  });

  it('returns null when the queue is empty', async () => {
    const sql = makeFakeSql([[]]);
    const job = await claimNextJob(sql);
    assert.strictEqual(job, null);
  });
});

describe('markDone / markFailed / deadLetter', () => {
  it('markDone sets status=done, stamps completed_at, stores result_json', async () => {
    const sql = makeFakeSql([[]]);
    await markDone(7, { modules: [], totalIssues: 0 }, sql);
    const call = sql.calls[0];
    assert.match(call.text, /SET status = 'done'/);
    assert.match(call.text, /completed_at = NOW\(\)/);
    assert.match(call.text, /result_json = /);
    // The serialised JSON must be passed as a parameter, not interpolated.
    const jsonParam = call.values.find(
      (v) => typeof v === 'string' && v.includes('"totalIssues"')
    );
    assert.ok(jsonParam, 'result JSON is passed as a parameter');
    assert.strictEqual(call.values[call.values.length - 1], 7);
  });

  it('markFailed with willRetry=true requeues with backoff next_run_at', async () => {
    // First call: SELECT attempts (returns 2 → backoff index 1 → 120s).
    // Second call: the UPDATE.
    const sql = makeFakeSql([[{ attempts: 2 }], []]);
    await markFailed(9, new Error('boom'), true, sql);
    assert.strictEqual(sql.calls.length, 2);
    const update = sql.calls[1];
    assert.match(update.text, /SET status = 'queued'/);
    assert.match(update.text, /last_error = /);
    assert.match(update.text, /next_run_at = NOW\(\) \+ /);
    // The error text and backoff value should be in the values array.
    assert.ok(update.values.includes('boom'));
    assert.ok(update.values.some((v) => typeof v === 'number' && v > 0));
  });

  it('markFailed with willRetry=false marks status=dead', async () => {
    const sql = makeFakeSql([[]]);
    await markFailed(10, 'hard failure', false, sql);
    const call = sql.calls[0];
    assert.match(call.text, /SET status = 'dead'/);
    assert.match(call.text, /last_error = /);
    assert.ok(call.values.includes('hard failure'));
  });

  it('deadLetter is an alias for markFailed(willRetry=false)', async () => {
    const sql = makeFakeSql([[]]);
    await deadLetter(11, 'gave up', sql);
    assert.match(sql.calls[0].text, /SET status = 'dead'/);
  });
});

describe('getQueueDepth', () => {
  it('returns the count of status=queued rows', async () => {
    const sql = makeFakeSql([[{ depth: 17 }]]);
    const depth = await getQueueDepth(sql);
    assert.strictEqual(depth, 17);
    assert.match(sql.calls[0].text, /COUNT\(\*\)/);
    assert.match(sql.calls[0].text, /status = 'queued'/);
  });

  it('returns 0 when the query returns no rows', async () => {
    const sql = makeFakeSql([[]]);
    const depth = await getQueueDepth(sql);
    assert.strictEqual(depth, 0);
  });
});

describe('reclaimStuck', () => {
  it('requeues rows stuck in running > 5 minutes and returns the count', async () => {
    const sql = makeFakeSql([[{ id: 1 }, { id: 2 }]]);
    const n = await reclaimStuck(sql);
    assert.strictEqual(n, 2);
    const call = sql.calls[0];
    assert.match(call.text, /UPDATE scan_queue/i);
    assert.match(call.text, /SET status = 'queued'/);
    assert.match(call.text, /status = 'running'/);
    assert.match(call.text, /started_at < NOW\(\) - INTERVAL '5 minutes'/);
  });

  it('returns 0 when nothing was reclaimed', async () => {
    const sql = makeFakeSql([[]]);
    const n = await reclaimStuck(sql);
    assert.strictEqual(n, 0);
  });
});

describe('contract guards', () => {
  it('exports MAX_ATTEMPTS for retry-budget decisions', () => {
    assert.strictEqual(typeof MAX_ATTEMPTS, 'number');
    assert.ok(MAX_ATTEMPTS >= 3);
  });

  it('every helper rejects when sql tagged-template is missing', async () => {
    await assert.rejects(() => claimNextJob(), /sql tagged-template is required/);
    await assert.rejects(
      () => markDone(1, {}),
      /sql tagged-template is required/
    );
    await assert.rejects(
      () => markFailed(1, 'x', true),
      /sql tagged-template is required/
    );
    await assert.rejects(() => getQueueDepth(), /sql tagged-template is required/);
    await assert.rejects(() => reclaimStuck(), /sql tagged-template is required/);
  });
});

// ── advancement #11: terminal classification + queue stats ─────────────────
const { isTerminalScanError, getQueueStats } = require(require('path').resolve(
  __dirname, '..', 'website', 'app', 'lib', 'scan-queue-store.js'));

describe('isTerminalScanError — retrying cannot fix these', () => {
  it('terminal: 404 / bad credentials / empty repo / archived', () => {
    for (const msg of [
      'GitHub API 404: Not Found',
      'clone failed: repository not found',
      '401 Bad credentials',
      'empty repository — nothing to scan',
      'Repository access blocked',
      'this repository has been archived',
    ]) {
      assert.strictEqual(isTerminalScanError(msg), true, msg);
    }
  });

  it('retryable: rate limits, timeouts, 5xx, network errors', () => {
    for (const msg of [
      'GitHub API 403: rate limit exceeded',
      'secondary limit hit, retry later',
      'fetch failed: ETIMEDOUT',
      'ECONNRESET while downloading archive',
      'upstream returned 503',
      'scan crashed: socket hang up',
    ]) {
      assert.strictEqual(isTerminalScanError(msg), false, msg);
    }
  });

  it('a 404 message that also mentions a rate limit stays retryable', () => {
    assert.strictEqual(isTerminalScanError('404 from api (rate limit exceeded)'), false);
  });

  it('empty/absent messages are not terminal', () => {
    assert.strictEqual(isTerminalScanError(''), false);
    assert.strictEqual(isTerminalScanError(null), false);
  });
});

describe('getQueueStats', () => {
  it('maps grouped counts and oldest queued age', async () => {
    const sql = async () => [
      { status: 'queued', n: 3, oldest_age_s: 120 },
      { status: 'running', n: 1, oldest_age_s: 10 },
      { status: 'done', n: 40, oldest_age_s: 90000 },
      { status: 'dead', n: 2, oldest_age_s: 500 },
    ];
    const s = await getQueueStats(sql);
    assert.deepStrictEqual(s, { queued: 3, running: 1, done: 40, dead: 2, oldest_queued_age_s: 120 });
  });

  it('empty queue → zeros and null age', async () => {
    const s = await getQueueStats(async () => []);
    assert.deepStrictEqual(s, { queued: 0, running: 0, done: 0, dead: 0, oldest_queued_age_s: null });
  });

  it('requires sql', async () => {
    await assert.rejects(() => getQueueStats(), /sql tagged-template is required/);
  });
});
