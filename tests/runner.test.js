const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  GateTestRunner, TestResult, Severity,
  DEFAULT_MODULE_TIMEOUT_MS, HEAVY_MODULE_TIMEOUT_MS, HEAVY_MODULES,
} = require('../src/core/runner');
const { GateTestConfig } = require('../src/core/config');
const { MemoryStore } = require('../src/core/memory');

describe('TestResult', () => {
  it('should track check pass/fail', () => {
    const result = new TestResult('test-module');
    result.start();
    result.addCheck('check-1', true);
    result.addCheck('check-2', false, { message: 'failed' });
    result.addCheck('check-3', true);

    assert.strictEqual(result.passedChecks.length, 2);
    assert.strictEqual(result.failedChecks.length, 1);
    assert.strictEqual(result.failedChecks[0].name, 'check-2');
  });

  it('should calculate duration', () => {
    const result = new TestResult('test-module');
    result.start();
    result.pass();
    assert.ok(result.duration >= 0);
    assert.strictEqual(result.status, 'passed');
  });

  it('should serialize to JSON', () => {
    const result = new TestResult('test-module');
    result.start();
    result.addCheck('check-1', true);
    result.pass();

    const json = result.toJSON();
    assert.strictEqual(json.module, 'test-module');
    assert.strictEqual(json.status, 'passed');
    assert.strictEqual(json.totalChecks, 1);
    assert.strictEqual(json.passedChecks, 1);
    assert.strictEqual(json.failedChecks, 0);
  });

  it('should track severity levels', () => {
    const result = new TestResult('test-module');
    result.start();
    result.addCheck('err', false, { severity: 'error' });
    result.addCheck('warn', false, { severity: 'warning' });
    result.addCheck('info', true, { severity: 'info' });

    assert.strictEqual(result.errorChecks.length, 1);
    assert.strictEqual(result.warningChecks.length, 1);
    assert.strictEqual(result.infoChecks.length, 1);
    assert.strictEqual(result.failedChecks.length, 2);
  });

  it('should default failed checks to error severity', () => {
    const result = new TestResult('test-module');
    result.start();
    result.addCheck('fail-no-severity', false, { message: 'oops' });

    assert.strictEqual(result.errorChecks.length, 1);
    assert.strictEqual(result.errorChecks[0].severity, 'error');
  });

  it('should track auto-fixes', () => {
    const result = new TestResult('test-module');
    result.start();
    result.addFix('check-1', 'Fixed trailing whitespace', ['src/foo.js']);

    assert.strictEqual(result.fixes.length, 1);
    assert.strictEqual(result.fixes[0].check, 'check-1');
    assert.strictEqual(result.fixes[0].filesChanged.length, 1);

    const json = result.toJSON();
    assert.strictEqual(json.fixes, 1);
    assert.strictEqual(json.appliedFixes.length, 1);
  });

  it('should include errors/warnings/fixes in JSON serialization', () => {
    const result = new TestResult('test-module');
    result.start();
    result.addCheck('err', false, { severity: 'error' });
    result.addCheck('warn', false, { severity: 'warning' });
    result.addCheck('ok', true);
    result.addFix('err', 'auto-fixed', []);
    result.pass();

    const json = result.toJSON();
    assert.strictEqual(json.errors, 1);
    assert.strictEqual(json.warnings, 1);
    assert.strictEqual(json.fixes, 1);
  });
});

describe('Severity', () => {
  it('should export severity constants', () => {
    assert.strictEqual(Severity.ERROR, 'error');
    assert.strictEqual(Severity.WARNING, 'warning');
    assert.strictEqual(Severity.INFO, 'info');
  });
});

describe('GateTestRunner', () => {
  it('should run registered modules', async () => {
    const config = new GateTestConfig(path.resolve(__dirname, '..'));
    const runner = new GateTestRunner(config);

    runner.register('mock', {
      async run(result) {
        result.addCheck('mock-check', true, { message: 'ok' });
      },
    });

    const summary = await runner.run(['mock']);
    assert.strictEqual(summary.gateStatus, 'PASSED');
    assert.strictEqual(summary.modules.passed, 1);
    assert.strictEqual(summary.modules.failed, 0);
  });

  it('should block gate on failure', async () => {
    const config = new GateTestConfig(path.resolve(__dirname, '..'));
    const runner = new GateTestRunner(config);

    runner.register('failing', {
      async run(result) {
        result.addCheck('bad-check', false, { message: 'something broke' });
      },
    });

    const summary = await runner.run(['failing']);
    assert.strictEqual(summary.gateStatus, 'BLOCKED');
    assert.strictEqual(summary.modules.failed, 1);
    assert.strictEqual(summary.checks.failed, 1);
  });

  it('should skip unregistered modules', async () => {
    const config = new GateTestConfig(path.resolve(__dirname, '..'));
    const runner = new GateTestRunner(config);

    const summary = await runner.run(['nonexistent']);
    assert.strictEqual(summary.modules.skipped, 1);
  });

  it('should handle module errors gracefully', async () => {
    const config = new GateTestConfig(path.resolve(__dirname, '..'));
    const runner = new GateTestRunner(config);

    runner.register('crashing', {
      async run() {
        throw new Error('Module exploded');
      },
    });

    const summary = await runner.run(['crashing']);
    assert.strictEqual(summary.gateStatus, 'BLOCKED');
    assert.strictEqual(summary.modules.failed, 1);
  });

  it('does NOT hang forever on a module that never resolves (Known Issue #40)', async () => {
    const config = new GateTestConfig(path.resolve(__dirname, '..'));
    // Tiny override so the test doesn't wait out the real 2-minute default.
    const runner = new GateTestRunner(config, { moduleTimeouts: { hanging: 25 } });

    runner.register('hanging', {
      run() {
        // A promise that never settles — simulates an infinite loop / stuck
        // subprocess on a pathological repo shape.
        return new Promise(() => {});
      },
    });

    const summary = await runner.run(['hanging']);
    assert.strictEqual(summary.gateStatus, 'BLOCKED');
    assert.strictEqual(summary.modules.failed, 1);
    assert.match(summary.failedModules[0].error, /timed out after 25ms/);
  });

  it('gives heavy modules (mutation/e2e/visual/chaos) a longer default timeout', () => {
    const config = new GateTestConfig(path.resolve(__dirname, '..'));
    const runner = new GateTestRunner(config);

    assert.strictEqual(runner._moduleTimeoutMs('mutation'), HEAVY_MODULE_TIMEOUT_MS);
    assert.strictEqual(runner._moduleTimeoutMs('e2e'), HEAVY_MODULE_TIMEOUT_MS);
    assert.strictEqual(runner._moduleTimeoutMs('lint'), DEFAULT_MODULE_TIMEOUT_MS);
    assert.ok(HEAVY_MODULES.has('visual') && HEAVY_MODULES.has('chaos'));
  });

  it('per-module timeout override wins over the heavy/default split', () => {
    const config = new GateTestConfig(path.resolve(__dirname, '..'));
    const runner = new GateTestRunner(config, { moduleTimeouts: { mutation: 5000, lint: 9000 } });

    assert.strictEqual(runner._moduleTimeoutMs('mutation'), 5000);
    assert.strictEqual(runner._moduleTimeoutMs('lint'), 9000);
  });

  it('a slow-but-finishing module completes normally under its timeout', async () => {
    const config = new GateTestConfig(path.resolve(__dirname, '..'));
    const runner = new GateTestRunner(config, { moduleTimeouts: { slow: 5000 } });

    runner.register('slow', {
      async run(result) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        result.addCheck('slow-check', true);
      },
    });

    const summary = await runner.run(['slow']);
    assert.strictEqual(summary.gateStatus, 'PASSED');
    assert.strictEqual(summary.modules.passed, 1);
  });

  it('should pass gate when only warnings exist (no errors)', async () => {
    const config = new GateTestConfig(path.resolve(__dirname, '..'));
    const runner = new GateTestRunner(config);

    runner.register('warns', {
      async run(result) {
        result.addCheck('warning-check', false, { severity: 'warning', message: 'just a warning' });
        result.addCheck('ok-check', true);
      },
    });

    const summary = await runner.run(['warns']);
    assert.strictEqual(summary.gateStatus, 'PASSED');
    assert.strictEqual(summary.checks.warnings, 1);
    assert.strictEqual(summary.checks.errors, 0);
  });

  it('should block gate when errors exist alongside warnings', async () => {
    const config = new GateTestConfig(path.resolve(__dirname, '..'));
    const runner = new GateTestRunner(config);

    runner.register('mixed', {
      async run(result) {
        result.addCheck('warn', false, { severity: 'warning' });
        result.addCheck('err', false, { severity: 'error' });
      },
    });

    const summary = await runner.run(['mixed']);
    assert.strictEqual(summary.gateStatus, 'BLOCKED');
    assert.strictEqual(summary.checks.errors, 1);
    assert.strictEqual(summary.checks.warnings, 1);
  });

  it('should run modules in parallel when enabled', async () => {
    const config = new GateTestConfig(path.resolve(__dirname, '..'));
    const runner = new GateTestRunner(config, { parallel: true });
    const order = [];

    runner.register('a', {
      async run(result) {
        order.push('a');
        result.addCheck('a', true);
      },
    });
    runner.register('b', {
      async run(result) {
        order.push('b');
        result.addCheck('b', true);
      },
    });

    const summary = await runner.run(['a', 'b']);
    assert.strictEqual(summary.gateStatus, 'PASSED');
    assert.strictEqual(summary.modules.passed, 2);
  });

  it('should stop on first failure when enabled', async () => {
    const config = new GateTestConfig(path.resolve(__dirname, '..'));
    const runner = new GateTestRunner(config, { stopOnFirstFailure: true });

    runner.register('fail', {
      async run(result) {
        result.addCheck('x', false, { severity: 'error' });
      },
    });
    runner.register('skip', {
      async run(result) {
        result.addCheck('y', true);
      },
    });

    const summary = await runner.run(['fail', 'skip']);
    assert.strictEqual(summary.modules.failed, 1);
    assert.strictEqual(summary.modules.total, 1);
  });

  it('should run auto-fixes when enabled', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-runner-autofix-'));
    try {
      const config = new GateTestConfig(tmpDir);
      const runner = new GateTestRunner(config, { autoFix: true });
      let fixRan = false;

      runner.register('fixable', {
        async run(result) {
          result.addCheck('fixme', false, {
            severity: 'error',
            autoFix: async () => {
              fixRan = true;
              return { fixed: true, description: 'Auto-fixed the issue' };
            },
          });
        },
      });

      const summary = await runner.run(['fixable']);
      assert.strictEqual(fixRan, true);
      assert.strictEqual(summary.fixes.total, 1);
      // After fix, the module should pass
      assert.strictEqual(summary.gateStatus, 'PASSED');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should include diff metadata in summary', async () => {
    const config = new GateTestConfig(path.resolve(__dirname, '..'));
    const runner = new GateTestRunner(config, {
      diffOnly: true,
      changedFiles: ['src/index.js', 'src/core/runner.js'],
    });

    runner.register('noop', {
      async run(result) {
        result.addCheck('ok', true);
      },
    });

    const summary = await runner.run(['noop']);
    assert.strictEqual(summary.diffOnly, true);
    assert.deepStrictEqual(summary.changedFiles, ['src/index.js', 'src/core/runner.js']);
  });

  it('records applied fixes into MemoryStore (memory-aware auto-fix)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-runner-memfix-'));
    try {
      const config = new GateTestConfig(tmpDir);
      const runner = new GateTestRunner(config, { autoFix: true });

      runner.register('pylike', {
        async run(result) {
          result.addCheck('python:eval:src/a.py:10', false, {
            severity: 'error',
            autoFix: async () => ({
              fixed: true,
              description: 'Replaced eval with ast.literal_eval',
              filesChanged: ['src/a.py'],
            }),
          });
          result.addCheck('python:eval:src/b.py:5', false, {
            severity: 'error',
            autoFix: async () => ({
              fixed: true,
              description: 'Replaced eval with direct call',
              filesChanged: ['src/b.py'],
            }),
          });
        },
      });

      await runner.run(['pylike']);

      const store = new MemoryStore(tmpDir);
      const db = store.getFixPatterns();
      assert.ok(db.patterns['python:eval'], 'python:eval pattern must be persisted');
      assert.strictEqual(db.patterns['python:eval'].count, 2);
      // Newest example first, with description
      assert.ok(db.patterns['python:eval'].examples[0].description.includes('direct call'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not record fix when auto-fix fails', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-runner-nofix-'));
    try {
      const config = new GateTestConfig(tmpDir);
      const runner = new GateTestRunner(config, { autoFix: true });

      runner.register('nope', {
        async run(result) {
          result.addCheck('rust:unwrap:src/main.rs:3', false, {
            severity: 'warning',
            autoFix: async () => ({ fixed: false }),
          });
        },
      });

      await runner.run(['nope']);

      const store = new MemoryStore(tmpDir);
      const db = store.getFixPatterns();
      assert.deepStrictEqual(db.patterns, {}, 'no patterns should be recorded when fix failed');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should report fix details in summary', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-runner-fixdetails-'));
    try {
      const config = new GateTestConfig(tmpDir);
      const runner = new GateTestRunner(config, { autoFix: true });

      runner.register('fixable', {
        async run(result) {
          result.addCheck('fix1', false, {
            severity: 'error',
            autoFix: async () => ({ fixed: true, description: 'Removed trailing space', filesChanged: ['a.js'] }),
          });
          result.addCheck('fix2', false, {
            severity: 'error',
            autoFix: async () => ({ fixed: true, description: 'Added semicolon', filesChanged: ['b.js'] }),
          });
        },
      });

      const summary = await runner.run(['fixable']);
      assert.strictEqual(summary.fixes.total, 2);
      assert.strictEqual(summary.fixes.details.length, 2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
