// =============================================================================
// SESSION TELEMETRY TEST
// =============================================================================
// Tests for website/app/lib/session-telemetry.js
// Validates the capture-every-fix pathway that closes the "flywheel only
// learns from production runs" gap.
// =============================================================================

'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ST = require('../../website/app/lib/session-telemetry.js');

let tmpRoot;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-st-'));
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function tmpJsonl() {
  return path.join(fs.mkdtempSync(path.join(tmpRoot, 'case-')), 'fixes.jsonl');
}

function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Module shape
// ---------------------------------------------------------------------------

describe('session-telemetry — module shape', () => {
  it('exports the documented API', () => {
    assert.strictEqual(typeof ST.recordSessionFix, 'function');
    assert.strictEqual(typeof ST.ingestGitHistory, 'function');
    assert.strictEqual(typeof ST.summariseSessionFixes, 'function');
    assert.strictEqual(typeof ST.defaultSessionFixPath, 'function');
  });

  it('defaultSessionFixPath returns ~/.gatetest/session-fixes.jsonl', () => {
    const p = ST.defaultSessionFixPath();
    assert.ok(p.endsWith(path.join('.gatetest', 'session-fixes.jsonl')));
  });
});

// ---------------------------------------------------------------------------
// Sanitisation
// ---------------------------------------------------------------------------

describe('session-telemetry — sanitisation', () => {
  it('clamps long strings', () => {
    const huge = 'x'.repeat(5000);
    const rec = ST._sanitiseRecord({ subject: huge, bugPattern: huge, module: huge });
    assert.ok(rec.subject.length <= 200);
    assert.ok(rec.bugPattern.length <= 300);
    assert.ok(rec.module.length <= 100);
  });

  it('clamps file list to 50 entries', () => {
    const files = Array.from({ length: 100 }, (_, i) => `src/m${i}.js`);
    const rec = ST._sanitiseRecord({ filesChanged: files });
    assert.strictEqual(rec.filesChanged.length, 50);
  });

  it('coerces non-finite numerics to 0', () => {
    const rec = ST._sanitiseRecord({ testsAdded: NaN, sourceFilesChanged: 'lots' });
    assert.strictEqual(rec.testsAdded, 0);
    assert.strictEqual(rec.sourceFilesChanged, 0);
  });

  it('null/undefined fields become null, not "undefined" strings', () => {
    const rec = ST._sanitiseRecord({});
    assert.strictEqual(rec.subject, null);
    assert.strictEqual(rec.module, null);
    assert.strictEqual(rec.bugPattern, null);
  });

  it('rejects array-typed strings', () => {
    const rec = ST._sanitiseRecord({ subject: ['a', 'b'] });
    assert.strictEqual(rec.subject, null);
  });
});

// ---------------------------------------------------------------------------
// recordSessionFix
// ---------------------------------------------------------------------------

describe('session-telemetry — recordSessionFix', () => {
  it('writes one JSON line per call', () => {
    const p = tmpJsonl();
    ST.recordSessionFix({ commitSha: 'abc', subject: 'fix(x): a', module: 'x', testsAdded: 3 }, { path: p });
    ST.recordSessionFix({ commitSha: 'def', subject: 'fix(y): b', module: 'y', testsAdded: 5 }, { path: p });
    const records = readJsonl(p);
    assert.strictEqual(records.length, 2);
    assert.strictEqual(records[0].commitSha, 'abc');
    assert.strictEqual(records[1].testsAdded, 5);
  });

  it('never throws on undefined entry', () => {
    const p = tmpJsonl();
    assert.doesNotThrow(() => ST.recordSessionFix(undefined, { path: p }));
    assert.doesNotThrow(() => ST.recordSessionFix(null, { path: p }));
  });

  it('never throws on unwritable path', () => {
    // Use a path whose parent is a regular file — mkdirSync fails fast
    // with ENOTDIR, hits our warnOnce branch, returns silently.
    const blockerDir = fs.mkdtempSync(path.join(tmpRoot, 'block-'));
    const blockerFile = path.join(blockerDir, 'iAmFile');
    fs.writeFileSync(blockerFile, 'x');
    const unwritable = path.join(blockerFile, 'nope.jsonl'); // file/parent → ENOTDIR
    assert.doesNotThrow(() => ST.recordSessionFix({ commitSha: 'x' }, { path: unwritable }));
  });

  it('records ISO ts automatically', () => {
    const p = tmpJsonl();
    ST.recordSessionFix({ commitSha: 'abc' }, { path: p });
    const records = readJsonl(p);
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(records[0].ts));
  });
});

// ---------------------------------------------------------------------------
// attributeModule helper
// ---------------------------------------------------------------------------

describe('session-telemetry — attributeModule', () => {
  it('extracts module from "fix(<module>):" subject', () => {
    assert.strictEqual(ST._attributeModule('fix(crossFileTaint): something', []), 'crossFileTaint');
    assert.strictEqual(ST._attributeModule('feat+fix(ssrf): something', []), 'ssrf');
  });

  it('falls back to src/modules/<x>.js path when subject lacks scope', () => {
    assert.strictEqual(ST._attributeModule('fix: something', ['src/modules/links.js']), 'links');
  });

  it('falls back to website/app/lib/<x>.js path', () => {
    assert.strictEqual(ST._attributeModule('fix: something', ['website/app/lib/health-score.js']), 'health-score');
  });

  it('returns null when no clue', () => {
    assert.strictEqual(ST._attributeModule('fix: something', ['README.md']), null);
  });
});

// ---------------------------------------------------------------------------
// FIX_COMMIT_RE — what counts as a fix commit
// ---------------------------------------------------------------------------

describe('session-telemetry — FIX_COMMIT_RE', () => {
  const re = ST._FIX_COMMIT_RE;
  it('matches conventional fix shapes', () => {
    for (const s of ['fix: a', 'fix(scope): a', 'feat+fix: a', 'hotfix: a', 'patch: a']) {
      assert.ok(re.test(s), s);
    }
  });
  it('does NOT match non-fix commits', () => {
    for (const s of ['feat: a', 'docs: a', 'chore: a', 'refactor: a', 'random commit']) {
      assert.ok(!re.test(s), `should not match ${s}`);
    }
  });
});

// ---------------------------------------------------------------------------
// ingestGitHistory — end-to-end against a real ephemeral git repo
// ---------------------------------------------------------------------------

describe('session-telemetry — ingestGitHistory (real git)', () => {
  let repoRoot;
  let jsonlPath;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(tmpRoot, 'repo-'));
    jsonlPath = path.join(repoRoot, '.session-fixes.jsonl');
    execFileSync('git', ['-C', repoRoot, 'init', '-q', '-b', 'main']);
    execFileSync('git', ['-C', repoRoot, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', repoRoot, 'config', 'user.name', 'Test']);
    // Disable commit signing — container's signing server is internal and
    // declines synthetic test commits. Per-repo override only.
    execFileSync('git', ['-C', repoRoot, 'config', 'commit.gpgsign', 'false']);
    execFileSync('git', ['-C', repoRoot, 'config', 'tag.gpgsign', 'false']);
  });

  function commit(message, files = {}) {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(repoRoot, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    execFileSync('git', ['-C', repoRoot, 'add', '-A']);
    execFileSync('git', [
      '-C', repoRoot, '-c', 'commit.gpgsign=false',
      'commit', '-m', message, '--allow-empty', '--quiet',
    ]);
  }

  it('records one entry per fix commit', () => {
    commit('chore: setup', { 'src/modules/foo.js': '// foo' });
    commit('fix(foo): patch the bug', { 'src/modules/foo.js': '// foo v2', 'tests/foo.test.js': "it('works', () => {});\nit('also', () => {});" });
    commit('docs: notes', { 'README.md': '# hi' });
    commit('hotfix: bar', { 'src/modules/bar.js': '// bar' });

    const stats = ST.ingestGitHistory({ repoRoot, path: jsonlPath, since: '1 year ago' });
    assert.strictEqual(stats.scanned, 4);
    assert.strictEqual(stats.recorded, 2, 'fix(foo) + hotfix = 2 records');

    const records = readJsonl(jsonlPath);
    assert.strictEqual(records.length, 2);
    const fooRec = records.find((r) => r.subject.startsWith('fix(foo)'));
    assert.strictEqual(fooRec.module, 'foo');
    assert.ok(fooRec.filesChanged.includes('src/modules/foo.js'));
    assert.ok(fooRec.testsAdded >= 1, 'should count added test lines');
  });

  it('is idempotent — second run skips already-recorded SHAs', () => {
    commit('fix(x): one', { 'src/modules/x.js': '1' });
    commit('fix(y): two', { 'src/modules/y.js': '2' });

    const r1 = ST.ingestGitHistory({ repoRoot, path: jsonlPath, since: '1 year ago' });
    const r2 = ST.ingestGitHistory({ repoRoot, path: jsonlPath, since: '1 year ago' });

    assert.strictEqual(r1.recorded, 2);
    assert.strictEqual(r2.recorded, 0);
    assert.strictEqual(r2.skipped, 2);
    assert.strictEqual(readJsonl(jsonlPath).length, 2);
  });

  it('counts test lines from numstat (added-only)', () => {
    commit('fix(z): adds tests', {
      'src/modules/z.js': 'const x = 1;\n',
      'tests/z.test.js': "it('a', () => {});\nit('b', () => {});\nit('c', () => {});\n",
    });
    ST.ingestGitHistory({ repoRoot, path: jsonlPath, since: '1 year ago' });
    const rec = readJsonl(jsonlPath)[0];
    assert.ok(rec.testsAdded >= 3, `expected ≥ 3 testsAdded, got ${rec.testsAdded}`);
  });

  it('handles a non-git directory without throwing', () => {
    const notRepo = fs.mkdtempSync(path.join(tmpRoot, 'not-git-'));
    const stats = ST.ingestGitHistory({ repoRoot: notRepo, path: jsonlPath });
    assert.strictEqual(stats.scanned, 0);
    assert.strictEqual(stats.recorded, 0);
  });
});

// ---------------------------------------------------------------------------
// summariseSessionFixes
// ---------------------------------------------------------------------------

describe('session-telemetry — summariseSessionFixes', () => {
  it('aggregates fixes, tests, and per-module counts', async () => {
    const p = tmpJsonl();
    ST.recordSessionFix({ commitSha: 'a', module: 'x', testsAdded: 3 }, { path: p });
    ST.recordSessionFix({ commitSha: 'b', module: 'x', testsAdded: 1 }, { path: p });
    ST.recordSessionFix({ commitSha: 'c', module: 'y', testsAdded: 5 }, { path: p });

    const summary = await ST.summariseSessionFixes({ path: p });
    assert.strictEqual(summary.totalFixes, 3);
    assert.strictEqual(summary.totalTestsAdded, 9);
    assert.strictEqual(summary.fixesByModule.x, 2);
    assert.strictEqual(summary.fixesByModule.y, 1);
    assert.ok(summary.earliestTs <= summary.latestTs);
  });

  it('returns empty stats when file missing', async () => {
    const summary = await ST.summariseSessionFixes({ path: '/tmp/__definitely-not-here__.jsonl' });
    assert.strictEqual(summary.totalFixes, 0);
    assert.strictEqual(summary.totalTestsAdded, 0);
  });

  it('skips malformed JSONL lines', async () => {
    const p = tmpJsonl();
    fs.writeFileSync(p, 'not json\n{"commitSha":"x","testsAdded":2}\nalso garbage\n');
    const summary = await ST.summariseSessionFixes({ path: p });
    assert.strictEqual(summary.totalFixes, 1);
    assert.strictEqual(summary.totalTestsAdded, 2);
  });

  it('windows by since/until', async () => {
    const p = tmpJsonl();
    fs.writeFileSync(p, [
      JSON.stringify({ commitSha: 'old', ts: '2020-01-01T00:00:00Z', testsAdded: 1 }),
      JSON.stringify({ commitSha: 'new', ts: '2026-05-19T00:00:00Z', testsAdded: 2 }),
    ].join('\n') + '\n');
    const summary = await ST.summariseSessionFixes({ path: p, since: new Date('2025-01-01T00:00:00Z') });
    assert.strictEqual(summary.totalFixes, 1, 'only the new commit');
    assert.strictEqual(summary.totalTestsAdded, 2);
  });
});
