'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  instanceMultiplier,
  scoreToGrade,
  computeHealthScore,
  renderHealthScoreCard,
  deriveModuleCoverage,
  renderCoverageLine,
  explainScoreChange,
  HIGH_SIGNAL_WEIGHTS,
  STANDARD_WEIGHTS,
  INSTANCE_MULTIPLIER_CAP,
} = require('../website/app/lib/health-score.js');

test('instanceMultiplier — 1 instance returns 1.0', () => {
  assert.equal(instanceMultiplier(1), 1);
});

test('instanceMultiplier — grows sub-linearly', () => {
  const m10 = instanceMultiplier(10);
  const m100 = instanceMultiplier(100);
  assert.ok(m10 < m100);
  assert.ok(m10 < 2);
  assert.ok(m100 <= INSTANCE_MULTIPLIER_CAP);
});

test('instanceMultiplier — caps at INSTANCE_MULTIPLIER_CAP', () => {
  assert.ok(instanceMultiplier(10000) <= INSTANCE_MULTIPLIER_CAP);
  assert.ok(instanceMultiplier(1e9) <= INSTANCE_MULTIPLIER_CAP);
});

test('instanceMultiplier — non-numeric input defaults to 1', () => {
  assert.equal(instanceMultiplier(null), 1);
  assert.equal(instanceMultiplier(undefined), 1);
  assert.equal(instanceMultiplier('not-a-number'), 1);
});

test('scoreToGrade — A ≥ 90', () => {
  assert.equal(scoreToGrade(100), 'A');
  assert.equal(scoreToGrade(90), 'A');
});

test('scoreToGrade — B 75-89', () => {
  assert.equal(scoreToGrade(89), 'B');
  assert.equal(scoreToGrade(75), 'B');
});

test('scoreToGrade — C 60-74', () => {
  assert.equal(scoreToGrade(74), 'C');
  assert.equal(scoreToGrade(60), 'C');
});

test('scoreToGrade — D 40-59', () => {
  assert.equal(scoreToGrade(59), 'D');
  assert.equal(scoreToGrade(40), 'D');
});

test('scoreToGrade — F below 40', () => {
  assert.equal(scoreToGrade(39), 'F');
  assert.equal(scoreToGrade(0), 'F');
});

test('computeHealthScore — empty clusters → 100/A', () => {
  const r = computeHealthScore([]);
  assert.equal(r.score, 100);
  assert.equal(r.grade, 'A');
  assert.equal(r.deductions.length, 0);
});

test('computeHealthScore — single warning cluster deducts modestly', () => {
  const r = computeHealthScore([
    { severity: 'warning', isHighSignal: false, count: 1, ruleKey: 'r1' },
  ]);
  assert.equal(r.score, 100 - STANDARD_WEIGHTS.warning);
  assert.equal(r.grade, 'A'); // 98 is still A (≥ 90)
});

test('computeHealthScore — single high-signal error is severe', () => {
  const r = computeHealthScore([
    { severity: 'error', isHighSignal: true, count: 1, ruleKey: 'tls-security:expired-cert' },
  ]);
  assert.equal(r.score, 100 - HIGH_SIGNAL_WEIGHTS.error);
  assert.ok(r.score < 100);
});

test('computeHealthScore — score floors at 0 (cannot go negative)', () => {
  const clusters = [];
  for (let i = 0; i < 50; i++) {
    clusters.push({ severity: 'error', isHighSignal: true, count: 100, ruleKey: `r${i}` });
  }
  const r = computeHealthScore(clusters);
  assert.equal(r.score, 0);
  assert.equal(r.grade, 'F');
});

test('computeHealthScore — info-severity clusters are not deducted', () => {
  const r = computeHealthScore([
    { severity: 'info', isHighSignal: false, count: 5, ruleKey: 'r1' },
  ]);
  assert.equal(r.score, 100);
});

test('computeHealthScore — instance count matters but sub-linearly', () => {
  const oneInstance = computeHealthScore([
    { severity: 'warning', isHighSignal: false, count: 1, ruleKey: 'r1' },
  ]);
  const hundredInstances = computeHealthScore([
    { severity: 'warning', isHighSignal: false, count: 100, ruleKey: 'r1' },
  ]);
  assert.ok(hundredInstances.score < oneInstance.score);
  // But the gap is small — log scale
  assert.ok(oneInstance.score - hundredInstances.score < 10);
});

test('computeHealthScore — deduction records list each rule', () => {
  const r = computeHealthScore([
    { severity: 'error', isHighSignal: true, count: 1, ruleKey: 'r1' },
    { severity: 'warning', isHighSignal: false, count: 5, ruleKey: 'r2' },
  ]);
  assert.equal(r.deductions.length, 2);
  assert.equal(r.deductions[0].ruleKey, 'r1');
  assert.equal(r.deductions[0].highSignal, true);
});

test('computeHealthScore — non-array safe', () => {
  const r = computeHealthScore(null);
  assert.equal(r.score, 100);
  assert.equal(r.grade, 'A');
});

test('computeHealthScore — score is integer + always 0-100', () => {
  const r = computeHealthScore([
    { severity: 'warning', isHighSignal: false, count: 3, ruleKey: 'r' },
  ]);
  assert.equal(Number.isInteger(r.score), true);
  assert.ok(r.score >= 0 && r.score <= 100);
});

test('renderHealthScoreCard — empty result returns empty string', () => {
  assert.equal(renderHealthScoreCard(null), '');
  assert.equal(renderHealthScoreCard({}), '');
});

test('renderHealthScoreCard — includes score + grade + emoji', () => {
  const r = computeHealthScore([
    { severity: 'error', isHighSignal: true, count: 1, ruleKey: 'r' },
  ]);
  const md = renderHealthScoreCard(r);
  assert.ok(md.includes(`Health Score: ${r.score} / 100`));
  assert.ok(md.includes(`Grade ${r.grade}`));
});

test('renderHealthScoreCard — table includes deduction rows', () => {
  const r = computeHealthScore([
    { severity: 'error', isHighSignal: true, count: 1, ruleKey: 'tls-security:expired-cert' },
    { severity: 'warning', isHighSignal: false, count: 3, ruleKey: 'web-headers:missing-csp' },
  ]);
  const md = renderHealthScoreCard(r);
  assert.ok(md.includes('tls-security:expired-cert'));
  assert.ok(md.includes('web-headers:missing-csp'));
  assert.ok(md.includes('🔥')); // high-signal flag
});

test('renderHealthScoreCard — caps the table at 20 rows', () => {
  const clusters = [];
  for (let i = 0; i < 30; i++) {
    clusters.push({ severity: 'warning', isHighSignal: false, count: 1, ruleKey: `rule-${i}` });
  }
  const r = computeHealthScore(clusters);
  const md = renderHealthScoreCard(r);
  const matchedRows = (md.match(/^\| \d+ \|/gm) || []).length;
  assert.equal(matchedRows, 20);
  assert.ok(md.includes('10 more deductions'));
});

test('computeHealthScore — realistic scenario: 1 critical TLS + 2 missing headers', () => {
  const r = computeHealthScore([
    { severity: 'error', isHighSignal: true, count: 1, ruleKey: 'tls-security:expired-cert' },
    { severity: 'warning', isHighSignal: false, count: 10, ruleKey: 'web-headers:missing-csp' },
    { severity: 'warning', isHighSignal: false, count: 5, ruleKey: 'cookie-security:missing-secure' },
  ]);
  // Lose: ~12 (high-signal error) + ~3 (warning x 10 instances) + ~2.5 (warning x 5) ≈ 17-18 pts
  // Score should be in the B/C zone (75-89 / 60-74)
  assert.ok(r.score >= 70 && r.score <= 90, `expected 70-90, got ${r.score}`);
});

// Issue #643 — the Health Score must say when part of the suite never ran,
// and exclude those modules from what it claims to have measured.

test('deriveModuleCoverage — six not-checked modules out of a fourteen-module suite', () => {
  const results = [];
  const CHECKED = ['memory', 'performance', 'liveCrawler', 'runtimeErrors', 'explorer', 'visualRegression', 'interactiveElements', 'apiHealth'];
  const NOT_CHECKED = ['webHeaders', 'tlsSecurity', 'cookieSecurity', 'accessibility', 'seo', 'links'];
  for (const module of CHECKED) results.push({ module, checks: [{ name: `${module}:summary`, passed: true }] });
  for (const module of NOT_CHECKED) {
    results.push({ module, checks: [{ name: `${module}:not-checked`, passed: false, severity: 'info', notChecked: true, message: 'no project files or fetched page were provided' }] });
  }
  const coverage = deriveModuleCoverage(results);
  assert.equal(coverage.totalModules, 14);
  assert.equal(coverage.checkedModules, 8);
  assert.equal(coverage.notChecked.length, 6);
  assert.deepEqual(coverage.notChecked.map((n) => n.module).sort(), [...NOT_CHECKED].sort());

  const line = renderCoverageLine(coverage);
  assert.match(line, /^6 of 14 modules not checked: /);
  for (const module of NOT_CHECKED) assert.ok(line.includes(module));
});

test('deriveModuleCoverage — a repo scan with no not-checked modules returns an empty list, no coverage line', () => {
  const results = [
    { module: 'webHeaders', checks: [{ name: 'web-headers:no-files', passed: true }] },
    { module: 'seo', checks: [{ name: 'seo:files', passed: true }] },
  ];
  const coverage = deriveModuleCoverage(results);
  assert.equal(coverage.notChecked.length, 0);
  assert.equal(coverage.checkedModules, 2);
  assert.equal(renderCoverageLine(coverage), null);
});

test('computeHealthScore — with moduleCoverage: excludes not-checked modules from what it claims to measure, and says so in the summary', () => {
  const coverage = deriveModuleCoverage([
    { module: 'seo', checks: [{ name: 'seo:summary', passed: true }] },
    { module: 'webHeaders', checks: [{ name: 'webHeaders:not-checked', passed: false, severity: 'info', notChecked: true, message: 'no live page' }] },
  ]);
  const r = computeHealthScore([{ severity: 'warning', isHighSignal: false, count: 1, ruleKey: 'seo:missing-title' }], coverage);
  assert.equal(r.coverage.totalModules, 2);
  assert.equal(r.coverage.checkedModules, 1);
  assert.deepEqual(r.coverage.notCheckedModules, ['webHeaders']);
  assert.match(r.summary, /1 of 2 modules/);
  assert.match(r.summary, /webHeaders/);
});

test('computeHealthScore — without moduleCoverage (existing callers): no coverage field, summary unchanged', () => {
  const r = computeHealthScore([{ severity: 'warning', isHighSignal: false, count: 1, ruleKey: 'x' }]);
  assert.equal(r.coverage, undefined);
  assert.ok(!/not checked/i.test(r.summary));
});

// Issue #658 item 2 — a score drift between two scans of an unchanged URL
// can be legitimate (a: new checks shipped; d: more modules excluded) as
// well as a bug (b/c) — explainScoreChange only speaks to the legitimate
// causes, deterministically, from the two coverage snapshots alone.

test('explainScoreChange — no prior snapshot: nothing to explain', () => {
  assert.equal(explainScoreChange(null, { totalModules: 20, checkedModules: 18, notCheckedModules: [] }), null);
  assert.equal(explainScoreChange(undefined, { totalModules: 20, checkedModules: 18, notCheckedModules: [] }), null);
});

test('explainScoreChange — identical coverage: nothing to explain', () => {
  const snap = { totalModules: 20, checkedModules: 18, notCheckedModules: ['tlsSecurity', 'links'] };
  assert.equal(explainScoreChange(snap, { ...snap }), null);
});

test('explainScoreChange — more modules ran real checks since last time (cause a)', () => {
  const previous = { totalModules: 20, checkedModules: 14, notCheckedModules: [] };
  const current = { totalModules: 20, checkedModules: 18, notCheckedModules: [] };
  const line = explainScoreChange(previous, current);
  assert.match(line, /4 checks were added/);
  assert.match(line, /14 → 18/);
  assert.match(line, /20 modules/);
});

test('explainScoreChange — singular phrasing for exactly one added check', () => {
  const line = explainScoreChange(
    { totalModules: 20, checkedModules: 17, notCheckedModules: [] },
    { totalModules: 20, checkedModules: 18, notCheckedModules: [] }
  );
  assert.match(line, /^1 check was added/);
});

test('explainScoreChange — more modules excluded as not-checked since last time (cause d)', () => {
  const previous = { totalModules: 20, checkedModules: 18, notCheckedModules: ['tlsSecurity', 'links'] };
  const current = { totalModules: 20, checkedModules: 15, notCheckedModules: ['tlsSecurity', 'links', 'crossBrowser', 'memory', 'apiHealth'] };
  const line = explainScoreChange(previous, current);
  assert.match(line, /5 of 20 modules were excluded as not-checked this scan \(previously 2\)/);
});

test('explainScoreChange — cause (d) takes priority when both shift in the same scan', () => {
  // checkedModules dropped AND notChecked grew in the same scan — the
  // "you're now seeing less of your site" message must win, not the
  // (never-true-here) "more checks ran" message.
  const previous = { totalModules: 20, checkedModules: 18, notCheckedModules: ['tlsSecurity', 'links'] };
  const current = { totalModules: 20, checkedModules: 15, notCheckedModules: ['tlsSecurity', 'links', 'crossBrowser', 'memory', 'apiHealth'] };
  const line = explainScoreChange(previous, current);
  assert.match(line, /excluded as not-checked/);
  assert.ok(!/checks were added/.test(line));
});

test('explainScoreChange — fewer modules excluded (coverage improved): nothing alarming to say', () => {
  const previous = { totalModules: 20, checkedModules: 15, notCheckedModules: ['a', 'b', 'c', 'd', 'e'] };
  const current = { totalModules: 20, checkedModules: 18, notCheckedModules: ['a', 'b'] };
  // checkedModules grew AND notChecked shrank — this IS the "more checks
  // ran" case (cause a), just phrased from module coverage, not a silent null.
  const line = explainScoreChange(previous, current);
  assert.match(line, /3 checks were added/);
});
