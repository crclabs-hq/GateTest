'use strict';

// =============================================================================
// gatetest trace CLI — UNIT TESTS
// =============================================================================
// main() is exercised directly (no child_process spawn) with console.log
// captured, against a real bundle+map fixture written to a tmpdir. Same
// core engine as tests/source-map-resolver.test.js and the MCP
// resolve_stack_trace tool — this file proves the CLI wiring specifically.
// =============================================================================

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const trace = require('../bin/gatetest-trace.js');
const { encodeVLQSegment } = require('../src/core/source-map-resolver.js');

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

describe('gatetest trace — module shape', () => {
  it('exports main', () => {
    assert.strictEqual(typeof trace.main, 'function');
  });
});

describe('gatetest trace — CLI behaviour', () => {
  let dir;
  let bundlePath;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-trace-cli-'));
    bundlePath = path.join(dir, 'bundle.js');
    const mapJson = JSON.stringify({
      version: 3,
      sources: ['original.js'],
      sourcesContent: ['function add(a, b) {\n  return a + b;\n}\n'],
      names: [],
      // generatedColumn 9, sourceIndex 0, originalLine 1, originalColumn 2 (all 0-based, absolute VLQ)
      mappings: [9, 0, 1, 2].map(encodeVLQSegment).join(''),
    });
    fs.writeFileSync(bundlePath, 'function add(a,b){return a+b}\n//# sourceMappingURL=bundle.js.map\n');
    fs.writeFileSync(path.join(dir, 'bundle.js.map'), mapJson);
  });

  after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('--help prints usage and exits 0', async () => {
    const { code, logs } = await captureLogs(() => trace.main(['--help']));
    assert.strictEqual(code, 0);
    assert.match(logs.join('\n'), /gatetest trace/);
  });

  it('errors when no input is given', async () => {
    const { code, errors } = await captureLogs(() => trace.main([]));
    assert.strictEqual(code, 1);
    assert.match(errors.join('\n'), /pass a file path/);
  });

  it('resolves a stack trace read from a file', async () => {
    const stackFile = path.join(dir, 'stack.txt');
    fs.writeFileSync(stackFile, `Error: boom\n    at add (${bundlePath}:1:10)\n`);
    const { code, logs } = await captureLogs(() => trace.main([stackFile]));
    assert.strictEqual(code, 0);
    const out = logs.join('\n');
    assert.match(out, /original\.js/);
  });

  it('--json emits machine-readable output', async () => {
    const stackFile = path.join(dir, 'stack2.txt');
    fs.writeFileSync(stackFile, `    at add (${bundlePath}:1:10)\n`);
    const { code, logs } = await captureLogs(() => trace.main([stackFile, '--json']));
    assert.strictEqual(code, 0);
    const parsed = JSON.parse(logs.join('\n'));
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].resolution.ok, true);
  });
});
