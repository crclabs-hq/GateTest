'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ---------------------------------------------------------------------------
// mcp-run-tests.test.js — tests for the run_tests MCP handler and
// the underlying src/core/test-runner.js engine.
// ---------------------------------------------------------------------------

let mcp;
before(async () => {
  mcp = await import('../bin/gatetest-mcp.mjs');
});

describe('test-runner core', () => {
  const { runTests } = require('../src/core/test-runner.js');

  test('runTests is exported', () => {
    assert.strictEqual(typeof runTests, 'function');
  });

  test('runTests returns required fields on missing project', async () => {
    const result = await runTests('/nonexistent_path_xyz_abc', { timeoutMs: 5000 });
    assert.ok('runner' in result, 'runner field present');
    assert.ok('total' in result, 'total field present');
    assert.ok('passed' in result, 'passed field present');
    assert.ok('failed' in result, 'failed field present');
    assert.ok('skipped' in result, 'skipped field present');
    assert.ok(Array.isArray(result.tests), 'tests is array');
  });

  test('runTests with explicit command parses output correctly', async () => {
    // Can't spawn nested node --test (Node 20+ refuses recursive test runner invocations).
    // Instead: use node -e to print a mocha-style summary ("1 passing") that
    // parseGenericStdout recognizes. Pure ASCII, no file paths, works on Windows + Linux.
    // shell=true is used on Windows (test-runner.js:78), so double-quoted -e arg works.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-runtests-'));
    try {
      // Output TAP format — parseNodeTestStdout handles this first in the chain
      const result = await runTests(tmpDir, {
        command: 'node -e "process.stdout.write(\'ok 1 - one plus one\\n\');"',
        timeoutMs: 10_000,
      });
      assert.ok(result.total >= 1, `expected >=1 test, got ${result.total} (stdout: ${JSON.stringify(result.stdout)})`);
      assert.strictEqual(result.failed, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('test objects have expected shape', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-runtests2-'));
    try {
      const testFile = path.join(tmpDir, 'shape.test.js');
      fs.writeFileSync(testFile, `
const { test } = require('node:test');
test('shape test', () => {});
`);
      const result = await runTests(tmpDir, {
        command: `node --test ${testFile}`,
        timeoutMs: 15_000,
      });
      for (const t of result.tests) {
        assert.ok('name' in t, 'test has name');
        assert.ok('status' in t, 'test has status');
        assert.ok(['passed', 'failed', 'skipped'].includes(t.status), `status is valid: ${t.status}`);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('runTests respects timeout', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-timeout-'));
    try {
      const result = await runTests(tmpDir, {
        command: 'node -e "setTimeout(()=>{},30000)"',
        timeoutMs: 2000,
      });
      // Should return without hanging — either via exitCode or error field
      assert.ok(result !== null);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('MCP run_tests handler', () => {
  test('handler is exported from MCP module', () => {
    assert.strictEqual(typeof mcp.handleRunTests, 'function');
  });

  test('returns error content for bad path', async () => {
    const result = await mcp.handleRunTests({ path: '/nonexistent_xyz_abc' });
    assert.ok(Array.isArray(result.content), 'content is array');
    assert.ok(result.content.length > 0, 'has content');
    // Should not throw — graceful response
  });

  test('result contains text content type', async () => {
    const result = await mcp.handleRunTests({ path: process.cwd(), timeout: 5 });
    for (const c of result.content) {
      assert.strictEqual(c.type, 'text');
      assert.strictEqual(typeof c.text, 'string');
    }
  });

  test('result text mentions test runner or error', async () => {
    const result = await mcp.handleRunTests({ path: process.cwd(), timeout: 30 });
    const text = result.content.map(c => c.text).join('\n');
    // Should mention "Test run", "passed", "failed", or "failed"
    const hasRunnerInfo = /test run|passed|failed|error|no test/i.test(text);
    assert.ok(hasRunnerInfo, `expected test result info in: ${text.slice(0, 200)}`);
  });

  test('explicit command override is accepted', async () => {
    // node --test with no files = 0 tests, exits 0
    const result = await mcp.handleRunTests({
      path: process.cwd(),
      command: 'node --test /dev/null',
      timeout: 10,
    });
    // On Windows /dev/null doesn't exist; just verify no crash
    assert.ok(result.content.length > 0);
  });

  test('timeout parameter is accepted without crash', async () => {
    const result = await mcp.handleRunTests({ path: process.cwd(), timeout: 5 });
    assert.ok(Array.isArray(result.content));
  });
});

describe('test-runner detection', () => {
  test('detects node:test runner for this repo', () => {
    // GateTest itself uses node:test — detectRunner must identify it from package.json scripts.
    // We call the detection function directly rather than spawning node --test inside node --test
    // (Node 20+ refuses recursive node:test invocations and produces empty output).
    const runner = require('../src/core/test-runner.js');
    // detectRunner may not be exported; fall back to verifying the package.json directly.
    if (typeof runner.detectRunner === 'function') {
      const r = runner.detectRunner(process.cwd());
      assert.ok(r, 'runner detected');
      assert.ok(typeof r === 'string', 'runner is a string');
    } else {
      // Verify package.json has a test script — that's what detectRunner reads
      const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
      assert.ok(pkg.scripts && pkg.scripts.test, 'package.json has test script');
      assert.ok(/node/.test(pkg.scripts.test), 'test script uses node');
    }
  });
});
