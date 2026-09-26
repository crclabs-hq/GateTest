'use strict';

/**
 * tests/false-positive-ledger.test.js — the false-positive SLA's tripwire
 * (the Fifty, move 20; complaint C1: nobody publishes how fast a scanner
 * fixes a false positive).
 *
 * Three checks:
 *   (a) docs/precision/retractions.json has the shape the website and the
 *       generator script both assume.
 *   (b) every entry's control-pair test file actually exists — a ledger
 *       entry pointing at a deleted test would be a claim nothing backs.
 *   (c) the SLA guard: no open `false-positive` issue older than 7 days
 *       without a `retracted` / `not-a-false-positive` label. The pure
 *       logic (checkSla) is always exercised; the real `gh` call only runs
 *       under GATETEST_FP_SLA_NETWORK_CHECK=1 with `gh auth` available, so
 *       the fast suite never touches the network.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { checkSla, ghAvailable, fetchOpenFalsePositiveIssues } = require('../src/core/fp-sla-guard');

const ROOT = path.resolve(__dirname, '..');
const LEDGER_PATH = path.join(ROOT, 'docs', 'precision', 'retractions.json');
const REPO = 'crclabs-hq/GateTest';

function loadLedger() {
  return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
}

describe('false-positive ledger — schema', () => {
  it('has an entries array with at least one seeded record', () => {
    const ledger = loadLedger();
    assert.ok(Array.isArray(ledger.entries), 'entries must be an array');
    assert.ok(ledger.entries.length > 0, 'ledger has no entries');
  });

  it('every entry has rule, reported.date, retracted, and a controlPairTest', () => {
    const ledger = loadLedger();
    for (const entry of ledger.entries) {
      assert.equal(typeof entry.rule, 'string', `entry missing string rule: ${JSON.stringify(entry)}`);
      assert.ok(entry.rule.length > 0, 'rule must not be empty');
      assert.ok(entry.reported && typeof entry.reported.date === 'string', `${entry.rule}: missing reported.date`);
      assert.ok(!Number.isNaN(new Date(entry.reported.date).getTime()), `${entry.rule}: reported.date is not a valid date`);
      assert.ok(entry.retracted && typeof entry.retracted.date === 'string', `${entry.rule}: missing retracted.date`);
      assert.ok(!Number.isNaN(new Date(entry.retracted.date).getTime()), `${entry.rule}: retracted.date is not a valid date`);
      assert.ok(typeof entry.retracted.pr === 'number', `${entry.rule}: retracted.pr must be a number`);
      assert.equal(typeof entry.controlPairTest, 'string', `${entry.rule}: missing controlPairTest`);
    }
  });

  it('computed fields are present and consistent with the entries', () => {
    const ledger = loadLedger();
    const { computeStats } = require('../scripts/generate-fp-ledger-stats');
    const fresh = computeStats(ledger);
    assert.equal(ledger.reportedCount, fresh.reportedCount, 'reportedCount is stale — run scripts/generate-fp-ledger-stats.js');
    assert.equal(ledger.retractedCount, fresh.retractedCount, 'retractedCount is stale — run scripts/generate-fp-ledger-stats.js');
    assert.equal(ledger.medianHoursToFix, fresh.medianHoursToFix, 'medianHoursToFix is stale — run scripts/generate-fp-ledger-stats.js');
  });

  it('the website copy (website/app/data/fp-ledger-stats.json) matches the ledger — one definition, imported', () => {
    const ledger = loadLedger();
    const websiteCopy = JSON.parse(fs.readFileSync(path.join(ROOT, 'website', 'app', 'data', 'fp-ledger-stats.json'), 'utf8'));
    assert.equal(websiteCopy.reportedCount, ledger.reportedCount);
    assert.equal(websiteCopy.retractedCount, ledger.retractedCount);
    assert.equal(websiteCopy.medianHoursToFix, ledger.medianHoursToFix);
  });
});

describe('false-positive ledger — control pairs exist', () => {
  it('every controlPairTest path exists in the repo', () => {
    const ledger = loadLedger();
    const missing = ledger.entries
      .map((e) => e.controlPairTest)
      .filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
    assert.deepEqual(missing, [], `control-pair test file(s) missing:\n${missing.join('\n')}`);
  });
});

describe('false-positive SLA guard — pure logic', () => {
  const now = new Date('2026-09-26T00:00:00Z');

  it('flags an open issue older than 7 days with no closing label', () => {
    const result = checkSla(
      [{ number: 1, createdAt: '2026-09-01T00:00:00Z', labels: [{ name: 'false-positive' }] }],
      now
    );
    assert.equal(result.ok, false);
    assert.equal(result.breaches.length, 1);
    assert.equal(result.breaches[0].number, 1);
  });

  it('does not flag an issue already labelled retracted', () => {
    const result = checkSla(
      [{ number: 2, createdAt: '2026-09-01T00:00:00Z', labels: [{ name: 'false-positive' }, { name: 'retracted' }] }],
      now
    );
    assert.equal(result.ok, true);
  });

  it('does not flag an issue labelled not-a-false-positive', () => {
    const result = checkSla(
      [{ number: 3, createdAt: '2026-09-01T00:00:00Z', labels: [{ name: 'false-positive' }, { name: 'not-a-false-positive' }] }],
      now
    );
    assert.equal(result.ok, true);
  });

  it('does not flag an issue still inside the 7-day window', () => {
    const result = checkSla(
      [{ number: 4, createdAt: '2026-09-21T00:00:00Z', labels: [{ name: 'false-positive' }] }],
      now
    );
    assert.equal(result.ok, true);
  });

  it('is a positive control: several breaches are all reported, not just the first', () => {
    const result = checkSla(
      [
        { number: 5, createdAt: '2026-09-01T00:00:00Z', labels: [{ name: 'false-positive' }] },
        { number: 6, createdAt: '2026-08-01T00:00:00Z', labels: [{ name: 'false-positive' }] },
      ],
      now
    );
    assert.equal(result.breaches.length, 2);
  });
});

describe('false-positive SLA guard — live check (network, opt-in)', () => {
  const enabled = process.env.GATETEST_FP_SLA_NETWORK_CHECK === '1';
  it(
    'no open false-positive issue on the real repo breaches the 7-day SLA',
    { skip: !enabled ? 'set GATETEST_FP_SLA_NETWORK_CHECK=1 (with `gh auth login` done) to run this against the live repo' : false },
    () => {
      if (!ghAvailable()) {
        console.log('[false-positive-ledger] gh is not authenticated — not checked');
        return;
      }
      const issues = fetchOpenFalsePositiveIssues(REPO);
      const result = checkSla(issues);
      assert.ok(
        result.ok,
        `false-positive SLA breached:\n${result.breaches.map((b) => `  #${b.number} open ${b.ageDays}d, no retracted/not-a-false-positive label`).join('\n')}`
      );
    }
  );
});
