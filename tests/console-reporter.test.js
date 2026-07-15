const { describe, it } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const { ConsoleReporter } = require('../src/reporters/console-reporter');

// The reporter writes straight to console.log — capture it instead of
// letting it hit stdout.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { fn(); } finally { console.log = original; }
  return lines.join('\n').replace(ANSI_RE, '');
}

describe('ConsoleReporter — info-findings summary (self-scan 2026-07-15 fix)', () => {
  it('excludes info-only findings from the headline Checks ratio and shows an Info line', () => {
    const runner = new EventEmitter();
    new ConsoleReporter(runner);

    const output = captureLog(() => {
      runner.emit('suite:end', {
        gateStatus: 'PASSED',
        modules: { passed: 5, total: 5 },
        checks: {
          total: 100, passed: 60, failed: 40,
          errors: 0, blockingErrors: 0, softErrors: 0,
          warnings: 5, infoFindings: 35,
        },
        fixes: { total: 0 },
        duration: 1000,
        failedModules: [],
      });
    });

    // 35 of the 40 "failed" checks are info-only nits — the headline
    // denominator must exclude them (100 - 35 = 65), not read as 60/100.
    assert.match(output, /Checks:\s+60\/65 passed/);
    assert.match(output, /Info:\s+35/);
  });

  it('omits the Info line and the info-only note when there are no info findings', () => {
    const runner = new EventEmitter();
    new ConsoleReporter(runner);

    const output = captureLog(() => {
      runner.emit('suite:end', {
        gateStatus: 'PASSED',
        modules: { passed: 5, total: 5 },
        checks: {
          total: 50, passed: 50, failed: 0,
          errors: 0, blockingErrors: 0, softErrors: 0,
          warnings: 0, infoFindings: 0,
        },
        fixes: { total: 0 },
        duration: 500,
        failedModules: [],
      });
    });

    assert.match(output, /Checks:\s+50\/50 passed/);
    assert.doesNotMatch(output, /Info:/);
  });
});
