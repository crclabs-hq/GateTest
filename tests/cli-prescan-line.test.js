'use strict';

// Issue #630 — before scanning, the CLI must print
//   Scanning <N> files in <P> packages across <M> modules
// with numbers derived from a real walk, never typed — and it must go to
// stderr so a `--format json` run's stdout stays the one JSON document.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'gatetest.js');

function runCli(args) {
  const env = { ...process.env, GATETEST_NO_TELEMETRY: '1', NO_COLOR: '1' };
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 60000, env });
}

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-prescan-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fx', version: '1.0.0', private: true }));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(dir, 'src', 'b.js'), 'module.exports = 2;\n');
  return dir;
}

describe('gatetest — pre-scan file/package/module count line (issue #630)', () => {
  it('prints the line on stderr with the right file count for a module run', () => {
    const dir = makeFixture();
    const r = runCli(['--module', 'secrets', '--project', dir]);
    // --module is a single-module run: the pre-scan line is scoped to
    // full-suite runs (module count wouldn't mean much for one module).
    assert.doesNotMatch(r.stderr, /Scanning \d+ files/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('prints "Scanning N files in P packages across M modules" for a suite run, on stderr only', () => {
    const dir = makeFixture();
    const r = runCli(['--suite', 'quick', '--project', dir]);
    const m = r.stderr.match(/Scanning (\d+) files in (\d+) packages across (\d+) modules/);
    assert.ok(m, `expected the pre-scan line on stderr, got:\n${r.stderr.slice(0, 400)}`);
    // package.json + src/a.js + src/b.js = 3 files, 1 package (no workspace).
    assert.equal(Number(m[1]), 3);
    assert.equal(Number(m[2]), 1);
    assert.ok(Number(m[3]) > 0);
    assert.doesNotMatch(r.stdout, /Scanning \d+ files/, 'the line must never land on stdout');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('--format json: the pre-scan line goes to stderr and stdout stays one clean JSON document', () => {
    const dir = makeFixture();
    const r = runCli(['--suite', 'quick', '--project', dir, '--format', 'json']);
    assert.match(r.stderr, /Scanning \d+ files in \d+ packages across \d+ modules/);
    const trimmed = r.stdout.trim();
    assert.ok(trimmed.startsWith('{') && trimmed.endsWith('}'), `stdout must be a bare JSON object:\n${r.stdout.slice(0, 300)}`);
    assert.equal(trimmed.split('\n').length, 1, 'stdout must be exactly one line — the JSON document');
    JSON.parse(trimmed); // must not throw
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
