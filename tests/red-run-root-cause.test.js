'use strict';

// =============================================================================
// RED-RUN ROOT CAUSE — Launch Board move 12 / complaint C21
// =============================================================================
// A BLOCKED verdict that doesn't say WHY, WHICH COMMIT, and HOW TO REPLAY
// costs more than the test was worth. Covers:
//   - each classifyRootCause rule, in priority order
//   - bounded blame resolution against a real temp git repo
//   - the no-line and not-a-git-checkout cases
//   - the replay command, local and CI forms
//   - JSON / SARIF / PR-comment presence of the three fields
//   - a PASSED run prints / carries none of it
// =============================================================================

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  classifyRootCause,
  resolveSince,
  resolveReplay,
  localReplayCommand,
  buildRootCause,
} = require('../src/core/root-cause');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function passedCheck(overrides = {}) {
  return { passed: true, severity: 'error', ...overrides };
}

function blockingCheck(overrides = {}) {
  return { passed: false, severity: 'error', confidence: 1, name: 'some-check', ...overrides };
}

describe('classifyRootCause — rule order', () => {
  it('rule 1: config/usage error wins even when blocking findings also exist', () => {
    const c = classifyRootCause({
      results: [{ module: 'secrets', checks: [blockingCheck({ file: 'a.js', line: 1 })] }],
      failedModules: [{ module: 'typescriptStrict', error: 'Cannot find module "./tsconfig.json"' }],
      diffOnly: false,
      changedFiles: null,
    });
    assert.strictEqual(c.class, 'config-error');
    assert.match(c.why, /^config error: typescriptStrict/);
    assert.deepStrictEqual(c.hits, []);
  });

  it('rule 2: budget-limited (module timeout) when no non-timeout failure exists', () => {
    const c = classifyRootCause({
      results: [],
      failedModules: [{ module: 'mutation', error: 'Module "mutation" timed out after 600000ms — skipped, scan continues' }],
      diffOnly: false,
      changedFiles: null,
    });
    assert.strictEqual(c.class, 'budget-limited');
    assert.match(c.why, /^budget-limited: mutation/);
  });

  it('does NOT classify a module as config-error just because it failed the gate with real findings (regression: forced red run on the secrets module)', () => {
    // src/core/runner.js puts a module in `failedModules` both when it
    // crashes AND when it simply found confident errors
    // (`result.fail('N error(s): ...')` when blockingErrorChecks.length > 0).
    // Only the crash case — zero recorded checks — is a config/usage error.
    const c = classifyRootCause({
      results: [{ module: 'secrets', checks: [blockingCheck({ name: 'secrets:secrets.js', file: 'secrets.js', line: 1 })] }],
      failedModules: [{ module: 'secrets', error: '1 error(s): secrets:secrets.js', failedChecks: [{ name: 'secrets:secrets.js' }] }],
      diffOnly: false,
      changedFiles: null,
    });
    assert.strictEqual(c.class, 'new-findings');
    assert.strictEqual(c.why, '1 new secrets finding');
  });

  it('a config error is preferred over a timeout when both kinds of module failed', () => {
    const c = classifyRootCause({
      results: [],
      failedModules: [
        { module: 'mutation', error: 'Module "mutation" timed out after 600000ms — skipped, scan continues' },
        { module: 'terraform', error: 'ENOENT: no such file or directory' },
      ],
      diffOnly: false,
      changedFiles: null,
    });
    assert.strictEqual(c.class, 'config-error');
  });

  it('rule 3: failing unit tests, named and counted', () => {
    const c = classifyRootCause({
      results: [
        {
          module: 'unitTests',
          checks: [
            blockingCheck({ name: 'clamp', file: 'src/math.js', line: 12 }),
            blockingCheck({ name: 'clampMax', file: 'src/math.js', line: 20 }),
          ],
        },
      ],
      failedModules: [],
      diffOnly: false,
      changedFiles: null,
    });
    assert.strictEqual(c.class, 'failing-tests');
    assert.strictEqual(c.why, 'unit tests: 2 failing, clamp');
    assert.strictEqual(c.hits.length, 2);
  });

  it('rule 4: new findings in changed files, scoped to the diff', () => {
    const c = classifyRootCause({
      results: [
        {
          module: 'secrets',
          checks: [
            blockingCheck({ name: 'hardcoded-key', file: 'src/app.js', line: 5 }),
            blockingCheck({ name: 'hardcoded-key-2', file: 'src/other.js', line: 9 }),
          ],
        },
      ],
      failedModules: [],
      diffOnly: true,
      changedFiles: ['src/app.js'],
    });
    assert.strictEqual(c.class, 'new-findings-changed');
    assert.strictEqual(c.why, '1 new secrets finding in files changed by this diff');
    assert.strictEqual(c.hits.length, 1);
    assert.strictEqual(c.hits[0].file, 'src/app.js');
  });

  it('rule 5: new findings elsewhere when diff mode finds nothing in the changed set', () => {
    const c = classifyRootCause({
      results: [{ module: 'secrets', checks: [blockingCheck({ file: 'src/other.js', line: 9 })] }],
      failedModules: [],
      diffOnly: true,
      changedFiles: ['src/app.js'],
    });
    assert.strictEqual(c.class, 'new-findings');
    assert.strictEqual(c.why, '1 new secrets finding');
  });

  it('rule 5: new findings elsewhere, pluralised, outside diff mode', () => {
    const c = classifyRootCause({
      results: [
        {
          module: 'secrets',
          checks: [
            blockingCheck({ file: 'a.js', line: 1 }),
            blockingCheck({ file: 'b.js', line: 2 }),
          ],
        },
      ],
      failedModules: [],
      diffOnly: false,
      changedFiles: null,
    });
    assert.strictEqual(c.class, 'new-findings');
    assert.strictEqual(c.why, '2 new secrets findings');
  });

  it('rule 6: unknown when nothing above explains a blocked gate', () => {
    const c = classifyRootCause({
      results: [{ module: 'secrets', checks: [passedCheck()] }],
      failedModules: [],
      diffOnly: false,
      changedFiles: null,
    });
    assert.strictEqual(c.class, 'unknown');
    assert.match(c.why, /^unknown/);
    assert.deepStrictEqual(c.hits, []);
  });
});

describe('resolveSince — bounded git blame', () => {
  let repo;
  let bugCommit;

  before(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-rootcause-'));
    git(['init', '-q'], repo);
    git(['config', 'user.email', 'test@gatetest.local'], repo);
    git(['config', 'user.name', 'GateTest Test'], repo);
    git(['config', 'commit.gpgsign', 'false'], repo);

    fs.writeFileSync(path.join(repo, 'app.js'), 'line1\nline2\nline3\n');
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'initial commit'], repo);

    fs.writeFileSync(path.join(repo, 'app.js'), 'line1\nBUGGY_LINE\nline3\n');
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'introduce the bug'], repo);
    bugCommit = git(['rev-parse', 'HEAD'], repo).trim();
  });

  after(() => {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* error-ok — temp dir cleanup */ }
  });

  it('resolves the commit that introduced the blocking line', () => {
    const since = resolveSince({ hits: [{ file: 'app.js', line: 2 }], projectRoot: repo });
    assert.strictEqual(since.commit.sha, bugCommit);
    assert.strictEqual(since.commit.subject, 'introduce the bug');
    assert.match(since.text, new RegExp(`^${bugCommit.slice(0, 8)} introduce the bug`));
  });

  it('is bounded to 10 findings regardless of how many blocking findings exist', () => {
    // 25 hits in, at most MAX_BLAME_FINDINGS (10) ever reach `git blame` —
    // verified by an explicit skip count rather than wall-clock, since a
    // loaded shared machine can make even 10 fast local `git blame` calls
    // cross an assertion window (flaky) without the bounding logic itself
    // being wrong.
    const manyHits = Array.from({ length: 25 }, () => ({ file: 'app.js', line: 2 }));
    const since = resolveSince({ hits: manyHits, projectRoot: repo });
    assert.strictEqual(since.commit.sha, bugCommit);
    // At least the 15 over the MAX_BLAME_FINDINGS cap are always skipped;
    // a slow/loaded machine may also trip the 5s wall-clock deadline and
    // skip a few of the remaining 10, so this is a floor, not an exact count.
    const match = since.text.match(/skipped \((\d+) findings\)/);
    assert.ok(match, `expected a skipped-count suffix, got: ${since.text}`);
    assert.ok(Number(match[1]) >= 15, `expected at least 15 skipped, got: ${match[1]}`);
  });

  it('the deadline itself is enforced (findLikelyRegressionCommit), independent of machine speed', () => {
    // A near-zero deadline must skip every hit rather than block on any of
    // them — proves the bound is real and not just the caller's 10-item
    // slice. Exercises the shared primitive root-cause.js builds on
    // (Doctrine #4 — one definition).
    const { findLikelyRegressionCommit } = require('../src/core/regression-bisector');
    const hits = Array.from({ length: 5 }, () => ({ file: 'app.js', line: 2 }));
    const result = findLikelyRegressionCommit({ cwd: repo, hits, deadlineMs: -1000 });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.skipped, 5);
    assert.strictEqual(result.candidates.length, 0);
  });

  it('says "unknown (no line)" when no finding carries a resolvable line', () => {
    const since = resolveSince({ hits: [], projectRoot: repo });
    assert.strictEqual(since.commit, null);
    assert.strictEqual(since.text, 'unknown (no line)');
  });

  it('says "not a git checkout" outside a git repo', () => {
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-rootcause-notrepo-'));
    const since = resolveSince({ hits: [{ file: 'app.js', line: 2 }], projectRoot: notRepo });
    assert.strictEqual(since.commit, null);
    assert.strictEqual(since.text, 'not a git checkout');
    fs.rmSync(notRepo, { recursive: true, force: true });
  });

  it('never blames wrongly: an unresolvable hit (untracked file) reports unknown, not a guess', () => {
    const since = resolveSince({ hits: [{ file: 'does-not-exist.js', line: 1 }], projectRoot: repo });
    assert.strictEqual(since.commit, null);
    assert.match(since.text, /^unknown \(no line\)/);
  });
});

describe('resolveReplay / localReplayCommand — local and CI forms', () => {
  it('local form: suite + project', () => {
    const cmd = localReplayCommand({ suite: 'standard', moduleName: null, projectRoot: '/repo' });
    assert.strictEqual(cmd, 'gatetest --suite standard --project /repo');
  });

  it('local form: single module takes precedence over suite', () => {
    const cmd = localReplayCommand({ suite: 'standard', moduleName: 'secrets', projectRoot: '/repo' });
    assert.strictEqual(cmd, 'gatetest --module secrets --project /repo');
  });

  it('resolveReplay falls back to the local form outside CI', () => {
    const cmd = resolveReplay({ suite: 'quick', moduleName: null, projectRoot: '/repo', env: {} });
    assert.strictEqual(cmd, 'gatetest --suite quick --project /repo');
  });

  it('resolveReplay prefers the CI form when a GitHub Actions run URL is resolvable', () => {
    const env = {
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'crclabs-hq/GateTest',
      GITHUB_RUN_ID: '12345',
      GITHUB_SERVER_URL: 'https://github.com',
    };
    const cmd = resolveReplay({ suite: 'quick', moduleName: null, projectRoot: '/repo', env });
    assert.strictEqual(cmd, 'npx gatetest replay https://github.com/crclabs-hq/GateTest/actions/runs/12345');
  });
});

describe('buildRootCause — the full three-field block', () => {
  let repo;
  let bugCommit;

  before(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-rootcause-build-'));
    git(['init', '-q'], repo);
    git(['config', 'user.email', 'test@gatetest.local'], repo);
    git(['config', 'user.name', 'GateTest Test'], repo);
    git(['config', 'commit.gpgsign', 'false'], repo);
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'app.js'), 'const ok = 1;\n');
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'initial'], repo);
    fs.writeFileSync(path.join(repo, 'src', 'app.js'), 'const ok = 1;\nconst secret = "hardcoded";\n');
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'introduce hardcoded secret'], repo);
    bugCommit = git(['rev-parse', 'HEAD'], repo).trim();
  });

  after(() => {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* error-ok — temp dir cleanup */ }
  });

  it('produces why / since / replay together for a blocked run', () => {
    const rootCause = buildRootCause({
      results: [{ module: 'secrets', checks: [blockingCheck({ name: 'hardcoded-secret', file: 'src/app.js', line: 2 })] }],
      failedModules: [],
      diffOnly: false,
      changedFiles: null,
      confidenceThreshold: 0.7,
      projectRoot: repo,
      suite: 'standard',
      moduleName: null,
      env: {},
    });
    assert.strictEqual(rootCause.why, '1 new secrets finding');
    assert.strictEqual(rootCause.since.sha, bugCommit);
    assert.strictEqual(rootCause.since.subject, 'introduce hardcoded secret');
    assert.ok(rootCause.since.author);
    assert.ok(rootCause.since.date);
    assert.strictEqual(rootCause.replay, `gatetest --suite standard --project ${repo}`);
  });
});

describe('JSON / SARIF / PR-comment surfaces carry the same three fields', () => {
  it('the JSON reporter carries summary.rootCause verbatim', () => {
    // JsonReporter writes to disk keyed off the runner's config; exercising
    // the object shape it emits is the contract this test cares about
    // without standing up a full runner (already covered end-to-end by the
    // forced-red-run verification in the PR description).
    const { JsonReporter } = require('../src/reporters/json-reporter');
    assert.strictEqual(typeof JsonReporter, 'function');

    const fakeRunner = { on: () => {} };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-jsonreport-'));
    const fakeConfig = { projectRoot: tmp, get: () => '.gatetest/reports' };
    const reporter = new JsonReporter(fakeRunner, fakeConfig);
    const rootCause = { why: '1 new secrets finding', since: { sha: 'abc123', subject: 'x', author: 'a', date: 'd' }, replay: 'gatetest --suite standard --project .' };
    reporter._onSuiteEnd({
      timestamp: new Date().toISOString(),
      gateStatus: 'BLOCKED',
      duration: 1,
      modules: { total: 1, passed: 0, failed: 1, skipped: 0 },
      checks: { total: 1, passed: 0, failed: 1, errors: 1 },
      nothingChecked: false,
      results: [],
      failedModules: [],
      findings: [],
      findingSummary: null,
      rootCause,
    });
    const written = JSON.parse(fs.readFileSync(path.join(tmp, '.gatetest', 'reports', 'gatetest-report-latest.json'), 'utf8'));
    assert.deepStrictEqual(written.summary.rootCause, rootCause);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('the SARIF reporter carries run-level properties.rootCause when present, and omits it on PASSED', () => {
    const { SarifReporter } = require('../src/reporters/sarif-reporter');
    const fakeRunner = { on: () => {} };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-sarif-'));
    const fakeConfig = { projectRoot: tmp };
    const reporter = new SarifReporter(fakeRunner, fakeConfig);

    const rootCause = { why: 'budget-limited: mutation — timed out', since: { sha: null, subject: 'unknown (no line)', author: null, date: null }, replay: 'gatetest --suite full --project .' };
    const blockedSarif = reporter._buildSarif({ results: [], confidenceThreshold: 0.7, gateStatus: 'BLOCKED', timestamp: new Date().toISOString(), rootCause });
    assert.deepStrictEqual(blockedSarif.runs[0].properties.rootCause, rootCause);

    const passedSarif = reporter._buildSarif({ results: [], confidenceThreshold: 0.7, gateStatus: 'PASSED', timestamp: new Date().toISOString(), rootCause: null });
    assert.strictEqual(passedSarif.runs[0].properties, undefined);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('the PR summary comment renders a Root cause section when present, and omits it when absent', () => {
    const { renderBody } = require('../scripts/post-scan-summary-comment');
    const grade = { grade: 'F', score: 0, passed: 0, total: 1, errors: 1, warnings: 0, findings: [] };
    const withCause = renderBody({
      grade,
      runUrl: 'https://example.com',
      rootCause: { why: '1 new secrets finding', since: { sha: 'abcdef1234', subject: 'introduce it' }, replay: 'gatetest --suite standard --project .' },
    });
    assert.match(withCause, /Root cause/);
    assert.match(withCause, /\*\*why:\*\* 1 new secrets finding/);
    assert.match(withCause, /\*\*since:\*\* abcdef12 introduce it/);
    assert.match(withCause, /\*\*replay:\*\* `gatetest --suite standard --project \.`/);

    const withoutCause = renderBody({ grade, runUrl: 'https://example.com', rootCause: null });
    assert.doesNotMatch(withoutCause, /Root cause/);
  });
});

describe('a PASSED run prints / carries none of the root-cause block', () => {
  it('console reporter shows nothing when gateStatus is PASSED, even with rootCause set on the summary', () => {
    const { ConsoleReporter } = require('../src/reporters/console-reporter');
    const events = {};
    const fakeRunner = { on: (evt, cb) => { events[evt] = cb; }, options: {} };
    const reporter = new ConsoleReporter(fakeRunner);

    const originalLog = console.log;
    const lines = [];
    console.log = (...args) => lines.push(args.join(' '));
    try {
      events['suite:end']({
        gateStatus: 'PASSED',
        // Defensive: even if something upstream set this on a PASSED
        // summary, the reporter must gate on gateStatus, not on presence.
        rootCause: { why: 'should never print', since: { sha: null, subject: 'x' }, replay: 'gatetest --suite quick --project .' },
        results: [],
        modules: { total: 1, passed: 1, failed: 0, skipped: 0 },
        checks: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0, total_actionable: 0 },
        fixes: { total: 0 },
        duration: 1,
        timestamp: new Date().toISOString(),
        failedModules: [],
      });
    } finally {
      console.log = originalLog;
    }
    const joined = lines.join('\n');
    assert.doesNotMatch(joined, /why:/);
    assert.doesNotMatch(joined, /since:/);
    assert.doesNotMatch(joined, /replay:/);
  });

  it('runner.js never invokes root-cause classification when the gate passes', () => {
    // classifyRootCause on an empty/clean input would itself say 'unknown';
    // the contract under test is that runner.js's gate on `gateStatus ===
    // 'BLOCKED'` (src/core/runner.js) is what keeps summary.rootCause null
    // on a green run — verified directly against the source text so a
    // future edit that removes the gate fails loudly here rather than only
    // in an end-to-end scan.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'runner.js'), 'utf8');
    assert.match(src, /gateStatus === 'BLOCKED'[\s\S]{0,200}buildRootCause/);
  });
});
