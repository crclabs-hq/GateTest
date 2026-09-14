'use strict';
/**
 * Repo-wide baseline mode (KI #66) — "only fail on NEW issues."
 * Covers fingerprint stability, capture/load round-trip, TestResult
 * suppression via the baseline matcher, gate-decision integration, and
 * the capture-sees-everything rule.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const baseline = require('../src/core/baseline');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gt-baseline-'));
}

describe('baseline — fingerprint', () => {
  it('is stable across line-number shifts in the check name', () => {
    const a = baseline.fingerprint('hardcodedUrl', 'hardcoded-url:localhost:src/x.ts:12', 'src/x.ts', '/repo');
    const b = baseline.fingerprint('hardcodedUrl', 'hardcoded-url:localhost:src/x.ts:97', 'src/x.ts', '/repo');
    assert.strictEqual(a, b);
  });

  it('distinguishes different modules, rules, and files', () => {
    const base = baseline.fingerprint('security', 'sec:rule-a', 'src/a.js', '/repo');
    assert.notStrictEqual(base, baseline.fingerprint('secrets', 'sec:rule-a', 'src/a.js', '/repo'));
    assert.notStrictEqual(base, baseline.fingerprint('security', 'sec:rule-b', 'src/a.js', '/repo'));
    assert.notStrictEqual(base, baseline.fingerprint('security', 'sec:rule-a', 'src/b.js', '/repo'));
  });

  it('normalizes path separators and repo-relativizes absolute paths', () => {
    const rel = baseline.fingerprint('m', 'rule', 'src/x.js', '/repo');
    const winAbs = baseline.fingerprint('m', 'rule', path.join('/repo', 'src', 'x.js'), '/repo');
    assert.strictEqual(rel, winAbs);
  });
});

describe('baseline — capture + load round-trip', () => {
  it('captures unsuppressed error/warning findings, skips passed/info/suppressed', () => {
    const root = tmpRoot();
    const results = [
      {
        module: 'security',
        checks: [
          { name: 'sec:hardcoded-key', passed: false, severity: 'error', file: 'src/a.js' },
          { name: 'sec:ok', passed: true, severity: 'error' },
          { name: 'sec:already-ignored', passed: false, severity: 'error', suppressed: true, file: 'src/b.js' },
          { name: 'sec:info-note', passed: false, severity: 'info', file: 'src/c.js' },
        ],
      },
      {
        module: 'lint',
        checks: [{ name: 'lint:no-console', passed: false, severity: 'warning', file: 'src/d.js' }],
      },
    ];
    const { count, path: outPath } = baseline.capture(results, root);
    assert.strictEqual(count, 2);
    assert.ok(fs.existsSync(outPath));

    const matcher = baseline.load(root);
    assert.strictEqual(matcher.isEmpty, false);
    assert.strictEqual(matcher.count, 2);
    assert.ok(matcher.has('security', 'sec:hardcoded-key', 'src/a.js'));
    assert.ok(matcher.has('lint', 'lint:no-console', 'src/d.js'));
    assert.ok(!matcher.has('security', 'sec:already-ignored', 'src/b.js'));
    assert.ok(!matcher.has('security', 'sec:BRAND-NEW-FINDING', 'src/a.js'));
  });

  it('load on a repo without a baseline returns an inert matcher', () => {
    const matcher = baseline.load(tmpRoot());
    assert.strictEqual(matcher.isEmpty, true);
    assert.strictEqual(matcher.has('m', 'r', 'f.js'), false);
  });

  it('load on a corrupt baseline file never throws', () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, '.gatetest'), { recursive: true });
    fs.writeFileSync(path.join(root, '.gatetest', 'baseline.json'), '{not json');
    const matcher = baseline.load(root);
    assert.strictEqual(matcher.isEmpty, true);
  });
});

describe('baseline — runner integration', () => {
  const { GateTestRunner } = require('../src/core/runner');

  function makeConfig(root) {
    return {
      projectRoot: root,
      config: {},
      get: () => undefined,
      getModuleConfig: () => ({}),
      getThreshold: () => undefined,
      getSuite: () => ['fake'],
    };
  }

  function fakeModule(emit) {
    return { name: 'fake', description: 'fake', run: async (result) => emit(result) };
  }

  // The summary's start/end stamps: fixed, because nothing asserted here
  // depends on the wall clock and a real reading is a flake in waiting.
  const T0 = 1_700_000_000_000;

  async function runOnce(root, opts, emit) {
    const runner = new GateTestRunner(makeConfig(root), { silent: true, ...opts });
    runner.register('fake', fakeModule(emit));
    await runner.run(['fake']);
    return runner;
  }

  it('baselined finding is suppressed with reason "baseline" and does not block', async () => {
    const root = tmpRoot();
    const emit = (result) => {
      result.addCheck('fake:old-bug', false, {
        severity: 'error', file: 'src/legacy.js', confidence: 1,
      });
    };

    // 1. Capture run — old baseline (none) irrelevant, snapshot written.
    const capRunner = await runOnce(root, { captureBaseline: true }, emit);
    const capSummary = capRunner._buildSummary(T0, T0 + 5);
    assert.strictEqual(capSummary.baseline.captured, 1);

    // 2. Normal run — same finding must now be suppressed and not block.
    const runner = await runOnce(root, {}, emit);
    const summary = runner._buildSummary(T0, T0 + 5);
    assert.strictEqual(summary.gateStatus, 'PASSED');
    assert.strictEqual(summary.checks.baselined, 1);
    assert.strictEqual(summary.baseline.active, true);
    const check = runner.results[0].checks.find((c) => c.name === 'fake:old-bug');
    assert.strictEqual(check.suppressed, true);
    assert.strictEqual(check.suppressReason, 'baseline');
  });

  it('a NEW finding still blocks while old ones stay baselined', async () => {
    const root = tmpRoot();
    const oldOnly = (result) => {
      result.addCheck('fake:old-bug', false, { severity: 'error', file: 'src/legacy.js', confidence: 1 });
    };
    const oldAndNew = (result) => {
      oldOnly(result);
      result.addCheck('fake:new-bug', false, { severity: 'error', file: 'src/new.js', confidence: 1 });
    };

    await runOnce(root, { captureBaseline: true }, oldOnly);
    const runner = await runOnce(root, {}, oldAndNew);
    const summary = runner._buildSummary(T0, T0 + 5);
    assert.strictEqual(summary.gateStatus, 'BLOCKED');
    assert.strictEqual(summary.checks.baselined, 1);
    const newCheck = runner.results[0].checks.find((c) => c.name === 'fake:new-bug');
    assert.ok(!newCheck.suppressed, 'a new finding must never be baselined away');
  });

  it('count escalation resurfaces an aggregated check — a NEW secret in an already-baselined file blocks', async () => {
    const root = tmpRoot();
    // The secrets-module shape: ONE check per file, instances in `details`.
    const oneSecret = (result) => {
      result.addCheck('secrets:src/creds.js', false, {
        severity: 'error', file: 'src/creds.js', confidence: 1,
        message: '1 potential secret(s) found',
        details: [{ line: 1, match: 'password' }],
      });
    };
    const twoSecrets = (result) => {
      result.addCheck('secrets:src/creds.js', false, {
        severity: 'error', file: 'src/creds.js', confidence: 1,
        message: '2 potential secret(s) found',
        details: [{ line: 1, match: 'password' }, { line: 3, match: 'apiKey' }],
      });
    };

    await runOnce(root, { captureBaseline: true }, oneSecret);

    // Same single secret → suppressed, gate green.
    const same = await runOnce(root, {}, oneSecret);
    assert.strictEqual(same._buildSummary(T0, T0 + 5).gateStatus, 'PASSED');

    // A SECOND secret in the same file → whole check resurfaces, gate blocks.
    const grown = await runOnce(root, {}, twoSecrets);
    const summary = grown._buildSummary(T0, T0 + 5);
    assert.strictEqual(summary.gateStatus, 'BLOCKED');
    const check = grown.results[0].checks.find((c) => c.name === 'secrets:src/creds.js');
    assert.ok(!check.suppressed, 'count escalation must resurface the aggregated check');
  });

  it('capture runs see the FULL surface — an existing baseline does not hide findings from a re-capture', async () => {
    const root = tmpRoot();
    const emit = (result) => {
      result.addCheck('fake:old-bug', false, { severity: 'error', file: 'src/legacy.js', confidence: 1 });
    };
    await runOnce(root, { captureBaseline: true }, emit);
    // Re-capture: if the old baseline suppressed the finding, count would be 0.
    const runner2 = await runOnce(root, { captureBaseline: true }, emit);
    const summary2 = runner2._buildSummary(T0, T0 + 5);
    assert.strictEqual(summary2.baseline.captured, 1);
  });
});

// ── The allowance must be spent ACROSS the run, not re-offered per check ──────
//
// A fingerprint is `module::rule::file` with numeric segments stripped, so every
// finding of one rule in one file shares it. Modules report in two shapes:
// aggregating ones (secrets) send ONE check carrying N instances; most
// (errorSwallow) send ONE CHECK PER FINDING with currentCount 1 each.
//
// The original matcher compared `currentCount <= allowed` per call, so the second
// shape slipped through entirely: two empty catches in a baselined file each asked
// `1 <= 1` and both were grandfathered. A baselined file became a permanent
// dumping ground for new findings of an already-baselined rule — in exactly the
// files most likely to be edited.
//
// Verified end-to-end before the fix on a scratch repo: adding a second empty
// catch to a baselined file left the gate GREEN and the run reported "7
// pre-existing finding(s) baselined" against a baseline recording 6.

describe('baseline — allowance is consumed across the run', () => {
  /** Write a baseline with one fingerprint at a chosen allowance. */
  function rootWithAllowance(count) {
    const root = tmpRoot();
    const dir = path.join(root, '.gatetest');
    fs.mkdirSync(dir, { recursive: true });
    const key = baseline.fingerprint('errorSwallow', 'error-swallow:empty-catch', 'src/legacy.js', root);
    fs.writeFileSync(path.join(dir, 'baseline.json'), JSON.stringify({
      version: 1, capturedAt: new Date(0).toISOString(), count,
      fingerprints: { [key]: { severity: 'error', count } },
    }));
    return root;
  }

  const ask = (m, root, n = 1) =>
    m.has('errorSwallow', 'error-swallow:empty-catch:12', path.join(root, 'src/legacy.js'), n);

  it('grandfathers the baselined finding but NOT a second one (the regression)', () => {
    const root = rootWithAllowance(1);
    const m = baseline.load(root);
    assert.strictEqual(ask(m, root), true, 'the one baselined finding stays grandfathered');
    assert.strictEqual(ask(m, root), false, 'a SECOND finding of the same rule in the same file is NEW');
  });

  it('honours an allowance above one, then blocks past it', () => {
    const root = rootWithAllowance(3);
    const m = baseline.load(root);
    assert.strictEqual(ask(m, root), true);
    assert.strictEqual(ask(m, root), true);
    assert.strictEqual(ask(m, root), true);
    assert.strictEqual(ask(m, root), false, 'the fourth exceeds the baselined three');
  });

  it('still handles the aggregating shape — one check carrying N instances', () => {
    const root = rootWithAllowance(1);
    const m = baseline.load(root);
    assert.strictEqual(ask(m, root, 2), false, '2 instances against an allowance of 1 is a regression');
  });

  it('a refused check does not consume the allowance', () => {
    // An oversized check must not eat the budget a legitimate one still needs.
    const root = rootWithAllowance(2);
    const m = baseline.load(root);
    assert.strictEqual(ask(m, root, 5), false, 'too big to fit');
    assert.strictEqual(ask(m, root, 2), true, 'the allowance was left intact for a check that fits');
  });

  it('a fresh load() starts a fresh tally', () => {
    const root = rootWithAllowance(1);
    const first = baseline.load(root);
    assert.strictEqual(ask(first, root), true);
    assert.strictEqual(ask(first, root), false);

    const second = baseline.load(root);
    assert.strictEqual(ask(second, root), true, 'state is per-matcher, not global — the next run starts clean');
  });

  it('an unbaselined fingerprint is never grandfathered, whatever the tally', () => {
    const root = rootWithAllowance(1);
    const m = baseline.load(root);
    assert.strictEqual(
      m.has('errorSwallow', 'error-swallow:empty-catch', path.join(root, 'src/other.js')),
      false,
      'a different file is a different fingerprint',
    );
  });
});
