'use strict';

// =============================================================================
// Runner suppression + flywheel softening (WS2) — .gatetestignore excludes a
// finding from the gate (visible but silenced); a per-module penalty softens
// a confident error below the block threshold.
// =============================================================================

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TestResult, GateTestRunner } = require('../src/core/runner');
const { parse } = require('../src/core/ignore-file');
const { GateTestConfig } = require('../src/core/config');

function confidentError(name, file) {
  // Explicit confidence 0.95 so it would block absent suppression/softening.
  return [name, false, { severity: 'error', file, message: 'boom', confidence: 0.95 }];
}

describe('runner — .gatetestignore suppression', () => {
  it('a matched finding is suppressed: not blocking, not soft, not warning — but visible', () => {
    const matcher = parse('secrets:apiKey');
    const r = new TestResult('secrets', { blockThreshold: 0.7, ignoreMatcher: matcher });
    r.addCheck(...confidentError('secrets:apiKey', 'src/db.js'));
    assert.equal(r.blockingErrorChecks.length, 0, 'suppressed finding must not block');
    assert.equal(r.softErrorChecks.length, 0, 'suppressed finding is not a soft error either');
    assert.equal(r.suppressedChecks.length, 1, 'suppressed finding stays visible in the suppressed list');
    assert.equal(r.suppressedChecks[0].suppressReason, 'gatetestignore');
  });

  it('an unmatched finding still blocks', () => {
    const matcher = parse('secrets:otherRule');
    const r = new TestResult('secrets', { blockThreshold: 0.7, ignoreMatcher: matcher });
    r.addCheck(...confidentError('secrets:apiKey', 'src/db.js'));
    assert.equal(r.blockingErrorChecks.length, 1);
    assert.equal(r.suppressedChecks.length, 0);
  });

  it('no matcher → legacy behavior, finding blocks', () => {
    const r = new TestResult('secrets', { blockThreshold: 0.7 });
    r.addCheck(...confidentError('secrets:apiKey', 'src/db.js'));
    assert.equal(r.blockingErrorChecks.length, 1);
  });
});

describe('runner — flywheel confidence softening', () => {
  it('a per-module penalty drops a computed-confidence error below the block threshold', () => {
    // No explicit confidence → runner scores it (a plain src file scores ~1.0),
    // then the penalty multiplies it down under 0.7.
    const r = new TestResult('noisyMod', {
      blockThreshold: 0.7,
      confidencePenalties: { noisyMod: 0.5 },
    });
    r.addCheck('noisyMod:rule', false, { severity: 'error', file: 'src/app.js', message: 'x', line: 1 });
    assert.equal(r.blockingErrorChecks.length, 0, 'softened finding must not block');
    assert.equal(r.softErrorChecks.length, 1, 'softened finding is reported as a soft error');
    assert.ok(r.softErrorChecks[0].confidence < 0.7);
    assert.ok(r.softErrorChecks[0].confidenceSignals.includes('flywheel-softened'));
  });

  it('no penalty for a module not in the map', () => {
    const r = new TestResult('cleanMod', {
      blockThreshold: 0.7,
      confidencePenalties: { somethingElse: 0.5 },
    });
    r.addCheck('cleanMod:rule', false, { severity: 'error', file: 'src/app.js', message: 'x', line: 1 });
    assert.equal(r.blockingErrorChecks.length, 1);
  });
});

// KI #112 G4 (issue #633): `.gatetest.json`'s `ignore` array reaches the SAME
// suppressor the runner already wires up from `.gatetestignore` — no second
// matcher. Control pair: with the key, the finding is suppressed; the same
// finding, same repo, without the key, still blocks.
describe('GateTestRunner — `.gatetest.json`\'s `ignore` array feeds the suppression matcher', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-runner-ignore-cfg-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  function probe(matcher) {
    return {
      suppressed: matcher.matches({ module: 'secrets', ruleKey: 'secrets:apiKey', file: 'src/db.js' }),
      untouched: matcher.matches({ module: 'secrets', ruleKey: 'secrets:otherRule', file: 'src/db.js' }),
    };
  }

  it('WITH `ignore` in .gatetest.json: the named finding is suppressed', () => {
    fs.writeFileSync(path.join(tmp, '.gatetest.json'), JSON.stringify({ ignore: ['secrets:apiKey'] }));
    const config = new GateTestConfig(tmp);
    const runner = new GateTestRunner(config, {});
    const { suppressed, untouched } = probe(runner._ignoreMatcher);
    assert.equal(suppressed, true, 'the JSON-configured line must suppress the matching finding');
    assert.equal(untouched, false, 'a different rule in the same module is not touched');
  });

  it('WITHOUT `ignore` in .gatetest.json: the same finding is not suppressed', () => {
    fs.writeFileSync(path.join(tmp, '.gatetest.json'), JSON.stringify({}));
    const config = new GateTestConfig(tmp);
    const runner = new GateTestRunner(config, {});
    const { suppressed } = probe(runner._ignoreMatcher);
    assert.equal(suppressed, false);
  });

  it('a plain options object (no GateTestConfig instance, e.g. direct-repair.js callers) does not throw', () => {
    const runner = new GateTestRunner({ projectRoot: tmp });
    assert.equal(runner._ignoreMatcher.isEmpty, true);
  });
});

// Issue #657: a real customer config used the NESTED `ignore: { paths: [...] }`
// shape — `.gatetest.json`'s `ignore` key was already read into the merged
// config by config.js (so it stopped tripping config:unknown-keys), but
// `_configIgnoreLines` only ever recognised a top-level array, so the
// customer's two patterns (`scripts/**`, `packages/db/migrations/**`) fed
// zero extra lines into the suppressor and 754 findings kept firing with no
// error anywhere. Exactly their two patterns, one finding under each,
// end-to-end through a real GateTestRunner + fake module — and the finding
// is reported with an ABSOLUTE path, so this also proves the repo-relative
// normalisation fix (a hand-written glob is anchored against the
// repo-relative form; a module reporting an absolute path used to never
// match even with the shape fixed).
describe('GateTestRunner — `.gatetest.json`\'s nested `ignore: { paths: [...] }` shape (issue #657)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-runner-ignore-paths-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('suppresses a finding under each of the customer\'s two patterns; an unrelated file still blocks', async () => {
    fs.writeFileSync(path.join(tmp, '.gatetest.json'), JSON.stringify({
      ignore: { paths: ['scripts/**', 'packages/db/migrations/**'] },
    }));
    const config = new GateTestConfig(tmp);
    const runner = new GateTestRunner(config);

    const scriptsFile = path.join(tmp, 'scripts', 'build.js');
    const migrationFile = path.join(tmp, 'packages', 'db', 'migrations', '0001_init.sql');
    const unrelatedFile = path.join(tmp, 'src', 'app.js');

    runner.register('fakeMod', {
      async run(result) {
        result.addCheck('fakeMod:scripts', false, {
          severity: 'error', file: scriptsFile, message: 'boom', confidence: 0.95,
        });
        result.addCheck('fakeMod:migration', false, {
          severity: 'error', file: migrationFile, message: 'boom', confidence: 0.95,
        });
        result.addCheck('fakeMod:unrelated', false, {
          severity: 'error', file: unrelatedFile, message: 'boom', confidence: 0.95,
        });
      },
    });

    const summary = await runner.run(['fakeMod']);
    assert.strictEqual(summary.checks.ignoreSuppressed, 2, 'both patterned findings are suppressed');
    assert.strictEqual(summary.checks.blockingErrors, 1, 'the unrelated finding still blocks');
    assert.strictEqual(summary.gateStatus, 'BLOCKED');

    const fakeResult = summary.results.find((r) => r.module === 'fakeMod');
    const scriptsCheck = fakeResult.checks.find((c) => c.name === 'fakeMod:scripts');
    const migrationCheck = fakeResult.checks.find((c) => c.name === 'fakeMod:migration');
    const unrelatedCheck = fakeResult.checks.find((c) => c.name === 'fakeMod:unrelated');
    assert.strictEqual(scriptsCheck.suppressed, true);
    assert.strictEqual(scriptsCheck.suppressReason, 'gatetestignore');
    assert.strictEqual(migrationCheck.suppressed, true);
    assert.strictEqual(migrationCheck.suppressReason, 'gatetestignore');
    assert.strictEqual(unrelatedCheck.suppressed, undefined);
  });

  it('the top-level array shape still suppresses a path glob (no regression)', async () => {
    fs.writeFileSync(path.join(tmp, '.gatetest.json'), JSON.stringify({
      ignore: ['scripts/**'],
    }));
    const config = new GateTestConfig(tmp);
    const runner = new GateTestRunner(config);
    const scriptsFile = path.join(tmp, 'scripts', 'build.js');

    runner.register('fakeMod', {
      async run(result) {
        result.addCheck('fakeMod:scripts', false, {
          severity: 'error', file: scriptsFile, message: 'boom', confidence: 0.95,
        });
      },
    });

    const summary = await runner.run(['fakeMod']);
    assert.strictEqual(summary.checks.ignoreSuppressed, 1);
    assert.strictEqual(summary.checks.blockingErrors, 0);
    assert.strictEqual(summary.gateStatus, 'PASSED');
  });

  it('without the ignore key, the same two files block (control)', async () => {
    fs.writeFileSync(path.join(tmp, '.gatetest.json'), JSON.stringify({}));
    const config = new GateTestConfig(tmp);
    const runner = new GateTestRunner(config);
    const scriptsFile = path.join(tmp, 'scripts', 'build.js');
    const migrationFile = path.join(tmp, 'packages', 'db', 'migrations', '0001_init.sql');

    runner.register('fakeMod', {
      async run(result) {
        result.addCheck('fakeMod:scripts', false, {
          severity: 'error', file: scriptsFile, message: 'boom', confidence: 0.95,
        });
        result.addCheck('fakeMod:migration', false, {
          severity: 'error', file: migrationFile, message: 'boom', confidence: 0.95,
        });
      },
    });

    const summary = await runner.run(['fakeMod']);
    assert.strictEqual(summary.checks.ignoreSuppressed, 0);
    assert.strictEqual(summary.checks.blockingErrors, 2);
    assert.strictEqual(summary.gateStatus, 'BLOCKED');
  });
});

// KI #112: `config:unknown-keys` reaches the summary (and from there,
// json-output.js and the console reporter) as a three-state, never-blocking
// finding — present only when there is something to say.
describe('GateTestRunner — summary carries `config:unknown-keys` (KI #112)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-runner-cfgcheck-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  function buildSummary(configJson) {
    fs.writeFileSync(path.join(tmp, '.gatetest.json'), JSON.stringify(configJson));
    const original = console.error;
    console.error = () => {};
    try {
      const config = new GateTestConfig(tmp);
      const runner = new GateTestRunner(config, {});
      runner.results = [];
      return runner._buildSummary(Date.now(), Date.now());
    } finally {
      console.error = original;
    }
  }

  it('a config with only known keys → summary.configCheck is null (no check emitted)', () => {
    const summary = buildSummary({ thresholds: { maxFileLength: 800 } });
    assert.strictEqual(summary.configCheck, null);
  });

  it('a config with unknown keys → summary.configCheck names them, info severity, never blocking', () => {
    const summary = buildSummary({ severity: 'error', gating: true });
    assert.ok(summary.configCheck);
    assert.strictEqual(summary.configCheck.name, 'config:unknown-keys');
    assert.strictEqual(summary.configCheck.severity, 'info');
    assert.strictEqual(summary.configCheck.passed, false);
    assert.deepStrictEqual(summary.configCheck.keys.sort(), ['gating', 'severity']);
  });
});
