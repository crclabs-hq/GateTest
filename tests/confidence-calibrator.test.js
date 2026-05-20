// =============================================================================
// CONFIDENCE CALIBRATOR TRAINER TEST
// =============================================================================

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const CC = require('../website/app/lib/trainers/confidence-calibrator.js');

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe('confidence-calibrator — shape', () => {
  it('exports calibrate, renderMarkdown', () => {
    assert.strictEqual(typeof CC.calibrate, 'function');
    assert.strictEqual(typeof CC.renderMarkdown, 'function');
  });

  it('exposes the policy constants', () => {
    assert.strictEqual(typeof CC.MIN_UNIQUE_IPS_FOR_FP_DOWNGRADE, 'number');
    assert.strictEqual(typeof CC.FP_THRESHOLD, 'number');
    assert.strictEqual(typeof CC.MIN_UNIQUE_IPS_FOR_SUPPRESS_MARKER, 'number');
    assert.strictEqual(typeof CC.SUPPRESS_THRESHOLD, 'number');
    assert.strictEqual(typeof CC.MIN_UNIQUE_IPS_FOR_BROAD_REVIEW, 'number');
  });
});

// ---------------------------------------------------------------------------
// ratioOf
// ---------------------------------------------------------------------------

describe('confidence-calibrator — ratioOf', () => {
  it('returns matched / total', () => {
    assert.strictEqual(CC._ratioOf({ 'false-positive': 3, other: 1 }, ['false-positive']), 0.75);
  });

  it('returns 0 on empty breakdown', () => {
    assert.strictEqual(CC._ratioOf({}, ['false-positive']), 0);
  });

  it('sums multiple matched reasons', () => {
    const r = CC._ratioOf({ intended: 2, 'wont-fix': 2, other: 1 }, ['intended', 'wont-fix']);
    assert.strictEqual(r, 0.8);
  });
});

// ---------------------------------------------------------------------------
// classifyRule — the heuristic
// ---------------------------------------------------------------------------

describe('confidence-calibrator — classifyRule', () => {
  it('recommends downgrade-severity for ≥3 IPs and >50% false-positive', () => {
    const c = CC._classifyRule({
      rule: 'r',
      uniqueIps: 5,
      totalDismissals: 10,
      reasonBreakdown: { 'false-positive': 7, other: 3 },
    });
    assert.ok(c);
    assert.strictEqual(c.kind, 'downgrade-severity');
  });

  it('recommends add-suppression-marker for ≥5 IPs and >70% suppressible reasons', () => {
    const c = CC._classifyRule({
      rule: 'r',
      uniqueIps: 8,
      totalDismissals: 20,
      reasonBreakdown: { intended: 10, 'wont-fix': 6, other: 4 },
    });
    assert.ok(c);
    assert.strictEqual(c.kind, 'add-suppression-marker');
  });

  it('recommends reviewer-attention for ≥10 IPs (broadest signal wins)', () => {
    const c = CC._classifyRule({
      rule: 'r',
      uniqueIps: 15,
      totalDismissals: 30,
      reasonBreakdown: { 'false-positive': 12, intended: 10, other: 8 },
    });
    assert.ok(c);
    assert.strictEqual(c.kind, 'reviewer-attention');
  });

  it('returns null below thresholds', () => {
    const c = CC._classifyRule({
      rule: 'r',
      uniqueIps: 2,
      totalDismissals: 4,
      reasonBreakdown: { 'false-positive': 3, other: 1 },
    });
    assert.strictEqual(c, null);
  });

  it('returns null on missing/malformed input', () => {
    assert.strictEqual(CC._classifyRule(null), null);
    assert.strictEqual(CC._classifyRule({}), null);
    assert.strictEqual(CC._classifyRule({ uniqueIps: 5, reasonBreakdown: {} }), null);
  });

  it('does NOT recommend downgrade for <3 IPs even if 100% FP', () => {
    const c = CC._classifyRule({
      rule: 'r',
      uniqueIps: 2,
      totalDismissals: 100,
      reasonBreakdown: { 'false-positive': 100 },
    });
    assert.strictEqual(c, null);
  });
});

// ---------------------------------------------------------------------------
// calibrate — full pipeline with injected statsByRule
// ---------------------------------------------------------------------------

describe('confidence-calibrator — calibrate', () => {
  it('returns empty recommendations when no rules in corpus', async () => {
    const report = await CC.calibrate({ statsByRule: async () => [] });
    assert.strictEqual(report.recommendations.length, 0);
    assert.strictEqual(report.rulesAnalysed, 0);
  });

  it('emits one recommendation per qualifying rule', async () => {
    const fakeStats = [
      {
        rule: 'security:eval',
        totalDismissals: 12,
        uniqueScans: 8,
        uniqueIps: 6,
        reasonBreakdown: { 'false-positive': 10, other: 2 },
        firstSeenAt: new Date('2026-04-01T00:00:00Z'),
        lastSeenAt: new Date('2026-05-19T00:00:00Z'),
      },
      {
        rule: 'lint:trailing-whitespace',
        totalDismissals: 50,
        uniqueScans: 30,
        uniqueIps: 18,
        reasonBreakdown: { 'false-positive': 15, intended: 20, 'wont-fix': 15 },
        firstSeenAt: new Date('2026-04-01T00:00:00Z'),
        lastSeenAt: new Date('2026-05-19T00:00:00Z'),
      },
      // Below threshold — not recommended
      {
        rule: 'security:rare',
        totalDismissals: 1,
        uniqueScans: 1,
        uniqueIps: 1,
        reasonBreakdown: { 'false-positive': 1 },
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      },
    ];
    const report = await CC.calibrate({ statsByRule: async () => fakeStats });
    assert.strictEqual(report.rulesAnalysed, 3);
    assert.strictEqual(report.recommendations.length, 2);
    const evalRec = report.recommendations.find((r) => r.rule === 'security:eval');
    assert.strictEqual(evalRec.kind, 'downgrade-severity');
    const lintRec = report.recommendations.find((r) => r.rule === 'lint:trailing-whitespace');
    assert.strictEqual(lintRec.kind, 'reviewer-attention');
  });

  it('caps at MAX_RECOMMENDATIONS', async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      rule: 'r' + i,
      totalDismissals: 20,
      uniqueScans: 12,
      uniqueIps: 6,
      reasonBreakdown: { 'false-positive': 15, other: 5 },
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    }));
    const report = await CC.calibrate({ statsByRule: async () => many });
    assert.ok(report.recommendations.length <= 50);
  });

  it('handles statsByRule throwing gracefully', async () => {
    const report = await CC.calibrate({
      statsByRule: async () => { throw new Error('db gone'); },
    });
    assert.strictEqual(report.rulesAnalysed, 0);
    assert.strictEqual(report.recommendations.length, 0);
  });
});

// ---------------------------------------------------------------------------
// renderMarkdown
// ---------------------------------------------------------------------------

describe('confidence-calibrator — renderMarkdown', () => {
  it('renders empty corpus message', () => {
    const md = CC.renderMarkdown({
      generatedAt: new Date().toISOString(),
      sinceDays: 90,
      rulesAnalysed: 0,
      recommendations: [],
      byKind: { 'reviewer-attention': 0, 'add-suppression-marker': 0, 'downgrade-severity': 0 },
    });
    assert.ok(md.includes('# Confidence Calibrator'));
    assert.ok(md.includes('No actionable suppression patterns'));
  });

  it('renders recommendation table', () => {
    const md = CC.renderMarkdown({
      generatedAt: new Date().toISOString(),
      sinceDays: 90,
      rulesAnalysed: 1,
      recommendations: [{
        rule: 'security:eval',
        kind: 'downgrade-severity',
        reason: '80% FP',
        totalDismissals: 10,
        uniqueIps: 5,
      }],
      byKind: { 'reviewer-attention': 0, 'add-suppression-marker': 0, 'downgrade-severity': 1 },
    });
    assert.ok(md.includes('security:eval'));
    assert.ok(md.includes('downgrade-severity'));
    assert.ok(md.includes('| Rule |'));
  });
});
