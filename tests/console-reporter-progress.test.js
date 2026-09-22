const { describe, it } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const { ConsoleReporter } = require('../src/reporters/console-reporter');

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function makeModuleResult(name, duration) {
  return {
    module: name,
    status: 'passed',
    duration,
    checks: [],
    errorChecks: [],
    warningChecks: [],
    fixes: [],
  };
}

function captureStderr(fn) {
  const chunks = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  const originalLog = console.log;
  console.log = () => {}; // silence the normal PASS/FAIL stdout line for this test
  try { fn(); } finally { process.stderr.write = original; console.log = originalLog; }
  return chunks.join('').replace(ANSI_RE, '');
}

// Issue #630 — a --parallel run on a large monorepo produced zero visible
// signal for minutes. `_onModuleEnd` now prints an elapsed-since-suite-start
// line to stderr, once the run has been going long enough (>30s) that
// silence would read as a hang, and ONLY in --parallel mode (sequential
// mode already streams a completion line for every module in real time).
describe('ConsoleReporter — parallel-mode progress line (issue #630)', () => {
  it('prints an elapsed-time line once a parallel run passes 30s, to stderr', () => {
    const runner = new EventEmitter();
    runner.options = { parallel: true };
    const reporter = new ConsoleReporter(runner);

    const output = captureStderr(() => {
      runner.emit('suite:start', { modules: ['syntax', 'lint'], diffOnly: false });
      // Backdate the recorded start so this module:end reads as 31s in.
      reporter._suiteStartedAt -= 31_000;
      runner.emit('module:end', makeModuleResult('syntax', 500));
    });

    assert.match(output, /elapsed/i);
    assert.match(output, /syntax/);
  });

  it('stays silent before the 30s mark', () => {
    const runner = new EventEmitter();
    runner.options = { parallel: true };
    const reporter = new ConsoleReporter(runner);

    const output = captureStderr(() => {
      runner.emit('suite:start', { modules: ['syntax'], diffOnly: false });
      // No backdating — this reads as effectively 0s elapsed.
      runner.emit('module:end', makeModuleResult('syntax', 500));
    });

    assert.strictEqual(output, '');
  });

  it('never prints the elapsed line in sequential mode, even past 30s', () => {
    const runner = new EventEmitter();
    runner.options = { parallel: false };
    const reporter = new ConsoleReporter(runner);

    const output = captureStderr(() => {
      runner.emit('suite:start', { modules: ['syntax'], diffOnly: false });
      reporter._suiteStartedAt -= 31_000;
      runner.emit('module:end', makeModuleResult('syntax', 500));
    });

    assert.strictEqual(output, '', 'sequential mode already streams a completion line per module in real time');
  });

  // Issue #649 (D1) — a real 75-package monorepo run had every one of the
  // 42 per-module lines print the SAME near-suite-total number: the
  // reporter was printing time-since-suite-start (which converges for every
  // module finishing near the end of a long run), not the module's own
  // duration. Control pair: two modules with very different durations must
  // print two different elapsed values, each equal to ITS OWN duration —
  // and the suite total is never repeated per-module, only once, on the
  // summary line.
  it('control pair: two modules with different durations print different elapsed values, each their own', () => {
    const runner = new EventEmitter();
    runner.options = { parallel: true };
    const reporter = new ConsoleReporter(runner);

    const output = captureStderr(() => {
      runner.emit('suite:start', { modules: ['fakeFixDetector', 'memory'], diffOnly: false });
      // Both modules "finish" near the end of a long suite run — this is
      // exactly the condition that made the old code print the same
      // suite-elapsed number for both.
      reporter._suiteStartedAt -= 569_800;
      runner.emit('module:end', makeModuleResult('fakeFixDetector', 1_200));
      runner.emit('module:end', makeModuleResult('memory', 30_000));
    });

    const lines = output.split('\n').filter(Boolean);
    const fastLine = lines.find((l) => l.includes('fakeFixDetector'));
    const slowLine = lines.find((l) => l.includes('memory'));

    assert.ok(fastLine, 'expected a line for the fast module');
    assert.ok(slowLine, 'expected a line for the slow module');
    assert.notStrictEqual(fastLine, slowLine, 'the two modules must not print an identical line');

    // Each line carries ITS OWN module duration in seconds, not the
    // ~569.8s suite clock both would have shared under the old bug.
    assert.match(fastLine, /\[1\.2s elapsed\]/);
    assert.match(slowLine, /\[30\.0s elapsed\]/);

    // The suite total (569.8s-ish) must not appear on either per-module
    // line — it belongs on the summary line alone.
    assert.doesNotMatch(fastLine, /569\.\ds/);
    assert.doesNotMatch(slowLine, /569\.\ds/);
  });

  // The suite clock still has exactly one home: the summary line printed by
  // `_onSuiteEnd` ("Time: <ms>ms"), never repeated per module.
  it('the suite total appears exactly once, on the summary line', () => {
    const runner = new EventEmitter();
    runner.options = { parallel: true };
    const reporter = new ConsoleReporter(runner);

    const stdoutChunks = [];
    const originalStdoutWrite = process.stdout.write;
    const originalLog = console.log;
    process.stdout.write = (chunk) => { stdoutChunks.push(String(chunk)); return true; };
    console.log = (...args) => { stdoutChunks.push(`${args.join(' ')}\n`); };

    const stderrOutput = captureStderr(() => {
      runner.emit('suite:start', { modules: ['fakeFixDetector', 'memory'], diffOnly: false });
      reporter._suiteStartedAt -= 569_800;
      runner.emit('module:end', makeModuleResult('fakeFixDetector', 1_200));
      runner.emit('module:end', makeModuleResult('memory', 30_000));
    });

    try {
      runner.emit('suite:end', {
        gateStatus: 'PASSED',
        modules: { passed: 2, total: 2 },
        checks: { passed: 0, total: 0, errors: 0, warnings: 0 },
        fixes: { total: 0 },
        duration: 569_900,
        failedModules: [],
        timestamp: new Date().toISOString(),
      });
    } finally {
      process.stdout.write = originalStdoutWrite;
      console.log = originalLog;
    }

    const stdout = stdoutChunks.join('').replace(ANSI_RE, '');
    const summaryTimeLines = stdout.split('\n').filter((l) => /Time:\s+569900ms/.test(l));
    assert.strictEqual(summaryTimeLines.length, 1, 'the suite total must appear exactly once, on the summary line');

    // And it must not have leaked onto either per-module stderr line.
    assert.doesNotMatch(stderrOutput, /569900ms/);
    assert.doesNotMatch(stderrOutput, /569\.9s/);
  });
});
