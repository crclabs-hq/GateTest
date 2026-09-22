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
});
