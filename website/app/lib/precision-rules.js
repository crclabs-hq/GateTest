'use strict';
/**
 * Per-rule corpus aggregate (the Fifty, move 02) — pure data shaping for the
 * "By rule" table on /precision, kept out of RuleTable.tsx so the sort logic
 * is testable with plain `node --test` (no ts-node, no new dependency),
 * matching the head-to-head.js convention this file follows.
 *
 * The numbers themselves come from scripts/real-world-precision.js's
 * `rules[]` (website/app/data/precision.json) — this module only orders rows
 * the script already measured; it computes nothing new.
 *
 * @typedef {{ name: string, sha: string }} PrecisionRuleRepo
 * @typedef {{ rule: string, module: string|null, findings: number,
 *   onZeroCeilingRepos: number, controlPairs: number, repos: PrecisionRuleRepo[] }} PrecisionRule
 * @typedef {'findings'|'onZeroCeilingRepos'|'controlPairs'} RuleSortKey
 */

/**
 * Sort rows by one numeric column, descending by default (worst/most-findings
 * first — the shape a false-positive audit wants), with a stable tie-break on
 * rule name so re-sorting the same key twice is a no-op, not a shuffle.
 * @param {PrecisionRule[]} rules
 * @param {RuleSortKey} [key]
 * @param {'asc'|'desc'} [dir]
 * @returns {PrecisionRule[]}
 */
function sortRules(rules, key = 'findings', dir = 'desc') {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rules].sort((a, b) => (a[key] - b[key]) * sign || a.rule.localeCompare(b.rule));
}

module.exports = { sortRules };
