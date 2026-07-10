'use strict';

// =============================================================================
// Runner suppression + flywheel softening (WS2) — .gatetestignore excludes a
// finding from the gate (visible but silenced); a per-module penalty softens
// a confident error below the block threshold.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { TestResult } = require('../src/core/runner');
const { parse } = require('../src/core/ignore-file');

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
