// =============================================================================
// SITE-STATS GENERATOR — unit tests for the derivation logic
// =============================================================================
// The generator turns real test/module/flywheel measurements into the JSON
// the website displays. These tests pin the PURE derivation functions so the
// honesty contract can't silently break:
//   - displayed counts round DOWN (the public "N+" is always an understatement)
//   - parsing picks the FINAL TAP total, not a per-file intermediate
//   - carried-forward fields survive a run that doesn't re-measure them
// =============================================================================

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  parseTapSummary,
  roundDownTo,
  formatPlus,
  buildSiteStats,
} = require('../scripts/generate-site-stats.js');

describe('parseTapSummary', () => {
  it('extracts the final totals from a TAP summary block', () => {
    const tap = parseTapSummary([
      'ok 1 - something',
      '# tests 6234',
      '# pass 6233',
      '# fail 1',
      '# skip 1',
      '# todo 0',
    ].join('\n'));
    assert.strictEqual(tap.total, 6234);
    assert.strictEqual(tap.passing, 6233);
    assert.strictEqual(tap.failing, 1);
    assert.strictEqual(tap.skipped, 1);
  });

  it('picks the LAST total when node prints per-file then a final block', () => {
    const tap = parseTapSummary([
      '# pass 10',   // a per-file intermediate
      '# pass 4000', // the real final
    ].join('\n'));
    assert.strictEqual(tap.passing, 4000);
  });

  it('defaults to zeros on garbage input', () => {
    const tap = parseTapSummary('no tap here at all');
    assert.deepStrictEqual(tap, { total: 0, passing: 0, failing: 0, skipped: 0 });
    assert.deepStrictEqual(parseTapSummary(null), { total: 0, passing: 0, failing: 0, skipped: 0 });
  });
});

describe('roundDownTo', () => {
  it('always rounds down, never up', () => {
    assert.strictEqual(roundDownTo(6234), 6200);
    assert.strictEqual(roundDownTo(6299), 6200);
    assert.strictEqual(roundDownTo(6200), 6200);
    assert.strictEqual(roundDownTo(99), 0);
  });
  it('handles non-positive / non-finite input', () => {
    assert.strictEqual(roundDownTo(0), 0);
    assert.strictEqual(roundDownTo(-5), 0);
    assert.strictEqual(roundDownTo(NaN), 0);
  });
});

describe('formatPlus', () => {
  it('formats a conservative, comma-grouped "N+" string', () => {
    assert.strictEqual(formatPlus(6234), '6,200+');
    assert.strictEqual(formatPlus(1100), '1,100+');
  });
  it('the displayed number is never greater than the real count', () => {
    for (const real of [101, 555, 6234, 12345]) {
      const shown = Number(formatPlus(real).replace(/[+,]/g, ''));
      assert.ok(shown <= real, `${shown} should be <= ${real}`);
    }
  });
});

describe('buildSiteStats', () => {
  const flywheel = {
    all: { total: 12, claudeRatioPct: 33.33333, accuracyPct: 91.666 },
    recent7d: { total: 4 },
  };

  it('produces a fully-shaped, honest stats object', () => {
    const s = buildSiteStats({
      tap: { total: 6234, passing: 6230, failing: 0, skipped: 4 },
      moduleCount: 110,
      flywheel,
      now: Date.parse('2026-06-13T21:00:00Z'),
    });
    assert.strictEqual(s.modules.total, 110);
    assert.strictEqual(s.tests.passing, 6230);
    assert.strictEqual(s.tests.displayPassing, '6,200+');
    assert.strictEqual(s.flywheel.totalFixAttempts, 12);
    assert.strictEqual(s.flywheel.claudeRatioPct, 33.3);
    assert.strictEqual(s.flywheel.accuracyPct, 91.7);
    assert.match(s.generatedAt, /^2026-06-13T21:00:00/);
  });

  it('carries forward a self-scan green count when none is measured this run', () => {
    const s = buildSiteStats({
      tap: { total: 1, passing: 1, failing: 0, skipped: 0 },
      moduleCount: 110,
      flywheel,
      previous: { modules: { green: 102, scanned: 110, greenSource: 'measured', greenMeasuredAt: '2026-06-01T00:00:00Z' } },
    });
    assert.strictEqual(s.modules.green, 102);
    assert.strictEqual(s.modules.scanned, 110);
    assert.strictEqual(s.modules.displayGreen, '102/110');
    assert.strictEqual(s.modules.greenSource, 'measured');
    assert.strictEqual(s.modules.greenMeasuredAt, '2026-06-01T00:00:00Z');
  });

  it('marks green as freshly measured when supplied', () => {
    const s = buildSiteStats({
      tap: { total: 1, passing: 1, failing: 0, skipped: 0 },
      moduleCount: 110,
      flywheel,
      green: 104,
      scanned: 110,
      now: Date.parse('2026-06-13T00:00:00Z'),
    });
    assert.strictEqual(s.modules.green, 104);
    assert.strictEqual(s.modules.greenSource, 'measured');
    assert.match(s.modules.greenMeasuredAt, /^2026-06-13/);
  });

  it('defaults green/scanned to the module count on a first-ever run', () => {
    const s = buildSiteStats({
      tap: { total: 1, passing: 1, failing: 0, skipped: 0 },
      moduleCount: 110,
      flywheel,
    });
    assert.strictEqual(s.modules.green, 110);
    assert.strictEqual(s.modules.scanned, 110);
    assert.strictEqual(s.modules.greenSource, 'carried');
  });
});
