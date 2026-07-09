'use strict';

// =============================================================================
// REGRESSION BISECTOR — unit tests
// =============================================================================
// Read-only git blame/log helpers. Exercised against a REAL git repo built
// in a tmpdir (three commits, one introducing a "bug" line) rather than
// mocked shell output, so the porcelain parser is proven against actual
// git output on this machine.
// =============================================================================

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  isGitRepo,
  blameLine,
  blameRange,
  showCommit,
  findLikelyRegressionCommit,
} = require('../../src/core/regression-bisector.js');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

describe('regression-bisector', () => {
  let repo;
  let commit1;
  let commit2;
  let commit3;

  before(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-blame-'));
    git(['init', '-q'], repo);
    git(['config', 'user.email', 'test@gatetest.local'], repo);
    git(['config', 'user.name', 'GateTest Test'], repo);
    git(['config', 'commit.gpgsign', 'false'], repo);

    fs.writeFileSync(path.join(repo, 'app.js'), 'line1\nline2\nline3\n');
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'initial commit'], repo);
    commit1 = git(['rev-parse', 'HEAD'], repo).trim();

    fs.writeFileSync(path.join(repo, 'app.js'), 'line1\nBUGGY_LINE\nline3\n');
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'introduce the bug'], repo);
    commit2 = git(['rev-parse', 'HEAD'], repo).trim();

    fs.writeFileSync(path.join(repo, 'app.js'), 'line1\nBUGGY_LINE\nline3\nline4\n');
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'unrelated addition'], repo);
    commit3 = git(['rev-parse', 'HEAD'], repo).trim();
  });

  after(() => {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('isGitRepo detects a real repo and rejects a non-repo dir', () => {
    assert.strictEqual(isGitRepo(repo), true);
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-notrepo-'));
    assert.strictEqual(isGitRepo(notRepo), false);
    fs.rmSync(notRepo, { recursive: true, force: true });
  });

  it('blameLine identifies the commit that introduced a specific line', () => {
    const res = blameLine({ cwd: repo, file: 'app.js', line: 2 });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.hash, commit2);
    assert.strictEqual(res.lineContent, 'BUGGY_LINE');
    assert.strictEqual(res.summary, 'introduce the bug');
    assert.ok(res.author);
    assert.ok(res.date);
  });

  it('blameLine returns a graceful failure for a missing file', () => {
    const res = blameLine({ cwd: repo, file: 'does-not-exist.js', line: 1 });
    assert.strictEqual(res.ok, false);
    assert.ok(res.reason);
  });

  it('blameLine returns a graceful failure outside a git repo', () => {
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-notrepo2-'));
    const res = blameLine({ cwd: notRepo, file: 'app.js', line: 1 });
    assert.strictEqual(res.ok, false);
    fs.rmSync(notRepo, { recursive: true, force: true });
  });

  it('blameLine requires a valid line number', () => {
    const res = blameLine({ cwd: repo, file: 'app.js', line: 0 });
    assert.strictEqual(res.ok, false);
  });

  it('blameRange ranks the distinct commits touching a range by line count', () => {
    const res = blameRange({ cwd: repo, file: 'app.js', startLine: 1, endLine: 4 });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.distinctCommits, 3);
    const hashes = res.commits.map((c) => c.hash);
    assert.ok(hashes.includes(commit1));
    assert.ok(hashes.includes(commit2));
    assert.ok(hashes.includes(commit3));
  });

  it('blameRange rejects an invalid range', () => {
    const res = blameRange({ cwd: repo, file: 'app.js', startLine: 5, endLine: 1 });
    assert.strictEqual(res.ok, false);
  });

  it('showCommit returns metadata + diff for a real commit', () => {
    const res = showCommit({ cwd: repo, hash: commit2 });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.hash, commit2);
    assert.match(res.message, /introduce the bug/);
    assert.match(res.diff, /BUGGY_LINE/);
    assert.strictEqual(res.truncated, false);
  });

  it('showCommit truncates an oversized diff', () => {
    const res = showCommit({ cwd: repo, hash: commit2, maxDiffBytes: 10 });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.truncated, true);
    assert.strictEqual(res.diff.length, 10);
  });

  it('showCommit returns a graceful failure for an unknown hash', () => {
    const res = showCommit({ cwd: repo, hash: '0000000000000000000000000000000000000000' });
    assert.strictEqual(res.ok, false);
  });

  it('findLikelyRegressionCommit ranks the commit with the most hits first', () => {
    const res = findLikelyRegressionCommit({
      cwd: repo,
      hits: [
        { file: 'app.js', line: 2 },
        { file: 'app.js', line: 2 },
        { file: 'app.js', line: 4 },
      ],
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.candidates[0].hash, commit2);
    assert.strictEqual(res.candidates[0].hitCount, 2);
    assert.strictEqual(res.perHit.length, 3);
  });

  it('findLikelyRegressionCommit rejects an empty hits array', () => {
    const res = findLikelyRegressionCommit({ cwd: repo, hits: [] });
    assert.strictEqual(res.ok, false);
  });

  it('findLikelyRegressionCommit tolerates hits that fail to blame', () => {
    const res = findLikelyRegressionCommit({
      cwd: repo,
      hits: [{ file: 'app.js', line: 2 }, { file: 'missing.js', line: 1 }],
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.candidates.length, 1);
    assert.strictEqual(res.perHit[1].blame.ok, false);
  });
});
