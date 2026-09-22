'use strict';

/**
 * Health-score aggregator.
 *
 * Converts a clustered finding set into a single 0-100 verdict plus a
 * letter grade. Customers asked for a number, not a list.
 *
 * Scoring philosophy (calibrated against real customer scans):
 *   - Start at 100.
 *   - High-signal clusters cost MORE than regular clusters of the same
 *     severity (an open XML-RPC pingback is worse than 1 missing header,
 *     even though both register as "error").
 *   - Instance count contributes sub-linearly. Twenty pages each missing
 *     a header is still one "fix missing header" customer action — don't
 *     deduct 20× the points or every site of any size would score 0.
 *   - Deductions per cluster cap, so one bad rule can't wipe the score
 *     entirely.
 *   - The floor is 0; the ceiling is 100; never report negative numbers
 *     or numbers above 100.
 *
 * Pure JS. Deterministic. The weights are constants here so analytics
 * can reproduce the score from a saved cluster list.
 */

const HIGH_SIGNAL_WEIGHTS = Object.freeze({ error: 12, warning: 5, info: 0 });
const STANDARD_WEIGHTS = Object.freeze({ error: 6, warning: 2, info: 0 });

// Cap per-cluster deduction so a "200 pages have the same header issue"
// cluster doesn't dominate. The log scale rewards diversity-of-fix.
const INSTANCE_MULTIPLIER_CAP = 1.8;

function instanceMultiplier(count) {
  const n = typeof count === 'number' && Number.isFinite(count) ? Math.max(1, count) : 1;
  // 1 instance = 1.0, 10 instances = ~1.5, 100 instances = ~1.8
  const mult = 1 + Math.log10(n) * 0.4;
  return Math.min(INSTANCE_MULTIPLIER_CAP, mult);
}

/**
 * @param {Array<{severity:string, isHighSignal:boolean, count:number}>} clusters
 * @returns {{
 *   score: number,
 *   grade: 'A'|'B'|'C'|'D'|'F',
 *   deductions: Array<{ruleKey?:string, severity:string, deduction:number, instances:number, highSignal:boolean}>,
 *   summary: string,
 *   coverage?: {totalModules:number, checkedModules:number, notCheckedModules:string[]},
 * }}
 * @param {{totalModules:number, checkedModules:number, notChecked:Array<{module:string, reason:string}>}} [moduleCoverage]
 *   From `deriveModuleCoverage()` below. Optional — omit for a caller (repo
 *   scans, existing callers) that has no notion of per-module coverage.
 */
function computeHealthScore(clusters, moduleCoverage) {
  const safe = Array.isArray(clusters) ? clusters : [];
  const deductions = [];
  let score = 100;

  for (const c of safe) {
    if (!c || typeof c !== 'object') continue;
    const severity = c.severity || 'warning';
    const base = (c.isHighSignal ? HIGH_SIGNAL_WEIGHTS : STANDARD_WEIGHTS)[severity] || 0;
    if (base === 0) continue;
    const mult = instanceMultiplier(c.count || 1);
    const ded = Math.round(base * mult * 10) / 10; // 1 decimal place
    score -= ded;
    deductions.push({
      ruleKey: c.ruleKey || c.title || '(unknown)',
      severity,
      deduction: ded,
      instances: c.count || 1,
      highSignal: Boolean(c.isHighSignal),
    });
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade = scoreToGrade(score);
  const summary = renderSummary(score, grade, deductions, safe.length, moduleCoverage);
  const result = { score, grade, deductions, summary };
  if (moduleCoverage && Array.isArray(moduleCoverage.notChecked) && moduleCoverage.notChecked.length > 0) {
    // Never invent a percentage over modules that never ran — this is the
    // real denominator (Doctrine #7: generated, not typed) the caller
    // measured from the modules that actually reported this scan.
    result.coverage = {
      totalModules: moduleCoverage.totalModules,
      checkedModules: moduleCoverage.checkedModules,
      notCheckedModules: moduleCoverage.notChecked.map((n) => n.module),
    };
  }
  return result;
}

/**
 * Which modules in a scan's raw per-module results reported themselves
 * `notChecked` (BaseModule#_notChecked — "I never looked", distinct from
 * "I looked and found nothing"). One definition (Doctrine §4) consumed by
 * every surface that needs to say "N of M modules not checked": the
 * result card, the JSON summary, the markdown export.
 *
 * @param {Array<{module?:string, name?:string, checks?:Array<{notChecked?:boolean, message?:string}>}>} results
 *   `summary.results` from a suite run (each entry is a per-module
 *   TestResult#toJSON()-shaped object, or close enough — only `module`/
 *   `name` and `checks` are read).
 * @returns {{totalModules:number, checkedModules:number, notChecked:Array<{module:string, reason:string}>}}
 */
function deriveModuleCoverage(results) {
  const safe = Array.isArray(results) ? results : [];
  const notChecked = [];
  for (const r of safe) {
    if (!r || !Array.isArray(r.checks)) continue;
    const nc = r.checks.find((c) => c && c.notChecked === true);
    if (nc) {
      notChecked.push({
        module: r.module || r.name || '(unknown)',
        reason: nc.message || 'not checked',
      });
    }
  }
  return {
    totalModules: safe.length,
    checkedModules: Math.max(0, safe.length - notChecked.length),
    notChecked,
  };
}

/** One line, reusable verbatim on the result card, the JSON, and the
 *  markdown export: `null` when nothing was skipped (nothing to say). */
function renderCoverageLine(moduleCoverage) {
  if (!moduleCoverage || !Array.isArray(moduleCoverage.notChecked) || moduleCoverage.notChecked.length === 0) {
    return null;
  }
  const names = moduleCoverage.notChecked.map((n) => n.module).join(', ');
  return `${moduleCoverage.notChecked.length} of ${moduleCoverage.totalModules} modules not checked: ${names}`;
}

/** @param {number} score */
function scoreToGrade(score) {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

function renderSummary(score, grade, deductions, clusterCount, moduleCoverage) {
  const coverageLine = renderCoverageLine(moduleCoverage);
  // "Computed over N of M modules" — the score above is real, but only
  // over what actually ran; say so in the same sentence it's read in,
  // never in a separate place someone can miss (Doctrine #6).
  const coverageSuffix = coverageLine
    ? ` Score computed over ${moduleCoverage.checkedModules} of ${moduleCoverage.totalModules} modules — ${coverageLine}.`
    : '';
  if (clusterCount === 0) {
    return `Health Score: ${score}/100 (${grade}) — no findings to deduct from.${coverageSuffix}`;
  }
  const errorCount = deductions.filter((d) => d.severity === 'error').length;
  const warningCount = deductions.filter((d) => d.severity === 'warning').length;
  const highSignalCount = deductions.filter((d) => d.highSignal).length;
  const parts = [`Health Score: ${score}/100 (${grade}).`];
  parts.push(`${clusterCount} root-cause cluster${clusterCount === 1 ? '' : 's'}.`);
  if (errorCount > 0) parts.push(`${errorCount} error-severity.`);
  if (warningCount > 0) parts.push(`${warningCount} warning-severity.`);
  if (highSignalCount > 0) parts.push(`${highSignalCount} high-signal (urgent).`);
  if (coverageSuffix) parts.push(coverageSuffix.trim());
  return parts.join(' ');
}

/**
 * Compact markdown block — drop in straight under the health-score
 * number in the PR / report.
 */
function renderHealthScoreCard(result) {
  if (!result || typeof result.score !== 'number') return '';
  const sevEmoji = result.score >= 90 ? '✅' : result.score >= 75 ? '🟢' : result.score >= 60 ? '🟡' : result.score >= 40 ? '🟠' : '🔴';
  const lines = [];
  lines.push(`## ${sevEmoji} Health Score: ${result.score} / 100 — Grade ${result.grade}`);
  lines.push('');
  lines.push(result.summary);
  if (Array.isArray(result.deductions) && result.deductions.length > 0) {
    lines.push('');
    lines.push('| # | Rule | Severity | Instances | Points lost |');
    lines.push('| --- | --- | --- | --- | --- |');
    const sorted = [...result.deductions].sort((a, b) => b.deduction - a.deduction).slice(0, 20);
    sorted.forEach((d, i) => {
      const flag = d.highSignal ? '🔥' : '';
      lines.push(`| ${i + 1} | ${flag} \`${d.ruleKey}\` | ${d.severity} | ${d.instances} | -${d.deduction} |`);
    });
    if (result.deductions.length > 20) {
      lines.push('');
      lines.push(`_+ ${result.deductions.length - 20} more deductions not shown._`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  HIGH_SIGNAL_WEIGHTS,
  STANDARD_WEIGHTS,
  INSTANCE_MULTIPLIER_CAP,
  instanceMultiplier,
  scoreToGrade,
  computeHealthScore,
  renderHealthScoreCard,
  deriveModuleCoverage,
  renderCoverageLine,
};
