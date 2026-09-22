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
