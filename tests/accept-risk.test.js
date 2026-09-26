'use strict';

// =============================================================================
// Accepted-risk overrides (move 3, docs/LAUNCH_BOARD.md) — a RECORDED,
// EXPIRING alternative to `.gatetestignore`. Complaint C8 (dev.to
// quality-gate posts, G2): teams route around gates that cannot be
// overridden; an UNRECORDED bypass is the real complaint.
//
// Control pair, top to bottom:
//   - an active override applies → the finding does not block, and shows up
//     in `overrides[]`.
//   - an EXPIRED override does the opposite of a suppression → the finding
//     blocks again, with a message naming the expired override.
//   - a missing `--reason` is never silently applied — a usage error under
//     `--strict`/CI, a loud warning (and the override ignored) otherwise.
// =============================================================================

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseAcceptRiskArgs,
  isExpired,
  mergeOverrides,
  buildOverrideMatcher,
  loadAcceptedRisks,
  saveAcceptedRisks,
  acceptedRisksPath,
} = require('../src/core/accept-risk');
const { TestResult } = require('../src/core/runner');

// ---------------------------------------------------------------------------
// parseAcceptRiskArgs — CLI grammar, following tests/cli-args.test.js's style.
// ---------------------------------------------------------------------------

describe('parseAcceptRiskArgs', () => {
  it('parses one full group and leaves other flags untouched', () => {
    const r = parseAcceptRiskArgs([
      '--suite', 'quick',
      '--accept-risk', 'secrets:apiKey:src/db.js:12',
      '--reason', 'rotated key, low blast radius',
      '--until', '2026-12-31',
      '--by', 'craig',
      '--strict',
    ]);
    assert.equal(r.overrides.length, 1);
    assert.deepEqual(r.overrides[0], {
      id: 'secrets:apiKey:src/db.js:12',
      reason: 'rotated key, low blast radius',
      by: 'craig',
      until: '2026-12-31',
    });
    assert.equal(r.persist, false);
    assert.equal(r.errors.length, 0);
    assert.deepEqual(r.remainingArgv, ['--suite', 'quick', '--strict']);
  });

  it('is repeatable — each --accept-risk opens its own group', () => {
    const r = parseAcceptRiskArgs([
      '--accept-risk', 'a:1', '--reason', 'r1',
      '--accept-risk', 'b:2', '--reason', 'r2', '--by', 'craig',
    ]);
    assert.equal(r.overrides.length, 2);
    assert.equal(r.overrides[0].id, 'a:1');
    assert.equal(r.overrides[0].reason, 'r1');
    assert.equal(r.overrides[0].by, null);
    assert.equal(r.overrides[1].id, 'b:2');
    assert.equal(r.overrides[1].by, 'craig');
  });

  it('--persist is a bare, order-independent flag', () => {
    const r = parseAcceptRiskArgs(['--accept-risk', 'a:1', '--reason', 'r1', '--persist']);
    assert.equal(r.persist, true);
    assert.equal(r.overrides[0].id, 'a:1');
  });

  it('missing --reason is reported as an error but the group is still returned', () => {
    const r = parseAcceptRiskArgs(['--accept-risk', 'a:1']);
    assert.equal(r.overrides.length, 1);
    assert.equal(r.overrides[0].reason, null);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /a:1.*missing --reason/);
  });

  it('--accept-risk with no id (end of argv or a flag right after) is an error, not a crash', () => {
    const r1 = parseAcceptRiskArgs(['--accept-risk']);
    assert.equal(r1.overrides.length, 0);
    assert.equal(r1.errors.length, 1);
    assert.match(r1.errors[0], /needs a finding id/);

    const r2 = parseAcceptRiskArgs(['--accept-risk', '--reason', 'x']);
    assert.equal(r2.errors.length, 1);
    assert.match(r2.errors[0], /needs a finding id/);
  });

  it('no --accept-risk at all → empty overrides, argv passed through unchanged', () => {
    const r = parseAcceptRiskArgs(['--suite', 'full', '--strict']);
    assert.deepEqual(r.overrides, []);
    assert.equal(r.errors.length, 0);
    assert.deepEqual(r.remainingArgv, ['--suite', 'full', '--strict']);
  });
});

// ---------------------------------------------------------------------------
// isExpired
// ---------------------------------------------------------------------------

describe('isExpired', () => {
  it('no `until` never expires', () => {
    assert.equal(isExpired(null), false);
    assert.equal(isExpired(undefined), false);
  });

  it('a past date has expired', () => {
    assert.equal(isExpired('2020-01-01', new Date('2026-01-01')), true);
  });

  it('a future date has not expired', () => {
    assert.equal(isExpired('2099-01-01', new Date('2026-01-01')), false);
  });

  it('an unparsable date never silently expires', () => {
    assert.equal(isExpired('not-a-date', new Date('2026-01-01')), false);
  });
});

// ---------------------------------------------------------------------------
// mergeOverrides — CLI wins on a shared id; reasonless entries are dropped.
// ---------------------------------------------------------------------------

describe('mergeOverrides', () => {
  it('CLI overrides win over a file entry with the same id', () => {
    const merged = mergeOverrides(
      [{ id: 'a:1', reason: 'old reason', by: 'craig' }],
      [{ id: 'a:1', reason: 'new reason', by: null, until: '2026-12-01' }],
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0].reason, 'new reason');
    assert.equal(merged[0].until, '2026-12-01');
  });

  it('drops any override without a reason from either source', () => {
    const merged = mergeOverrides([{ id: 'a:1', reason: null }], [{ id: 'b:2' }]);
    assert.deepEqual(merged, []);
  });

  it('keeps distinct ids from both sources', () => {
    const merged = mergeOverrides([{ id: 'a:1', reason: 'r1' }], [{ id: 'b:2', reason: 'r2' }]);
    assert.equal(merged.length, 2);
  });
});

// ---------------------------------------------------------------------------
// buildOverrideMatcher — id-exact match against the same identity every
// other surface uses (`${module}:${checkName}`).
// ---------------------------------------------------------------------------

describe('buildOverrideMatcher', () => {
  it('matches an active override', () => {
    const m = buildOverrideMatcher([{ id: 'secrets:apiKey', reason: 'r', until: '2099-01-01' }]);
    const hit = m.match('secrets:apiKey');
    assert.ok(hit);
    assert.equal(hit.expired, false);
  });

  it('flags an override past its `until` as expired', () => {
    const m = buildOverrideMatcher(
      [{ id: 'secrets:apiKey', reason: 'r', until: '2020-01-01' }],
      { now: new Date('2026-01-01') },
    );
    const hit = m.match('secrets:apiKey');
    assert.ok(hit);
    assert.equal(hit.expired, true);
  });

  it('no match for an id not on record', () => {
    const m = buildOverrideMatcher([{ id: 'secrets:apiKey', reason: 'r' }]);
    assert.equal(m.match('secrets:otherRule'), null);
  });
});

// ---------------------------------------------------------------------------
// .gatetest/accepted-risks.json — load/save round trip.
// ---------------------------------------------------------------------------

describe('loadAcceptedRisks / saveAcceptedRisks', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-accept-risk-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('no file at all → []', () => {
    assert.deepEqual(loadAcceptedRisks(tmp), []);
  });

  it('malformed JSON → [] (never throws)', () => {
    fs.mkdirSync(path.join(tmp, '.gatetest'), { recursive: true });
    fs.writeFileSync(acceptedRisksPath(tmp), '{ not json');
    assert.deepEqual(loadAcceptedRisks(tmp), []);
  });

  it('saveAcceptedRisks writes the array, loadAcceptedRisks reads it back', () => {
    const overrides = [{ id: 'a:1', reason: 'r', by: 'craig', until: null, created: '2026-01-01T00:00:00.000Z' }];
    const written = saveAcceptedRisks(tmp, overrides);
    assert.equal(written, acceptedRisksPath(tmp));
    assert.deepEqual(loadAcceptedRisks(tmp), overrides);
  });

  it('non-array JSON reads as []', () => {
    fs.mkdirSync(path.join(tmp, '.gatetest'), { recursive: true });
    fs.writeFileSync(acceptedRisksPath(tmp), JSON.stringify({ id: 'not-an-array' }));
    assert.deepEqual(loadAcceptedRisks(tmp), []);
  });
});

// ---------------------------------------------------------------------------
// Runner integration — the control pair the spec calls for:
//   active override applied  → not blocking, present in the finding as
//                               `overriddenBy`.
//   expired override         → blocking, with a message naming it.
// Mirrors tests/runner-suppression.test.js's TestResult-level style.
// ---------------------------------------------------------------------------

function confidentError(name, file) {
  return [name, false, { severity: 'error', file, message: 'boom', confidence: 0.95 }];
}

describe('runner — accepted-risk overrides', () => {
  it('an active override does not block, but the finding is NOT suppressed/hidden', () => {
    const matcher = buildOverrideMatcher([{ id: 'secrets:apiKey', reason: 'accepted for now', by: 'craig', until: '2099-01-01' }]);
    const r = new TestResult('secrets', { blockThreshold: 0.7, acceptRiskMatcher: matcher });
    r.addCheck(...confidentError('apiKey', 'src/db.js'));
    assert.equal(r.blockingErrorChecks.length, 0, 'accepted risk must not block');
    assert.equal(r.suppressedChecks.length, 0, 'accepted risk is never suppressed/hidden');
    assert.equal(r.errorChecks.length, 1, 'the finding still shows up as an error');
    assert.equal(r.checks[0].overriddenBy.reason, 'accepted for now');
  });

  it('an EXPIRED override blocks again, naming itself in the message', () => {
    const matcher = buildOverrideMatcher(
      [{ id: 'secrets:apiKey', reason: 'accepted once', by: 'craig', until: '2020-01-01' }],
      { now: new Date('2026-01-01') },
    );
    const r = new TestResult('secrets', { blockThreshold: 0.7, acceptRiskMatcher: matcher });
    r.addCheck(...confidentError('apiKey', 'src/db.js'));
    assert.equal(r.blockingErrorChecks.length, 1, 'an expired override blocks again');
    assert.match(r.checks[0].message, /accepted-risk override by craig expired 2020-01-01/);
  });

  it('an id with no matching override still blocks, unaffected', () => {
    const matcher = buildOverrideMatcher([{ id: 'secrets:otherRule', reason: 'r' }]);
    const r = new TestResult('secrets', { blockThreshold: 0.7, acceptRiskMatcher: matcher });
    r.addCheck(...confidentError('apiKey', 'src/db.js'));
    assert.equal(r.blockingErrorChecks.length, 1);
  });

  it('no matcher at all → legacy behavior, unaffected', () => {
    const r = new TestResult('secrets', { blockThreshold: 0.7 });
    r.addCheck(...confidentError('apiKey', 'src/db.js'));
    assert.equal(r.blockingErrorChecks.length, 1);
  });
});
