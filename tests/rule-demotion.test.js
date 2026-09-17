'use strict';

// src/core/rule-demotion.js — the Fifty, move 08: field-measured
// error->warning demotions. Pure unit tests over the loader/applier; the
// wiring into TestResult.addCheck (the one severity hook) is proven
// end-to-end in tests/rule-demotion-runner-wiring.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  loadDemotions, applyDemotion, activeDemotionCount, _resetCache, DEFAULT_PATH,
} = require('../src/core/rule-demotion');

const tmpFile = (name) => path.join(os.tmpdir(), `gatetest-rule-demotion-${process.pid}-${name}.json`);

test('DEFAULT_PATH points at the checked-in data/rule-demotions.json', () => {
  assert.match(DEFAULT_PATH.replace(/\\/g, '/'), /data\/rule-demotions\.json$/);
});

test('loadDemotions: a missing file means zero demotions, never a thrown error', () => {
  const missing = tmpFile('missing');
  const { demotions, status } = loadDemotions(missing);
  assert.deepEqual(demotions, {});
  assert.equal(status, 'unavailable');
});

test('loadDemotions: malformed JSON means zero demotions, never a thrown error', () => {
  const bad = tmpFile('malformed');
  fs.writeFileSync(bad, '{ not json');
  try {
    const { demotions, status } = loadDemotions(bad);
    assert.deepEqual(demotions, {});
    assert.equal(status, 'unavailable');
  } finally {
    fs.unlinkSync(bad);
  }
});

test('loadDemotions: a real generated file loads its demotions, generatedAt and status', () => {
  const file = tmpFile('real');
  fs.writeFileSync(file, JSON.stringify({
    generatedAt: '2026-09-17T00:00:00Z',
    status: 'ok',
    demotions: {
      'mod:rule': { from: 'error', to: 'warning', reason: 'x', silencedRate: 0.35, sampleSize: 100 },
    },
  }));
  try {
    const loaded = loadDemotions(file);
    assert.equal(loaded.status, 'ok');
    assert.equal(loaded.generatedAt, '2026-09-17T00:00:00Z');
    assert.deepEqual(Object.keys(loaded.demotions), ['mod:rule']);
  } finally {
    fs.unlinkSync(file);
  }
});

test('control pair (a): a listed rule is demoted, with from/to/reason/silencedRate/sampleSize attached', () => {
  const demotions = {
    'mod:rule': {
      from: 'error', to: 'warning',
      reason: 'field silence data: 35% of 100 findings silenced across 5 scans',
      silencedRate: 0.35, sampleSize: 100,
    },
  };
  const { severity, demotion } = applyDemotion('mod:rule', 'error', { demotions });
  assert.equal(severity, 'warning');
  assert.ok(demotion);
  assert.equal(demotion.from, 'error');
  assert.equal(demotion.to, 'warning');
  assert.equal(demotion.reason, demotions['mod:rule'].reason);
  assert.equal(demotion.silencedRate, 0.35);
  assert.equal(demotion.sampleSize, 100);
});

test('control pair (c): a rule NOT on the list is untouched', () => {
  const demotions = {
    'mod:rule': { from: 'error', to: 'warning', reason: 'x', silencedRate: 0.35, sampleSize: 100 },
  };
  const { severity, demotion } = applyDemotion('mod:other-rule', 'error', { demotions });
  assert.equal(severity, 'error');
  assert.equal(demotion, null);
});

test('applyDemotion only ever softens a failing error — warning/info severities and passing checks are left alone', () => {
  const demotions = {
    'mod:rule': { from: 'error', to: 'warning', reason: 'x', silencedRate: 0.9, sampleSize: 500 },
  };
  const warn = applyDemotion('mod:rule', 'warning', { demotions });
  assert.equal(warn.severity, 'warning');
  assert.equal(warn.demotion, null);

  const info = applyDemotion('mod:rule', 'info', { demotions });
  assert.equal(info.severity, 'info');
  assert.equal(info.demotion, null);
});

test('applyDemotion ignores an entry that does not target "warning" — the mechanism cannot sharpen or invent new severities', () => {
  const demotions = { 'mod:rule': { from: 'error', to: 'info', reason: 'x' } };
  const { severity, demotion } = applyDemotion('mod:rule', 'error', { demotions });
  assert.equal(severity, 'error');
  assert.equal(demotion, null);
});

test('activeDemotionCount reflects the loaded table size', () => {
  const file = tmpFile('count');
  fs.writeFileSync(file, JSON.stringify({ demotions: { a: {}, b: {} } }));
  try {
    _resetCache();
    assert.equal(activeDemotionCount(file), 2);
  } finally {
    fs.unlinkSync(file);
    _resetCache();
  }
});

test('activeDemotionCount is zero when nothing is loaded', () => {
  const missing = tmpFile('missing-count');
  _resetCache();
  assert.equal(activeDemotionCount(missing), 0);
  _resetCache();
});
