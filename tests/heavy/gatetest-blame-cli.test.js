'use strict';

// =============================================================================
// gatetest blame CLI — UNIT TESTS
// =============================================================================
// main() is exercised directly against a real git repo built in a tmpdir.
// Same core engine as tests/regression-bisector.test.js and the MCP
// blame_regression tool — this file proves the CLI wiring specifically.
// =============================================================================

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const blame = require('../../bin/gatetest-blame.js');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function captureLogs(fn) {
  const logs = [];
  const errors = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => errors.push(a.join(' '));
  return Promise.resolve(fn()).finally(() => {
    console.log = origLog;
    console.error = origError;
  }).then((code) => ({ code, logs, errors }));
}

describe('gatetest blame — module shape', () => {
  it('exports main', () => {
    assert.strictEqual(typeof blame.main, 'function');
  });
});

describe('gatetest blame — CLI behaviour', () => {
  let repo;
  let commit2;

  before(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-blame-cli-'));
    git(['init', '-q'], repo);
    git(['config', 'user.email', 'test@gatetest.local'], repo);
    git(['config', 'user.name', 'GateTest Test'], repo);
    git(['config', 'commit.gpgsign', 'false'], repo);

    fs.writeFileSync(path.join(repo, 'app.js'), 'line1\nline2\n');
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'initial commit'], repo);

    fs.writeFileSync(path.join(repo, 'app.js'), 'line1\nBUGGY_LINE\n');
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'introduce the bug'], repo);
    commit2 = git(['rev-parse', 'HEAD'], repo).trim();
  });

  after(() => {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('--help prints usage and exits 0', async () => {
    const { code, logs } = await captureLogs(() => blame.main(['--help']));
    assert.strictEqual(code, 0);
    assert.match(logs.join('\n'), /gatetest blame/);
  });

  it('errors when neither file/line, commit, nor hits are given', async () => {
    const { code, errors } = await captureLogs(() => blame.main(['--project', repo]));
    assert.strictEqual(code, 1);
    assert.match(errors.join('\n'), /pass <file>/);
  });

  it('blames a single line', async () => {
    const { code, logs } = await captureLogs(() => blame.main(['app.js', '--line', '2', '--project', repo]));
    assert.strictEqual(code, 0);
    assert.match(logs.join('\n'), /introduce the bug/);
  });

  it('shows a commit directly by hash', async () => {
    const { code, logs } = await captureLogs(() => blame.main(['--commit', commit2, '--project', repo]));
    assert.strictEqual(code, 0);
    assert.match(logs.join('\n'), /BUGGY_LINE/);
  });

  it('ranks candidates from a --hits JSON file', async () => {
    const hitsFile = path.join(repo, 'hits.json');
    fs.writeFileSync(hitsFile, JSON.stringify([{ file: 'app.js', line: 2 }]));
    const { code, logs } = await captureLogs(() => blame.main(['--hits', hitsFile, '--project', repo]));
    assert.strictEqual(code, 0);
    assert.match(logs.join('\n'), /Likely regression commit/);
  });

  it('--json emits machine-readable output', async () => {
    const { code, logs } = await captureLogs(() => blame.main(['app.js', '--line', '2', '--project', repo, '--json']));
    assert.strictEqual(code, 0);
    const parsed = JSON.parse(logs.join('\n'));
    assert.strictEqual(parsed.hash, commit2);
  });

  it('surfaces a graceful error for an unknown --hits file', async () => {
    const { code, errors } = await captureLogs(() => blame.main(['--hits', '/no/such/file.json', '--project', repo]));
    assert.strictEqual(code, 1);
    assert.match(errors.join('\n'), /Error reading --hits file/);
  });
});
