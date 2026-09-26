// =============================================================================
// Confidence calibration — the threshold is measured, not chosen (move 09)
// =============================================================================
// src/core/confidence-calibration.js is pure, so it is proven here on
// hand-built corpora with known answers. Then the committed precision.json —
// written by the corpus runner from a real run — is held to the shipped
// BLOCK_THRESHOLD: the threshold it was calibrated for is the one the engine
// ships, it sits inside a gap between observed bands (moving it within the
// gap changes nothing, so it is not a load-bearing number), and the recall
// floor held at that threshold.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { calibrate, findingsFromReport, CANDIDATES } = require('../src/core/confidence-calibration');
const { BLOCK_THRESHOLD } = require('../src/core/confidence');
const { ruleIdentity } = require('../src/core/rule-identity');

const ROOT = path.join(__dirname, '..');

const corpus = () => ({
  threshold: 0.7,
  repos: [
    { name: 'clean', kind: 'precision', findings: [
      { rule: 'a', confidence: 1 }, { rule: 'a', confidence: 0.6 }, { rule: 'b', confidence: 0.6 }, { rule: 'c', confidence: 0.24 },
    ] },
    { name: 'also-clean', kind: 'precision', findings: [{ rule: 'a', confidence: 1 }, { rule: 'd', confidence: 0.4 }] },
    { name: 'vulnerable', kind: 'recall', floor: 2, findings: [
      { rule: 'x', confidence: 1 }, { rule: 'y', confidence: 1 }, { rule: 'z', confidence: 0.2 },
    ] },
  ],
});

describe('calibrate — bands', () => {
  it('lists every distinct confidence once, highest first, with per-side rule counts', () => {
    const c = calibrate(corpus());
    assert.deepEqual(c.bands.map((b) => b.confidence), [1, 0.6, 0.4, 0.24, 0.2]);
    const top = c.bands[0];
    assert.equal(top.precision, 2);
    assert.equal(top.recall, 2);
    assert.deepEqual(top.rules, { precision: { a: 2 }, recall: { x: 1, y: 1 } });
    assert.deepEqual(c.bands[1].rules, { precision: { a: 1, b: 1 }, recall: {} });
  });
  it('a finding without a confidence counts as 1.0 — the engine\'s default', () => {
    const c = calibrate({ threshold: 0.7, repos: [{ name: 'r', kind: 'precision', findings: [{ rule: 'a' }] }] });
    assert.deepEqual(c.bands.map((b) => [b.confidence, b.precision]), [[1, 1]]);
  });
});

describe('calibrate — sweep, gap, softened', () => {
  it('sweeps the candidates plus the shipped threshold and marks the shipped one', () => {
    const c = calibrate(corpus());
    assert.deepEqual(c.sweep.map((s) => s.threshold), CANDIDATES);
    const at = (t) => c.sweep.find((s) => s.threshold === t);
    assert.deepEqual([at(0.5).precisionBlocking, at(0.5).recallBlocking], [4, 2]);
    assert.deepEqual([at(0.7).precisionBlocking, at(0.7).recallBlocking], [2, 2]);
    assert.equal(at(0.7).shipped, true);
    assert.equal(c.sweep.filter((s) => s.shipped).length, 1);
  });
  it('an off-list shipped threshold is added to the sweep', () => {
    const c = calibrate({ ...corpus(), threshold: 0.55 });
    assert.ok(c.sweep.some((s) => s.threshold === 0.55 && s.shipped));
  });
  it('the gap is the highest band below and the lowest band at or above the threshold', () => {
    assert.deepEqual(calibrate(corpus()).gap, { below: 0.6, above: 1 });
    assert.deepEqual(calibrate({ ...corpus(), threshold: 0.6 }).gap, { below: 0.4, above: 0.6 });
    assert.deepEqual(calibrate({ ...corpus(), threshold: 0.1 }).gap, { below: null, above: 0.2 });
  });
  it('softened says what the threshold bought and what it cost', () => {
    const c = calibrate(corpus());
    assert.deepEqual(c.softened, {
      precisionTotal: 6, precisionBlocking: 2, precisionSoftened: 4,
      recallTotal: 3, recallBlocking: 2, recallLost: 1,
    });
    assert.deepEqual(c.recallRepos, [{ name: 'vulnerable', blocking: 2, floor: 2, held: true }]);
    assert.equal(calibrate({ ...corpus(), threshold: 1.01 }).recallRepos[0].held, false);
  });
});

describe('findingsFromReport', () => {
  it('keeps error-severity checks only, as rule identity + confidence', () => {
    const report = { results: [
      { name: 'secrets', module: 'secrets', checks: [
        { name: 'secrets:aws:src/a.js:3', file: 'src/a.js', severity: 'error', confidence: 0.4 },
        { name: 'secrets:aws:src/b.js:9', file: 'src/b.js', severity: 'error' },
        { name: 'secrets:ok', severity: 'info', confidence: 1 },
      ] },
      { name: 'empty', module: 'empty', checks: [] },
    ] };
    assert.deepEqual(findingsFromReport(report, ruleIdentity), [
      { rule: 'secrets:aws', confidence: 0.4, module: 'secrets' },
      { rule: 'secrets:aws', confidence: 1, module: 'secrets' },
    ]);
    assert.deepEqual(findingsFromReport(null, ruleIdentity), []);
  });
});

describe('precision.json — calibrated for the threshold the engine ships', () => {
  const page = JSON.parse(fs.readFileSync(path.join(ROOT, 'website', 'app', 'data', 'precision.json'), 'utf8'));
  const cal = page.calibration;

  it('carries a calibration block written by the corpus run', () => {
    assert.ok(cal && Array.isArray(cal.bands) && Array.isArray(cal.sweep), 'regenerate with scripts/real-world-precision.js --write-json');
  });
  it('was calibrated for the shipped BLOCK_THRESHOLD — change one, regenerate the other', () => {
    assert.equal(cal.threshold, BLOCK_THRESHOLD);
    assert.ok(cal.sweep.some((s) => s.shipped && s.threshold === BLOCK_THRESHOLD));
  });
  it('the shipped threshold sits inside a gap between observed bands, not on an edge', () => {
    // A band AT the threshold means the number decides real findings' fate
    // and needs a reason in confidence.js; the corpus has never produced one.
    assert.ok(cal.gap.below === null || cal.gap.below < BLOCK_THRESHOLD);
    assert.ok(cal.gap.above === null || cal.gap.above > BLOCK_THRESHOLD, `a band sits exactly at ${cal.gap.above}`);
    assert.ok(!cal.bands.some((b) => b.confidence === BLOCK_THRESHOLD));
  });
  it('the recall floor held at the shipped threshold', () => {
    assert.ok(cal.recallRepos.length >= 1);
    for (const r of cal.recallRepos) assert.equal(r.held, true, `${r.name}: ${r.blocking} < floor ${r.floor}`);
  });
  it('softening bought precision at no recall cost worth the name', () => {
    assert.ok(cal.softened.precisionSoftened > 0, 'no signal fired on any precision repo — the model is not doing anything');
    assert.ok(cal.softened.recallLost <= cal.softened.recallTotal * 0.05, 'the threshold is hiding real findings');
  });
});
