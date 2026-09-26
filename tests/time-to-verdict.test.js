'use strict';

/**
 * Move 4 — the time-to-verdict contract (docs/LAUNCH_BOARD.md).
 *
 * Complaint C2: a gate whose duration cannot be predicted gets abandoned
 * (CodeQL 3-10 min/100K LOC, 45-min PR scans; GateTest's own #630 quick
 * suite ran >10 min on a 76-package monorepo with no warning). This is the
 * control pair for the three pieces that fix it:
 *
 *   1. An ETA line, printed before any module runs, from a real file count
 *      and a per-module cost model (src/core/scan-eta.js + scan-history.js)
 *   2. `--budget <seconds>` / `GATETEST_BUDGET_S` — a whole-run wall-clock
 *      budget. Modules not yet started are DEFERRED, reported the same way
 *      SUITE_DEFERRALS already is (console, JSON `summary.deferred`, the PR
 *      comment). Never a fake pass; `--strict` makes an exceeded budget a
 *      usage failure (exit 2).
 *   3. A top-5-slowest-modules line in the summary footer.
 *
 * Timings are mocked (in-process runner + hand-built summaries) wherever
 * possible so this file runs in seconds. `--budget 0` is the deterministic
 * control: `_budgetExhausted()` reads `(Date.now() - start) >= 0`, which is
 * true from the very first check, so every module is reliably deferred
 * with no dependency on real wall-clock timing at all.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { GateTestRunner } = require('../src/core/runner');
const { ConsoleReporter } = require('../src/reporters/console-reporter');
const scanEta = require('../src/core/scan-eta');
const scanHistory = require('../src/core/scan-history');
const { USAGE_EXIT_CODE } = require('../src/core/cli-args');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'gatetest.js');

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function makeRunner(options = {}) {
  return new GateTestRunner({ projectRoot: process.cwd() }, options);
}

/** A module that passes with no findings, optionally after a short real delay. */
function okModule(delayMs = 0) {
  return {
    async run(result) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      result.addCheck('ok', true);
    },
  };
}

/** A module that reports one confident, blocking error. */
function blockingModule() {
  return {
    async run(result) {
      result.addCheck('blocking-finding', false, {
        severity: 'error',
        confidence: 1.0,
        message: 'a real, blocking finding',
        file: 'src/lib/foo.js',
      });
    },
  };
}

function withCapturedConsole(fn) {
  const outLines = [];
  const errLines = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => outLines.push(a.join(' '));
  console.error = (...a) => errLines.push(a.join(' '));
  try {
    fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { out: outLines.join('\n').replace(ANSI_RE, ''), err: errLines.join('\n').replace(ANSI_RE, '') };
}

function runCli(args, extraEnv = {}) {
  const env = { ...process.env, GATETEST_NO_TELEMETRY: '1', NO_COLOR: '1' };
  delete env.GATETEST_BUDGET_S;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 55000, env });
}

/** A minimal scannable fixture — just enough for scan-scope to find files. */
function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ttv-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fx', version: '1.0.0', private: true }));
  fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = 1;\n');
  return dir;
}

// ─── scan-eta.js — the cost model ──────────────────────────────────────────

describe('scan-eta — range vs point estimate by history size', () => {
  test('thin history (no samples) yields a RANGE, never a bare point value', () => {
    const estimate = scanEta.estimateScanMs({
      fileCount: 500,
      modules: ['memory', 'syntax', 'lint'],
      history: { totalRuns: 0, modules: {} },
    });
    assert.equal(estimate.thin, true);
    const rendered = scanEta.formatEta(estimate);
    assert.match(rendered, /^~[\d.]+-[\d.]+ s$/, `expected a range like "~40-90 s", got "${rendered}"`);
  });

  test('rich history (every module sampled 3+ times) yields a POINT estimate', () => {
    const modules = ['memory', 'syntax', 'lint'];
    const history = { totalRuns: 5, modules: {} };
    for (const m of modules) history.modules[m] = { count: 5, totalMs: 5000, totalFiles: 500 };
    const estimate = scanEta.estimateScanMs({ fileCount: 500, modules, history });
    assert.equal(estimate.thin, false);
    const rendered = scanEta.formatEta(estimate);
    assert.match(rendered, /^~[\d.]+ s$/, `expected a point value like "~62 s", got "${rendered}"`);
  });

  test('a module with real history overrides the static default coefficient', () => {
    const history = { totalRuns: 1, modules: { lint: { count: 1, totalMs: 100, totalFiles: 100 } } };
    const c = scanEta.coefficientFor('lint', history);
    assert.equal(c.fromHistory, true);
    assert.equal(c.msPerFile, 1); // 100ms / 100 files
  });

  test('an unknown module falls back to the static default, not zero', () => {
    const c = scanEta.coefficientFor('totallyMadeUpModuleName', { totalRuns: 0, modules: {} });
    assert.equal(c.fromHistory, false);
    assert.equal(c.msPerFile, scanEta.DEFAULT_MS_PER_FILE);
  });
});

// ─── scan-history.js — the memory the ETA line reads ───────────────────────

describe('scan-history — round trip', () => {
  test('a fresh project has empty history, never throws', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-hist-'));
    const h = scanHistory.loadHistory(dir);
    assert.equal(h.totalRuns, 0);
    assert.deepEqual(h.modules, {});
  });

  test('recordRun persists per-module count/totalMs/totalFiles, loadHistory reads it back', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-hist-'));
    scanHistory.recordRun(dir, {
      fileCount: 200,
      results: [{ module: 'lint', duration: 400 }, { module: 'syntax', duration: 100 }],
    });
    scanHistory.recordRun(dir, {
      fileCount: 200,
      results: [{ module: 'lint', duration: 600 }, { module: 'syntax', duration: 300 }],
    });
    const h = scanHistory.loadHistory(dir);
    assert.equal(h.totalRuns, 2);
    assert.equal(h.modules.lint.count, 2);
    assert.equal(h.modules.lint.totalMs, 1000);
    assert.equal(h.modules.lint.totalFiles, 400);
    assert.ok(fs.existsSync(path.join(dir, scanHistory.HISTORY_REL_PATH)));
  });

  test('a corrupt history file falls back to empty rather than throwing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-hist-'));
    fs.mkdirSync(path.join(dir, '.gatetest', 'reports'), { recursive: true });
    fs.writeFileSync(path.join(dir, scanHistory.HISTORY_REL_PATH), '{ not valid json');
    const h = scanHistory.loadHistory(dir);
    assert.equal(h.totalRuns, 0);
  });
});

// ─── runner.js — whole-run --budget ────────────────────────────────────────

describe('runner --budget — deferral', () => {
  test('budget 0 defers every module (sequential): none run, all reported deferred', async () => {
    const runner = makeRunner({ parallel: false, budgetMs: 0 });
    runner.register('a', okModule());
    runner.register('b', okModule());
    runner.register('c', okModule());
    const summary = await runner.run(['a', 'b', 'c']);

    assert.equal(summary.modules.total, 0, 'no module actually ran');
    assert.equal(summary.budgetLimited, true);
    assert.equal(summary.budgetDeferredCount, 3);
    assert.equal(summary.deferred.length, 3);
    assert.deepEqual(summary.deferred.map((d) => d.module).sort(), ['a', 'b', 'c']);
    for (const d of summary.deferred) {
      assert.match(d.reason, /budget 0s exhausted after 0 of 3 modules/);
      assert.ok(d.runsIn && d.runsIn.length > 0);
    }
    // Nothing ran and nothing blocked, so the gate never fakes a failure —
    // but it also never silently claims a full pass without the flag.
    assert.equal(summary.gateStatus, 'PASSED');
  });

  test('budget 0 defers every module (parallel) — same reporting shape as sequential', async () => {
    const runner = makeRunner({ parallel: true, budgetMs: 0 });
    runner.register('a', okModule());
    runner.register('b', okModule());
    const summary = await runner.run(['a', 'b']);

    assert.equal(summary.modules.total, 0);
    assert.equal(summary.budgetLimited, true);
    assert.equal(summary.budgetDeferredCount, 2);
  });

  test('exit-code-deciding verdict reflects only the modules that ran, never the deferred ones', async () => {
    // Control: the SAME blocking module, with and without a budget.
    const noBudget = makeRunner({ parallel: false });
    noBudget.register('bad', blockingModule());
    const blockedSummary = await noBudget.run(['bad']);
    assert.equal(blockedSummary.gateStatus, 'BLOCKED');

    const zeroBudget = makeRunner({ parallel: false, budgetMs: 0 });
    zeroBudget.register('bad', blockingModule());
    const deferredSummary = await zeroBudget.run(['bad']);
    // The module that would have blocked never ran — the gate does not
    // invent a verdict for work it skipped.
    assert.equal(deferredSummary.gateStatus, 'PASSED');
    assert.equal(deferredSummary.budgetLimited, true);
    assert.equal(deferredSummary.budgetDeferredCount, 1);
  });

  test('--strict + budget exceeded is flagged on the summary for the caller to turn into a usage failure', async () => {
    const runner = makeRunner({ parallel: false, budgetMs: 0, strict: true });
    runner.register('a', okModule());
    const summary = await runner.run(['a']);
    // runner.js deliberately leaves gateStatus alone (PASSED — nothing
    // blocked) and only sets the flag; bin/gatetest.js is what turns
    // `strict && budgetLimited` into exit 2 (USAGE_EXIT_CODE), proven by
    // the CLI-level test below.
    assert.equal(summary.budgetLimited, true);
    assert.equal(summary.gateStatus, 'PASSED');
  });

  test('a real (non-zero) budget lets early modules run and defers only the rest', async () => {
    // Loose, load-tolerant assertions: exact counts depend on real
    // wall-clock timing, but the invariants must always hold.
    const runner = makeRunner({ parallel: false, budgetMs: 30 });
    const names = ['a', 'b', 'c', 'd', 'e', 'f'];
    for (const n of names) runner.register(n, okModule(25));
    const summary = await runner.run(names);

    assert.equal(summary.modules.total + summary.budgetDeferredCount, 6);
    assert.ok(summary.modules.total >= 1, 'the first module always starts (budget check happens before dispatch)');
  });
});

describe('runner — top-5 slowest modules', () => {
  test('slowestModules is sorted descending and capped at 5', async () => {
    const runner = makeRunner({ parallel: false });
    // Widely-spaced real delays (ms) so scheduler jitter cannot reorder them.
    const spec = [['a', 10], ['b', 200], ['c', 40], ['d', 160], ['e', 100], ['f', 70]];
    for (const [name, ms] of spec) runner.register(name, okModule(ms));
    const summary = await runner.run(spec.map(([name]) => name));

    assert.equal(summary.slowestModules.length, 5);
    const order = summary.slowestModules.map((m) => m.module);
    assert.deepEqual(order, ['b', 'd', 'e', 'f', 'c']); // 'a' (5ms) is the one excluded
    for (let i = 1; i < summary.slowestModules.length; i++) {
      assert.ok(summary.slowestModules[i - 1].durationMs >= summary.slowestModules[i].durationMs);
    }
  });
});

// ─── console-reporter.js — what the human sees ─────────────────────────────

describe('ConsoleReporter — budget-limited verdict and slowest-modules line', () => {
  function fakeRunner() {
    const runner = new EventEmitter();
    runner.options = { parallel: false };
    return runner;
  }

  test('a budget-limited PASS says so on the GATE line, never reads as a full pass', () => {
    const runner = fakeRunner();
    new ConsoleReporter(runner);
    const summary = {
      gateStatus: 'PASSED',
      budgetLimited: true,
      budgetDeferredCount: 3,
      deferred: [{ module: 'x', reason: 'budget 60s exhausted after 14 of 46 modules', runsIn: 'a run without --budget' }],
      modules: { total: 14, passed: 14, failed: 0, skipped: 0 },
      checks: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
      fixes: { total: 0 },
      failedModules: [],
      duration: 1234,
      timestamp: new Date().toISOString(),
    };
    const { out } = withCapturedConsole(() => runner.emit('suite:end', summary));
    assert.match(out, /GATE: PASSED \(budget-limited: 3 modules deferred\)/);
    assert.match(out, /Deferred: x — budget 60s exhausted after 14 of 46 modules\. Runs in: a run without --budget/);
  });

  test('the summary footer prints the top-5 slowest modules on one line', () => {
    const runner = fakeRunner();
    new ConsoleReporter(runner);
    const summary = {
      gateStatus: 'PASSED',
      modules: { total: 2, passed: 2, failed: 0, skipped: 0 },
      checks: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
      fixes: { total: 0 },
      failedModules: [],
      duration: 1234,
      timestamp: new Date().toISOString(),
      slowestModules: [{ module: 'unitTests', durationMs: 5200 }, { module: 'lint', durationMs: 800 }],
    };
    const { out } = withCapturedConsole(() => runner.emit('suite:end', summary));
    assert.match(out, /Slowest:\s+unitTests \(5\.2s\), lint \(0\.8s\)/);
  });
});

// ─── bin/gatetest.js — CLI wiring: ETA line, --budget, env precedence, --strict ─

describe('CLI — ETA line, --budget, env precedence, --strict usage failure', () => {
  test('prints the ETA line, before any module output, on stderr', () => {
    const dir = makeFixture();
    const res = runCli(['--suite', 'quick', '--project', dir, '--budget', '0']);
    assert.match(
      res.stderr,
      /\[GateTest] Scanning \d+ files in \d+ packages across \d+ modules \(\d+ in scope\) · suite quick · estimated .+/,
    );
  });

  test('--budget 0 defers the whole suite and still exits 0 (nothing blocked)', () => {
    const dir = makeFixture();
    const res = runCli(['--suite', 'quick', '--project', dir, '--budget', '0', '--format', 'json']);
    const doc = JSON.parse(res.stdout);
    assert.equal(doc.budgetLimited, true);
    assert.ok(doc.deferred.length > 0);
    assert.equal(res.status, 0);
  });

  test('--strict with an exhausted budget is a usage failure (exit 2), not a gate result', () => {
    const dir = makeFixture();
    const res = runCli(['--suite', 'quick', '--project', dir, '--budget', '0', '--strict']);
    assert.equal(res.status, USAGE_EXIT_CODE);
    assert.match(res.stderr, /usage failure/i);
  });

  test('GATETEST_BUDGET_S is honoured when --budget is absent', () => {
    const dir = makeFixture();
    const res = runCli(['--suite', 'quick', '--project', dir, '--format', 'json'], { GATETEST_BUDGET_S: '0' });
    const doc = JSON.parse(res.stdout);
    assert.equal(doc.budgetLimited, true);
  });

  test('an explicit --budget wins over a more generous GATETEST_BUDGET_S', () => {
    const dir = makeFixture();
    const res = runCli(
      ['--suite', 'quick', '--project', dir, '--budget', '0', '--format', 'json'],
      { GATETEST_BUDGET_S: '9999' },
    );
    const doc = JSON.parse(res.stdout);
    assert.equal(doc.budgetLimited, true, 'the explicit 0-second flag must win, not the generous env value');
  });
});
