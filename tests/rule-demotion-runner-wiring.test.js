'use strict';

// End-to-end control pairs for the Fifty, move 08: TestResult.addCheck (the
// one severity hook, src/core/runner.js) actually demotes a finding when
// the real data/rule-demotions.json — the file the shipped CLI reads —
// lists it, and leaves everything else exactly as before. This test swaps
// that real file's bytes for a fixture and restores them afterward.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { TestResult } = require('../src/core/runner');
const ruleDemotion = require('../src/core/rule-demotion');

const REAL_PATH = ruleDemotion.DEFAULT_PATH;
let originalBytes = null;
let originalExisted = false;

before(() => {
  originalExisted = fs.existsSync(REAL_PATH);
  if (originalExisted) originalBytes = fs.readFileSync(REAL_PATH);
});

after(() => {
  if (originalExisted) fs.writeFileSync(REAL_PATH, originalBytes);
  else if (fs.existsSync(REAL_PATH)) fs.unlinkSync(REAL_PATH);
  ruleDemotion._resetCache();
});

function withFixture(demotions, fn) {
  fs.mkdirSync(require('node:path').dirname(REAL_PATH), { recursive: true });
  fs.writeFileSync(REAL_PATH, JSON.stringify({
    generatedAt: '2026-09-17T00:00:00Z',
    status: 'ok',
    demotions,
  }));
  ruleDemotion._resetCache();
  try {
    fn();
  } finally {
    ruleDemotion._resetCache();
  }
}

test('control pair (a): a rule on the active list demotes error -> warning; the finding still appears, reason attached', () => {
  withFixture({
    'testModule:noisy-rule': {
      from: 'error',
      to: 'warning',
      reason: 'field silence data: 35% of 100 findings silenced across 5 scans',
      silencedRate: 0.35,
      sampleSize: 100,
    },
  }, () => {
    const result = new TestResult('testModule');
    result.addCheck('testModule:noisy-rule', false, { message: 'x' });
    const check = result.checks[0];

    assert.equal(check.severity, 'warning', 'demoted — no longer blocks the gate');
    assert.equal(check.passed, false, 'still a finding, never hidden');
    assert.ok(check.demotedBy, 'the reason is attached, not silent');
    assert.equal(check.demotedBy.from, 'error');
    assert.equal(check.demotedBy.to, 'warning');
    assert.equal(check.demotedBy.silencedRate, 0.35);
    assert.equal(check.demotedBy.sampleSize, 100);

    assert.equal(result.errorChecks.length, 0, 'no longer counted as an error');
    assert.equal(result.warningChecks.length, 1, 'counted as a warning instead');
    assert.equal(result.demotedChecks.length, 1, 'surfaced in the disclosure getter');
  });
});

test('control pair (c): a rule NOT on the active list is untouched', () => {
  withFixture({
    'testModule:noisy-rule': {
      from: 'error', to: 'warning', reason: 'x', silencedRate: 0.35, sampleSize: 100,
    },
  }, () => {
    const result = new TestResult('testModule');
    result.addCheck('testModule:quiet-rule', false, { message: 'y' });
    const check = result.checks[0];

    assert.equal(check.severity, 'error');
    assert.equal(check.demotedBy, undefined);
    assert.equal(result.errorChecks.length, 1);
    assert.equal(result.demotedChecks.length, 0);
  });
});

test('no demotion list active: behaviour is exactly as before an empty/missing file changes nothing', () => {
  if (fs.existsSync(REAL_PATH)) fs.unlinkSync(REAL_PATH);
  ruleDemotion._resetCache();

  const result = new TestResult('testModule');
  result.addCheck('testModule:any-rule', false, {});

  assert.equal(result.checks[0].severity, 'error');
  assert.equal(result.checks[0].demotedBy, undefined);
  assert.equal(ruleDemotion.activeDemotionCount(), 0);
});

test('an explicit `severity` passed in `details` cannot silently undo a demotion (the addCheck construction-order fix)', () => {
  withFixture({
    'testModule:explicit-rule': {
      from: 'error', to: 'warning', reason: 'x', silencedRate: 0.5, sampleSize: 80,
    },
  }, () => {
    const result = new TestResult('testModule');
    // A module that spells out `severity: 'error'` explicitly, as most do —
    // this used to be spread back over the demoted value because `...details`
    // sat AFTER the `severity` key in the constructed check object.
    result.addCheck('testModule:explicit-rule', false, { severity: 'error', message: 'z' });
    assert.equal(result.checks[0].severity, 'warning');
    assert.ok(result.checks[0].demotedBy);
  });
});
