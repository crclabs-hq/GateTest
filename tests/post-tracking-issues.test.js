// =============================================================================
// POST-TRACKING-ISSUES TEST — scripts/post-tracking-issues.js
// =============================================================================
// Covers finding-collection, marker hashing, idempotent upsert via the
// signature marker, and the end-to-end runIssueTracker against fixtures.
// All HTTP is mocked.
// =============================================================================

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  findingHash,
  markerFor,
  collectUntrackedFindings,
  renderTrackingIssue,
  upsertTrackingIssues,
  runIssueTracker,
} = require('../scripts/post-tracking-issues');

// ─── findingHash + markerFor ───────────────────────────────────────────────
describe('findingHash / markerFor', () => {
  it('hashes (module, file, line, name) into a stable 12-char id', () => {
    const h1 = findingHash({ module: 'ssrf', file: 'a.ts', line: 10, name: 'tainted-url' });
    const h2 = findingHash({ module: 'ssrf', file: 'a.ts', line: 10, name: 'tainted-url' });
    assert.strictEqual(h1, h2, 'same finding must produce same hash');
    assert.strictEqual(h1.length, 12);
    assert.ok(/^[a-f0-9]+$/.test(h1), 'hash must be hex');
  });

  it('produces different hashes for findings on different lines', () => {
    const a = findingHash({ module: 'ssrf', file: 'a.ts', line: 10, name: 'x' });
    const b = findingHash({ module: 'ssrf', file: 'a.ts', line: 11, name: 'x' });
    assert.notStrictEqual(a, b);
  });

  it('markerFor wraps the hash in an HTML comment that survives markdown', () => {
    const m = markerFor({ module: 'm', file: 'f', line: 1, name: 'n' });
    assert.match(m, /^<!-- gatetest-bot:finding:[a-f0-9]+ -->$/);
  });
});

// ─── collectUntrackedFindings ──────────────────────────────────────────────
describe('collectUntrackedFindings', () => {
  function makeReport(checks) {
    return { results: [{ module: 'security', checks }] };
  }

  it('returns error-severity findings the auto-fixer did not patch', () => {
    const report = makeReport([
      { name: 'a', passed: false, severity: 'error', file: 'fixed.ts', line: 5, message: 'x' },  // patched → skip
      { name: 'b', passed: false, severity: 'error', file: 'unfixed.ts', line: 10, message: 'y' }, // → collected
      { name: 'c', passed: false, severity: 'warning', file: 'also-unfixed.ts', line: 1 },        // warning → skip
      { name: 'd', passed: true, severity: 'error', file: 'pass.ts', line: 1 },                    // passed → skip
    ]);
    const got = collectUntrackedFindings({
      gateReport: report,
      patchedFiles: new Set(['fixed.ts']),
    });
    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0].name, 'b');
    assert.strictEqual(got[0].file, 'unfixed.ts');
    assert.strictEqual(got[0].line, 10);
  });

  it('includes file-less findings (config-level rules) as repo-wide entries', () => {
    const report = makeReport([
      { name: 'no-permissions', passed: false, severity: 'error', message: 'permissions block missing' },
    ]);
    const got = collectUntrackedFindings({ gateReport: report });
    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0].file, null);
    assert.match(got[0].message, /permissions block missing/);
  });

  it('caps the result list at the supplied max (prevents spam)', () => {
    const checks = [];
    for (let i = 0; i < 50; i += 1) {
      checks.push({ name: `f${i}`, passed: false, severity: 'error', file: `f${i}.ts`, line: i, message: 'x' });
    }
    const got = collectUntrackedFindings({ gateReport: makeReport(checks), max: 10 });
    assert.strictEqual(got.length, 10);
  });

  it('returns [] when the report is empty / missing / malformed', () => {
    assert.deepStrictEqual(collectUntrackedFindings({ gateReport: null }), []);
    assert.deepStrictEqual(collectUntrackedFindings({ gateReport: {} }), []);
    assert.deepStrictEqual(collectUntrackedFindings({ gateReport: { results: [] } }), []);
  });

  it('skips pure-info "scanning N files" entries (no message AND no file)', () => {
    const report = makeReport([
      { name: 'scanning', passed: false, severity: 'error' }, // no file, no message → skip
      { name: 'real', passed: false, severity: 'error', file: 'a.ts', message: 'real bug' },
    ]);
    const got = collectUntrackedFindings({ gateReport: report });
    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0].name, 'real');
  });
});

// ─── renderTrackingIssue ───────────────────────────────────────────────────
describe('renderTrackingIssue', () => {
  it('renders a marker-prefixed body GitHub markdown understands', () => {
    const { title, body } = renderTrackingIssue({
      module: 'ssrf',
      name: 'tainted-url-to-fetch',
      file: 'src/api.ts',
      line: 12,
      message: 'User input handed to fetch() without validation',
      suggestion: 'Validate the hostname against an allowlist',
      severity: 'error',
    });
    assert.match(title, /\[GateTest\] ssrf: src\/api\.ts:12/);
    assert.match(body, /<!-- gatetest-bot:finding:[a-f0-9]+ -->/);
    assert.match(body, /Suggested fix/);
    assert.match(body, /Why this is an Issue, not an auto-fix PR/);
  });

  it('handles file-less repo-wide findings cleanly', () => {
    const { title, body } = renderTrackingIssue({
      module: 'ciSecurity',
      name: 'no-permissions',
      file: null,
      message: 'workflow missing top-level permissions block',
      severity: 'error',
    });
    assert.match(title, /\(repo-wide\)/);
    assert.match(body, /repo-wide finding/);
  });
});

// ─── upsertTrackingIssues — fetch-mocked ───────────────────────────────────
function makeFetchMock(responses) {
  const calls = [];
  let i = 0;
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init: init || {} });
      const r = responses[i++] || { status: 200, body: [] };
      return {
        status: r.status,
        json: async () => r.body || [],
      };
    },
  };
}

describe('upsertTrackingIssues', () => {
  const fixedFinding = { module: 'ssrf', name: 'tainted', file: 'src/a.ts', line: 5, message: 'x', severity: 'error' };

  it('POSTs a new issue when no prior issue with the marker exists', async () => {
    const { fetchImpl, calls } = makeFetchMock([
      { status: 200, body: [] },                  // GET issues (page 1, empty)
      { status: 201, body: { number: 42 } },       // POST issue
    ]);
    const r = await upsertTrackingIssues({
      findings: [fixedFinding],
      owner: 'o', repo: 'r', token: 't', fetchImpl,
    });
    assert.strictEqual(r.opened, 1);
    assert.strictEqual(r.skipped, 0);
    assert.strictEqual(calls[1].init.method, 'POST');
    const posted = JSON.parse(calls[1].init.body);
    assert.match(posted.title, /\[GateTest\] ssrf:/);
    assert.deepStrictEqual(posted.labels, ['gatetest', 'bot']);
  });

  it('SKIPS when a prior open issue with the same marker exists', async () => {
    const priorMarker = markerFor(fixedFinding);
    const { fetchImpl, calls } = makeFetchMock([
      // List page 1: one matching open issue
      { status: 200, body: [{ number: 7, body: `${priorMarker}\nold issue` }] },
      // No POST should fire
    ]);
    const r = await upsertTrackingIssues({
      findings: [fixedFinding],
      owner: 'o', repo: 'r', token: 't', fetchImpl,
    });
    assert.strictEqual(r.opened, 0);
    assert.strictEqual(r.skipped, 1);
    assert.strictEqual(calls.length, 1, 'must NOT have POSTed a duplicate');
  });

  it('handles a mix of new + duplicate findings in one batch', async () => {
    const dupFinding = { module: 'ssrf', name: 'dup', file: 'a.ts', line: 1, message: 'x', severity: 'error' };
    const newFinding = { module: 'secrets', name: 'leak', file: 'b.ts', line: 2, message: 'y', severity: 'error' };
    const { fetchImpl } = makeFetchMock([
      // List: one matching (dup) issue
      { status: 200, body: [{ number: 1, body: markerFor(dupFinding) }] },
      // POST for newFinding
      { status: 201, body: { number: 99 } },
    ]);
    const r = await upsertTrackingIssues({
      findings: [dupFinding, newFinding],
      owner: 'o', repo: 'r', token: 't', fetchImpl,
    });
    assert.strictEqual(r.opened, 1);
    assert.strictEqual(r.skipped, 1);
    assert.strictEqual(r.total, 2);
  });

  it('reports non-201 POST as skipped + continues with the rest', async () => {
    const a = { module: 'a', name: 'x', file: 'a.ts', line: 1, message: 'a', severity: 'error' };
    const b = { module: 'b', name: 'y', file: 'b.ts', line: 1, message: 'b', severity: 'error' };
    const { fetchImpl } = makeFetchMock([
      { status: 200, body: [] },                // list empty
      { status: 422, body: {} },                // POST fails for a
      { status: 201, body: { number: 5 } },     // POST succeeds for b
    ]);
    const r = await upsertTrackingIssues({
      findings: [a, b],
      owner: 'o', repo: 'r', token: 't', fetchImpl,
    });
    assert.strictEqual(r.opened, 1);
    assert.strictEqual(r.skipped, 1);
    assert.strictEqual(r.errors, 0);
  });
});

// ─── runIssueTracker — end-to-end with fixtures ────────────────────────────
describe('runIssueTracker', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-track-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('no-ops when the gate report does not exist', async () => {
    const { fetchImpl } = makeFetchMock([]);
    const r = await runIssueTracker({
      workspace: tmp, owner: 'o', repo: 'r', token: 't', fetchImpl,
    });
    assert.strictEqual(r.opened, 0);
    assert.strictEqual(r.details[0].reason, 'no-gate-report');
  });

  it('reads gate + patch snapshots and opens issues for what was not patched', async () => {
    fs.mkdirSync(path.join(tmp, '.gatetest', 'reports'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.gatetest', 'reports', 'gatetest-results.json'),
      JSON.stringify({
        results: [{
          module: 'ssrf',
          checks: [
            { name: 'patched-bug', passed: false, severity: 'error', file: 'src/fixed.ts', line: 5, message: 'fix landed' },
            { name: 'unpatched-bug', passed: false, severity: 'error', file: 'src/other.ts', line: 9, message: 'needs human' },
          ],
        }],
      }),
    );
    fs.writeFileSync(
      path.join(tmp, '.gatetest', 'fix-patches.json'),
      JSON.stringify([{ file: 'src/fixed.ts', newContent: '...' }]),
    );

    const { fetchImpl, calls } = makeFetchMock([
      { status: 200, body: [] },                   // list issues
      { status: 201, body: { number: 7 } },        // POST one issue
    ]);
    const r = await runIssueTracker({
      workspace: tmp, owner: 'o', repo: 'r', token: 't', fetchImpl,
    });
    assert.strictEqual(r.opened, 1, `expected 1 issue, got ${JSON.stringify(r)}`);
    const posted = JSON.parse(calls[1].init.body);
    assert.match(posted.title, /src\/other\.ts:9/);
    assert.doesNotMatch(posted.title, /src\/fixed\.ts/);
  });
});
