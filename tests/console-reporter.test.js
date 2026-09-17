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

// Move 25 (2026-09-05): beside every finding in "What's blocking you", the
// exact .gatetestignore line that silences it — verified against the matcher.
describe('ConsoleReporter — offers the exact .gatetestignore line', () => {
  it('prints module:rule@file for a blocking finding', () => {
    const runner = new EventEmitter();
    new ConsoleReporter(runner);
    const output = captureLog(() => {
      runner.emit('suite:end', {
        gateStatus: 'BLOCKED',
        modules: { passed: 0, total: 1 },
        checks: { total: 1, passed: 0, failed: 1, errors: 1, blockingErrors: 1, softErrors: 0, warnings: 0, infoFindings: 0 },
        fixes: { total: 0 },
        duration: 10,
        failedModules: ['hardcodedUrl'],
        confidenceThreshold: 0.7,
        results: [{
          module: 'hardcodedUrl',
          checks: [{
            name: 'hardcoded-url:localhost:src/x.ts:12', passed: false, severity: 'error', confidence: 1,
            file: 'src/x.ts', line: 12, message: 'hardcoded http://localhost:3000',
          }],
        }],
      });
    });
    assert.match(output, /wrong\? add to \.gatetestignore: hardcodedUrl:localhost@src\/x\.ts/);
  });
});

// Move 28: in CI, a blocked gate leads with the command that reproduces it.
describe('ConsoleReporter — a blocked gate leads with `gatetest replay` in CI', () => {
  const GHA = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '42', GITHUB_SERVER_URL: 'https://github.com' };
  function withEnv(vars, fn) {
    const saved = {};
    for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
    try { return fn(); } finally {
      for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  }
  const blocked = {
    gateStatus: 'BLOCKED', modules: { passed: 0, total: 1 },
    checks: { total: 1, passed: 0, failed: 1, errors: 1, blockingErrors: 1, softErrors: 0, warnings: 0, infoFindings: 0 },
    fixes: { total: 0 }, duration: 1, failedModules: ['x'], results: [],
  };
  it('prints the replay command right under GATE: BLOCKED', () => {
    const output = withEnv(GHA, () => captureLog(() => {
      const runner = new EventEmitter();
      new ConsoleReporter(runner);
      runner.emit('suite:end', blocked);
    }));
    const lines = output.split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    const i = lines.findIndex((l) => /GATE: BLOCKED/.test(l));
    assert.ok(i >= 0);
    assert.match(lines[i + 1], /Reproduce locally: npx gatetest replay https:\/\/github\.com\/o\/r\/actions\/runs\/42/);
  });
  it('says nothing about replay outside CI or when the gate passed', () => {
    const local = withEnv({ GITHUB_ACTIONS: '' }, () => captureLog(() => {
      const runner = new EventEmitter();
      new ConsoleReporter(runner);
      runner.emit('suite:end', blocked);
    }));
    assert.doesNotMatch(local, /Reproduce locally/);
    const passed = withEnv(GHA, () => captureLog(() => {
      const runner = new EventEmitter();
      new ConsoleReporter(runner);
      runner.emit('suite:end', { ...blocked, gateStatus: 'PASSED', checks: { ...blocked.checks, errors: 0, blockingErrors: 0 } });
    }));
    assert.doesNotMatch(passed, /Reproduce locally/);
  });
});

describe('ConsoleReporter — field-silence demotion line (the Fifty, move 08)', () => {
  const passedSummary = {
    gateStatus: 'PASSED', modules: { passed: 1, total: 1 },
    checks: { total: 1, passed: 1, failed: 0, errors: 0, blockingErrors: 0, softErrors: 0, warnings: 0, infoFindings: 0 },
    fixes: { total: 0 }, duration: 1, failedModules: [],
  };
  it('prints one line naming the count and pointing at /noise when the active list is non-empty', () => {
    const output = captureLog(() => {
      const runner = new EventEmitter();
      new ConsoleReporter(runner);
      runner.emit('suite:end', { ...passedSummary, demotedRuleCount: 3 });
    });
    assert.match(output, /3 rule\(s\) demoted by field silence data \(see \/noise\)/);
  });
  it('says nothing when no demotion is active — not even an empty line', () => {
    const output = captureLog(() => {
      const runner = new EventEmitter();
      new ConsoleReporter(runner);
      runner.emit('suite:end', { ...passedSummary, demotedRuleCount: 0 });
    });
    assert.doesNotMatch(output, /demoted by field silence data/);
  });
  it('says nothing when the field is absent entirely (older summary shape)', () => {
    const output = captureLog(() => {
      const runner = new EventEmitter();
      new ConsoleReporter(runner);
      runner.emit('suite:end', passedSummary);
    });
    assert.doesNotMatch(output, /demoted by field silence data/);
  });
});
