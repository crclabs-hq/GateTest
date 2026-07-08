'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildBudgetSummary,
  budgetExhaustionMessage,
  renderBudgetSummaryMarkdown,
  formatUsd,
} = require('../website/app/lib/budget-summary.js');

function cluster(file, topSeverity = 'error', count = 2) {
  return { file, count, topSeverity, modules: ['m1'], issues: [] };
}

function snapshot(overrides = {}) {
  return {
    estimatedUsd: 29.87,
    maxUsd: 30,
    aborted: true,
    abortReason: 'usd cap exceeded ($30.01/$30)',
    callCount: 42,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Builder math
// ---------------------------------------------------------------------------

test('partial run: filesFixed/filesRemaining derive from capResult.toFix vs fixes', () => {
  const s = buildBudgetSummary({
    snapshot: snapshot(),
    fixes: [{ file: 'a.js' }, { file: 'b.js' }],
    skippedForAiBudget: 2,
    capResult: {
      toFix: [cluster('a.js'), cluster('b.js'), cluster('c.js', 'warning'), cluster('d.js', 'warning')],
      advisory: [cluster('e.js', 'info', 5)],
      cap: 50,
      tier: 'scan_fix',
      advisoryIssueCount: 5,
    },
  });
  assert.equal(s.filesFixed, 2);
  assert.equal(s.filesRemaining, 2);
  assert.equal(s.capReached, true);
  assert.equal(s.capKind, 'ai-budget');
  assert.equal(s.advisoryFiles, 1);
  assert.equal(s.advisoryFindings, 5);
  assert.equal(s.spentUsd, 29.87);
  assert.equal(s.capUsd, 30);
});

test('severity split: remaining high-severity flips allHighSeverityCovered', () => {
  const covered = buildBudgetSummary({
    snapshot: snapshot(),
    fixes: [{ file: 'high.js' }],
    skippedForAiBudget: 1,
    capResult: { toFix: [cluster('high.js', 'error'), cluster('low.js', 'warning')], advisory: [], cap: 50, tier: 'scan_fix', advisoryIssueCount: 0 },
  });
  assert.equal(covered.allHighSeverityCovered, true);

  const notCovered = buildBudgetSummary({
    snapshot: snapshot(),
    fixes: [{ file: 'low.js' }],
    skippedForAiBudget: 1,
    capResult: { toFix: [cluster('high.js', 'critical'), cluster('low.js', 'warning')], advisory: [], cap: 50, tier: 'scan_fix', advisoryIssueCount: 0 },
  });
  assert.equal(notCovered.allHighSeverityCovered, false);
});

test('capKind resolution: invocations > ai-budget > time > null', () => {
  const base = {
    fixes: [],
    capResult: { toFix: [], advisory: [], cap: 50, tier: 'scan_fix', advisoryIssueCount: 0 },
  };
  assert.equal(
    buildBudgetSummary({ ...base, snapshot: snapshot(), invocationLimitHit: true }).capKind,
    'invocations'
  );
  assert.equal(
    buildBudgetSummary({ ...base, snapshot: snapshot({ aborted: true }) }).capKind,
    'ai-budget'
  );
  assert.equal(
    buildBudgetSummary({ ...base, snapshot: snapshot({ aborted: false, abortReason: null }), skippedForTimeBudget: 3 }).capKind,
    'time'
  );
  const clean = buildBudgetSummary({ ...base, snapshot: snapshot({ aborted: false, abortReason: null }) });
  assert.equal(clean.capKind, null);
  assert.equal(clean.capReached, false);
});

test('accepts file/filePath/path/string entries in fixes[]', () => {
  const s = buildBudgetSummary({
    snapshot: snapshot(),
    fixes: [{ filePath: 'a.js' }, { path: 'b.js' }, 'c.js'],
    skippedForAiBudget: 1,
    capResult: { toFix: [cluster('a.js'), cluster('b.js'), cluster('c.js'), cluster('d.js')], advisory: [], cap: 50, tier: 'scan_fix', advisoryIssueCount: 0 },
  });
  assert.equal(s.filesFixed, 3);
  assert.equal(s.filesRemaining, 1);
});

// ---------------------------------------------------------------------------
// Copy invariants — these lock the Inclusive tone in
// ---------------------------------------------------------------------------

test('copy: always names a dollar amount, never says "contact support"', () => {
  const partial = buildBudgetSummary({
    snapshot: snapshot(),
    fixes: [{ file: 'a.js' }],
    skippedForAiBudget: 1,
    capResult: { toFix: [cluster('a.js'), cluster('b.js', 'warning')], advisory: [], cap: 50, tier: 'scan_fix', advisoryIssueCount: 0 },
  });
  const nothing = buildBudgetSummary({
    snapshot: snapshot(),
    fixes: [],
    skippedForAiBudget: 2,
    capResult: { toFix: [cluster('a.js'), cluster('b.js')], advisory: [], cap: 50, tier: 'scan_fix', advisoryIssueCount: 0 },
  });
  for (const s of [partial, nothing]) {
    const msg = budgetExhaustionMessage(s);
    assert.match(msg, /\$\d/, 'message must name the real dollar budget');
    assert.doesNotMatch(msg, /contact support/i);
  }
});

test('copy: "every critical and high-severity" claim only renders when true', () => {
  const allCovered = buildBudgetSummary({
    snapshot: snapshot(),
    fixes: [{ file: 'high.js' }],
    skippedForAiBudget: 1,
    capResult: { toFix: [cluster('high.js', 'error'), cluster('low.js', 'warning')], advisory: [], cap: 50, tier: 'scan_fix', advisoryIssueCount: 0 },
  });
  assert.match(budgetExhaustionMessage(allCovered), /every critical and high-severity/);

  const notCovered = buildBudgetSummary({
    snapshot: snapshot(),
    fixes: [{ file: 'low.js' }],
    skippedForAiBudget: 1,
    capResult: { toFix: [cluster('high.js', 'critical'), cluster('low.js', 'warning')], advisory: [], cap: 50, tier: 'scan_fix', advisoryIssueCount: 0 },
  });
  assert.doesNotMatch(budgetExhaustionMessage(notCovered), /every critical and high-severity/);
});

test('copy: never claims "resume" — re-runs re-cluster, they do not resume', () => {
  const variants = [
    buildBudgetSummary({ snapshot: snapshot(), fixes: [{ file: 'a.js' }], skippedForAiBudget: 1, capResult: { toFix: [cluster('a.js'), cluster('b.js')], advisory: [], cap: 50, tier: 'scan_fix', advisoryIssueCount: 0 } }),
    buildBudgetSummary({ snapshot: snapshot(), fixes: [], skippedForAiBudget: 1, capResult: { toFix: [cluster('a.js')], advisory: [], cap: 50, tier: 'scan_fix', advisoryIssueCount: 0 } }),
    buildBudgetSummary({ snapshot: snapshot({ aborted: false, abortReason: null }), fixes: [{ file: 'a.js' }], skippedForTimeBudget: 2, capResult: { toFix: [cluster('a.js'), cluster('b.js'), cluster('c.js')], advisory: [], cap: 50, tier: 'scan_fix', advisoryIssueCount: 0 } }),
  ];
  for (const s of variants) {
    assert.doesNotMatch(budgetExhaustionMessage(s), /resume/i);
  }
});

test('time-budget copy is distinct and friendly', () => {
  const s = buildBudgetSummary({
    snapshot: snapshot({ aborted: false, abortReason: null }),
    fixes: [{ file: 'a.js' }],
    skippedForTimeBudget: 4,
    capResult: { toFix: [cluster('a.js'), cluster('b.js'), cluster('c.js')], advisory: [], cap: 50, tier: 'scan_fix', advisoryIssueCount: 0 },
  });
  assert.equal(s.capKind, 'time');
  assert.match(budgetExhaustionMessage(s), /ran out of runway/);
  assert.match(budgetExhaustionMessage(s), /Run the fix again/);
});

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

test('markdown: renders only when cap reached, includes the table rows', () => {
  const s = buildBudgetSummary({
    snapshot: snapshot(),
    fixes: [{ file: 'a.js' }],
    skippedForAiBudget: 1,
    capResult: { toFix: [cluster('a.js'), cluster('b.js', 'warning')], advisory: [cluster('c.js', 'info', 7)], cap: 50, tier: 'scan_fix', advisoryIssueCount: 7 },
  });
  const md = renderBudgetSummaryMarkdown(s);
  assert.match(md, /## Where your fix budget went/);
  assert.match(md, /Files fixed this run \| 1/);
  assert.match(md, /Files still waiting \| 1/);
  assert.match(md, /\$29\.87 of \$30/);
  assert.match(md, /Advisory files .* 1 \(7 findings\)/);

  const clean = buildBudgetSummary({
    snapshot: snapshot({ aborted: false, abortReason: null }),
    fixes: [{ file: 'a.js' }],
    capResult: { toFix: [cluster('a.js')], advisory: [], cap: 50, tier: 'scan_fix', advisoryIssueCount: 0 },
  });
  assert.equal(renderBudgetSummaryMarkdown(clean), '');
});

test('formatUsd: whole dollars stay whole, cents render to 2dp', () => {
  assert.equal(formatUsd(30), '$30');
  assert.equal(formatUsd(29.874), '$29.87');
  assert.equal(formatUsd(0), '$0');
});
