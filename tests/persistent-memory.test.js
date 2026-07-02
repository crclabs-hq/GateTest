'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');

const {
  load,
  save,
  recordScan,
  recordFixFeedback,
  recordSuppression,
  getSmartSuiteBoosts,
  getFixConfidenceMultiplier,
  getQualityTrend,
} = require('../src/core/persistent-memory');

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gt-mem-'));
}

// ── load / save ───────────────────────────────────────────────────────────────

test('load returns default schema when .gatetest/memory.json absent', () => {
  const root = tmpRoot();
  const data = load(root);
  assert.equal(data.scanCount, 0);
  assert.equal(typeof data.modules, 'object');
  assert.ok(Array.isArray(data.qualityTrend));
  assert.ok(Array.isArray(data.scans));
});

test('save + load round-trips data correctly', () => {
  const root = tmpRoot();
  const data = load(root);
  data.scanCount = 42;
  data.modules['secrets'] = { runs: 10, fires: 7, suppressions: 1, fireRate: 0.7 };
  save(root, data);

  const reloaded = load(root);
  assert.equal(reloaded.scanCount, 42);
  assert.equal(reloaded.modules.secrets.fires, 7);
  assert.ok(reloaded.updatedAt); // save sets updatedAt
});

test('save never throws when directory creation fails gracefully', () => {
  // Passing /dev/null as root so mkdirSync would fail
  assert.doesNotThrow(() => save('/dev/null/nonexistent', { version: 2, modules: {} }));
});

test('load never throws on corrupted JSON', () => {
  const root = tmpRoot();
  const dir  = path.join(root, '.gatetest');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory.json'), 'NOT JSON', 'utf-8');
  assert.doesNotThrow(() => load(root));
  const data = load(root);
  assert.equal(data.scanCount, 0); // returns default
});

// ── recordScan ────────────────────────────────────────────────────────────────

test('recordScan increments scanCount', () => {
  const root = tmpRoot();
  recordScan(root, { modules: [], totalIssues: 3, duration: 5000, suite: 'quick' });
  const data = load(root);
  assert.equal(data.scanCount, 1);
});

test('recordScan tracks per-module fire rates', () => {
  const root = tmpRoot();
  const modules = [
    { name: 'secrets',  status: 'failed', errors: 1, warnings: 0 },
    { name: 'syntax',   status: 'passed', errors: 0, warnings: 0 },
  ];
  recordScan(root, { modules, totalIssues: 1, duration: 2000, suite: 'quick' });
  const data = load(root);
  assert.equal(data.modules['secrets'].fires, 1);
  assert.equal(data.modules['syntax'].fires,  0);
  assert.equal(data.modules['secrets'].fireRate, 1.0);
  assert.equal(data.modules['syntax'].fireRate,  0.0);
});

test('recordScan fire rate is cumulative across multiple scans', () => {
  const root = tmpRoot();
  const mod = (fired) => [{ name: 'nPlusOne', status: fired ? 'failed' : 'passed', errors: fired ? 1 : 0, warnings: 0 }];
  recordScan(root, { modules: mod(true),  totalIssues: 1, duration: 1000, suite: 'quick' });
  recordScan(root, { modules: mod(false), totalIssues: 0, duration: 1000, suite: 'quick' });
  recordScan(root, { modules: mod(true),  totalIssues: 1, duration: 1000, suite: 'quick' });
  const data = load(root);
  const s = data.modules['nPlusOne'];
  assert.equal(s.runs, 3);
  assert.equal(s.fires, 2);
  assert.equal(s.fireRate, 0.667);
});

test('recordScan appends to qualityTrend', () => {
  const root = tmpRoot();
  recordScan(root, { modules: [], totalIssues: 10, duration: 3000, suite: 'full', introduced: 3, fixed: 1 });
  const data = load(root);
  assert.equal(data.qualityTrend.length, 1);
  assert.equal(data.qualityTrend[0].totalIssues, 10);
  assert.equal(data.qualityTrend[0].netDelta, 2);
});

test('recordScan appends to scans history', () => {
  const root = tmpRoot();
  recordScan(root, { modules: [{ name: 'lint', status: 'passed' }], totalIssues: 0, duration: 8000, suite: 'smart' }, ['src/auth.ts']);
  const data = load(root);
  assert.equal(data.scans.length, 1);
  assert.equal(data.scans[0].filesChanged, 1);
  assert.equal(data.scans[0].suite, 'smart');
});

// ── recordFixFeedback ─────────────────────────────────────────────────────────

test('recordFixFeedback tracks merges and rejections', () => {
  const root = tmpRoot();
  recordFixFeedback(root, 'js-httponly-false', true);
  recordFixFeedback(root, 'js-httponly-false', true);
  recordFixFeedback(root, 'js-httponly-false', false);
  const data = load(root);
  const f = data.fixes['js-httponly-false'];
  assert.equal(f.attempts, 3);
  assert.equal(f.merges, 2);
  assert.equal(f.rejections, 1);
  assert.ok(Math.abs(f.acceptRate - 0.667) < 0.001);
});

// ── recordSuppression ─────────────────────────────────────────────────────────

test('recordSuppression increments count for module:ruleKey', () => {
  const root = tmpRoot();
  recordSuppression(root, 'hardcodedUrl', 'localhost-url', 'http://localhost:3000');
  recordSuppression(root, 'hardcodedUrl', 'localhost-url');
  const data = load(root);
  assert.equal(data.suppressions['hardcodedUrl:localhost-url'].count, 2);
});

// ── getSmartSuiteBoosts ───────────────────────────────────────────────────────

test('getSmartSuiteBoosts returns empty object when no history', () => {
  const root = tmpRoot();
  const boosts = getSmartSuiteBoosts(root);
  assert.deepEqual(boosts, {});
});

test('getSmartSuiteBoosts gives boost 3 to module firing in >70% of scans', () => {
  const root = tmpRoot();
  // Simulate 5 scans where nPlusOne fires every time (100%)
  for (let i = 0; i < 5; i++) {
    recordScan(root, {
      modules: [{ name: 'nPlusOne', status: 'failed', errors: 2, warnings: 0 }],
      totalIssues: 2, duration: 1000, suite: 'quick',
    });
  }
  const boosts = getSmartSuiteBoosts(root);
  assert.ok(boosts['nPlusOne'] >= 3, `expected boost ≥ 3, got ${boosts['nPlusOne']}`);
});

test('getSmartSuiteBoosts requires ≥3 runs to issue a boost', () => {
  const root = tmpRoot();
  // Only 2 scans — not enough data
  for (let i = 0; i < 2; i++) {
    recordScan(root, {
      modules: [{ name: 'moneyFloat', status: 'failed', errors: 1, warnings: 0 }],
      totalIssues: 1, duration: 1000, suite: 'quick',
    });
  }
  const boosts = getSmartSuiteBoosts(root);
  assert.ok(!boosts['moneyFloat'], 'should not boost with only 2 scans');
});

// ── getFixConfidenceMultiplier ────────────────────────────────────────────────

test('getFixConfidenceMultiplier returns 1.0 with no history', () => {
  const root = tmpRoot();
  assert.equal(getFixConfidenceMultiplier(root, 'js-parse-float'), 1.0);
});

test('getFixConfidenceMultiplier returns 1.0 with fewer than 3 attempts', () => {
  const root = tmpRoot();
  recordFixFeedback(root, 'js-parse-float', true);
  recordFixFeedback(root, 'js-parse-float', false);
  assert.equal(getFixConfidenceMultiplier(root, 'js-parse-float'), 1.0);
});

test('getFixConfidenceMultiplier penalises rule rejected >60% of time', () => {
  const root = tmpRoot();
  recordFixFeedback(root, 'bad-rule', false);
  recordFixFeedback(root, 'bad-rule', false);
  recordFixFeedback(root, 'bad-rule', false);
  const mult = getFixConfidenceMultiplier(root, 'bad-rule');
  assert.ok(mult < 1.0, `expected penalty multiplier, got ${mult}`);
});

test('getFixConfidenceMultiplier boosts rule accepted ≥70% of time', () => {
  const root = tmpRoot();
  recordFixFeedback(root, 'good-rule', true);
  recordFixFeedback(root, 'good-rule', true);
  recordFixFeedback(root, 'good-rule', true);
  const mult = getFixConfidenceMultiplier(root, 'good-rule');
  assert.ok(mult >= 1.0, `expected boost multiplier, got ${mult}`);
});

// ── getQualityTrend ───────────────────────────────────────────────────────────

test('getQualityTrend returns insufficient-data with no scans', () => {
  const root  = tmpRoot();
  const trend = getQualityTrend(root);
  assert.equal(trend.trend, 'insufficient-data');
});

test('getQualityTrend returns improving when net issues decreased', () => {
  const root = tmpRoot();
  // Simulate scans where we consistently fix more than we introduce
  for (let i = 0; i < 3; i++) {
    recordScan(root, {
      modules: [], totalIssues: 5, duration: 1000, suite: 'quick',
      introduced: 0, fixed: 5,
    });
  }
  const trend = getQualityTrend(root, 30);
  assert.equal(trend.trend, 'improving');
  assert.ok(trend.netDelta < 0);
});

test('getQualityTrend returns declining when net issues increased', () => {
  const root = tmpRoot();
  for (let i = 0; i < 3; i++) {
    recordScan(root, {
      modules: [], totalIssues: 20, duration: 1000, suite: 'quick',
      introduced: 10, fixed: 0,
    });
  }
  const trend = getQualityTrend(root, 30);
  assert.equal(trend.trend, 'declining');
  assert.ok(trend.netDelta > 0);
});

test('getQualityTrend topModule is the highest-firing module with enough data', () => {
  const root = tmpRoot();
  for (let i = 0; i < 5; i++) {
    recordScan(root, {
      modules: [
        { name: 'logPii',   status: 'failed', errors: 1, warnings: 0 },
        { name: 'syntax',   status: 'passed', errors: 0, warnings: 0 },
      ],
      totalIssues: 1, duration: 1000, suite: 'quick',
    });
  }
  const trend = getQualityTrend(root, 30);
  assert.equal(trend.topModule, 'logPii');
});
