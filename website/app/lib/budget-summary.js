'use strict';

/**
 * Customer-facing budget summary for fix jobs.
 *
 * Companion to budget-tracker.js (enforcement) and fix-cap.js (tier
 * file-count caps). The tracker stops spend at the tier's USD/token cap;
 * THIS module turns the resulting run state into an honest, friendly
 * story for the customer: what the budget covered, what remains, and
 * what to do next.
 *
 * Tone contract (Inclusive Agentic QA spec, docs/ROADMAP.md): never
 * robotic, never punitive, never "contact support". Every message names
 * the real dollar budget and gives the customer a concrete next step.
 * Partial success must read as SUCCESS with a next step — not failure.
 *
 * Honesty contract: a re-run does NOT "resume where it left off" — it
 * re-clusters from the submitted findings (already-merged fixes fall out
 * naturally). Copy must say "run the fix again", never "resume".
 *
 * Pure JS. No I/O.
 */

const HIGH_SEVERITIES = Object.freeze(['critical', 'error', 'high']);

function isHighSeverity(sev) {
  return HIGH_SEVERITIES.includes(String(sev || '').toLowerCase());
}

function formatUsd(n) {
  const num = Number(n) || 0;
  // Whole-dollar caps read as "$30", real spend reads as "$12.35".
  return Number.isInteger(num) ? `$${num}` : `$${num.toFixed(2)}`;
}

function fileOf(entry) {
  if (!entry) return '';
  if (typeof entry === 'string') return entry;
  return entry.file || entry.filePath || entry.path || '';
}

/**
 * Build the structured budget summary attached to fix-route responses
 * and rendered into the PR body.
 *
 * @param {{
 *   snapshot?: {estimatedUsd:number, maxUsd:number, aborted:boolean, abortReason:string|null, callCount:number},
 *   fixes?: Array,               // successful fixes ({file|filePath}) — one per file
 *   failedFiles?: Array,         // per-file failures ({file|filePath, reason?})
 *   skippedForTimeBudget?: number,
 *   skippedForAiBudget?: number,
 *   invocationLimitHit?: boolean,
 *   capResult?: {toFix:Array, advisory:Array, cap:number, tier:string, advisoryIssueCount:number},
 * }} input
 * @returns {{
 *   spentUsd:number, capUsd:number, capReached:boolean,
 *   capKind:'ai-budget'|'time'|'invocations'|null,
 *   filesFixed:number, filesRemaining:number,
 *   advisoryFiles:number, advisoryFindings:number,
 *   severityCovered:{fixed:Object, remaining:Object},
 *   allHighSeverityCovered:boolean,
 *   retry:{kind:'free-rerun', message:string},
 * }}
 */
function buildBudgetSummary(input = {}) {
  const snapshot = input.snapshot || {};
  const fixes = Array.isArray(input.fixes) ? input.fixes : [];
  const failedFiles = Array.isArray(input.failedFiles) ? input.failedFiles : [];
  const skippedForTimeBudget = Number(input.skippedForTimeBudget) || 0;
  const skippedForAiBudget = Number(input.skippedForAiBudget) || 0;
  const capResult = input.capResult || {};

  const spentUsd = Number(snapshot.estimatedUsd) || 0;
  const capUsd = Number(snapshot.maxUsd) || 0;

  let capKind = null;
  if (input.invocationLimitHit) capKind = 'invocations';
  else if (skippedForAiBudget > 0 || snapshot.aborted) capKind = 'ai-budget';
  else if (skippedForTimeBudget > 0) capKind = 'time';

  const fixedFileSet = new Set(fixes.map(fileOf).filter(Boolean));

  // Severity split over the clusters the tier paid for (capResult.toFix):
  // a cluster counts as covered when its file made it into fixes[].
  const severityCovered = { fixed: {}, remaining: {} };
  let remainingHigh = 0;
  const toFix = Array.isArray(capResult.toFix) ? capResult.toFix : [];
  for (const cluster of toFix) {
    const sev = String(cluster.topSeverity || 'warning').toLowerCase();
    const bucket = fixedFileSet.has(fileOf(cluster)) ? 'fixed' : 'remaining';
    severityCovered[bucket][sev] = (severityCovered[bucket][sev] || 0) + 1;
    if (bucket === 'remaining' && isHighSeverity(sev)) remainingHigh += 1;
  }

  const filesFixed = fixedFileSet.size;
  // Remaining = paid-for clusters that didn't get a fix (budget/time/failed).
  const filesRemaining = Math.max(0, toFix.length - filesFixed);

  const summary = {
    spentUsd: Number(spentUsd.toFixed(2)),
    capUsd,
    byok: Boolean(snapshot.byok),
    capReached: capKind !== null,
    capKind,
    filesFixed,
    filesRemaining,
    advisoryFiles: Array.isArray(capResult.advisory) ? capResult.advisory.length : 0,
    advisoryFindings: Number(capResult.advisoryIssueCount) || 0,
    severityCovered,
    allHighSeverityCovered: remainingHigh === 0,
    failedFileCount: failedFiles.length,
    retry: { kind: 'free-rerun', message: '' },
  };
  summary.retry.message = budgetExhaustionMessage(summary);
  return summary;
}

/**
 * One friendly line describing where the run stopped and what to do
 * next. Used in the fix response `errors[]`, the 402 body, and as the
 * UI fallback string.
 *
 * @param {ReturnType<typeof buildBudgetSummary>} summary
 * @returns {string}
 */
function budgetExhaustionMessage(summary) {
  if (!summary) return '';
  // BYOK runs have no USD cap (Infinity) — the only budget stop is the token
  // runaway guard, so describe it that way instead of "$Infinity".
  const cap = summary.byok ? 'token-capped' : formatUsd(summary.capUsd);

  if (!summary.capReached) {
    return '';
  }

  if (summary.filesFixed === 0) {
    // Nothing shipped this run (the 402 path).
    return (
      `This run used its full ${cap} AI budget on deep analysis before any fixes were ready to ship — ` +
      `that work isn't wasted, but no PR was opened this time. Run the fix again from this page. ` +
      `If it happens twice in a row, email hello@gatetest.ai and a human will look at your repo personally.`
    );
  }

  const remaining = summary.filesRemaining;
  const noun = remaining === 1 ? 'file is' : 'files are';

  if (summary.capKind === 'time') {
    return (
      `We ran out of runway this round — ${remaining} ${noun} still queued. ` +
      `Run the fix again and they're next up.`
    );
  }

  const highNote = summary.allHighSeverityCovered
    ? ` — every critical and high-severity finding is in this PR. ${remaining} lower-severity ${noun} still waiting`
    : `. ${remaining} ${noun} still waiting, including some high-severity ones — run the fix again to keep going`;

  return (
    `Your ${cap} fix budget went to the ${summary.filesFixed} highest-impact files first` +
    `${highNote}. Run the fix again from this page to pick them up, or they'll be first in line on your next scan.`
  );
}

/**
 * PR-body markdown section. Rendered beside the advisory section
 * whenever the run stopped early (budget, time, or invocation limit).
 *
 * @param {ReturnType<typeof buildBudgetSummary>} summary
 * @returns {string}
 */
function renderBudgetSummaryMarkdown(summary) {
  if (!summary || !summary.capReached) return '';
  const lines = [];
  lines.push('## Where your fix budget went');
  lines.push('');
  lines.push(budgetExhaustionMessage(summary));
  lines.push('');
  lines.push(`| | |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Files fixed this run | ${summary.filesFixed} |`);
  lines.push(`| Files still waiting | ${summary.filesRemaining} |`);
  // BYOK runs have no USD ceiling (customer's own Anthropic key pays) — show
  // spend without a cap denominator instead of "of $Infinity".
  lines.push(summary.byok
    ? `| AI spend (BYOK — on your own Anthropic key, no GateTest USD cap) | ${formatUsd(summary.spentUsd)} |`
    : `| AI budget used | ${formatUsd(summary.spentUsd)} of ${formatUsd(summary.capUsd)} |`);
  if (summary.advisoryFiles > 0) {
    lines.push(`| Advisory files (beyond your tier's fix cap) | ${summary.advisoryFiles} (${summary.advisoryFindings} findings) |`);
  }
  return lines.join('\n');
}

module.exports = {
  buildBudgetSummary,
  budgetExhaustionMessage,
  renderBudgetSummaryMarkdown,
  // Exposed for tests.
  HIGH_SEVERITIES,
  formatUsd,
};
