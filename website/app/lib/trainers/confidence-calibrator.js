/**
 * Confidence-calibrator trainer (Wave 6).
 *
 * Reads the finding_dismissals corpus (customer suppressions) and
 * recommends per-rule severity downgrades when a rule is consistently
 * being treated as noise.
 *
 * Inputs (read-only): finding_dismissals table via statsByRule().
 *   For each rule, we have:
 *     - totalDismissals       cumulative dismissal count
 *     - uniqueScans           how many different scans dismissed it
 *     - uniqueIps             how many different customers
 *     - reasonBreakdown       per-reason counts
 *
 * Heuristic:
 *   - If uniqueIps >= 3 AND >50% of dismissals are "false-positive"
 *     → recommend severity downgrade (warning, or info if already warning).
 *   - If uniqueIps >= 5 AND >70% are "intended" / "wont-fix" / "test-only"
 *     → recommend the rule add a suppression marker (e.g. `// rule-ok`).
 *   - If uniqueIps >= 10 with broad dismissal across reasons
 *     → recommend reviewer-attention: rule is producing too much output.
 *
 * Trainer is read-only on source code (Bible "never patch symptoms").
 * Output is a structured proposal; a human or downstream agent transcribes
 * the recommendation into a real severity change.
 *
 * Storage requirements: this trainer requires DATABASE_URL to be set
 * (read of finding_dismissals). When unset, emits an empty report
 * gracefully — never throws.
 *
 * Output:
 *   ~/.gatetest/trainers/confidence-calibrator-latest.json
 *
 * Stdout: human-readable markdown summary.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MIN_UNIQUE_IPS_FOR_FP_DOWNGRADE = 3;
const FP_THRESHOLD = 0.5;
const MIN_UNIQUE_IPS_FOR_SUPPRESS_MARKER = 5;
const SUPPRESS_THRESHOLD = 0.7;
const MIN_UNIQUE_IPS_FOR_BROAD_REVIEW = 10;
const MAX_RECOMMENDATIONS = 50;

let _warnedOnce = false;
function warnOnce(msg) {
  if (_warnedOnce) return;
  _warnedOnce = true;
  // eslint-disable-next-line no-console
  console.warn(`[confidence-calibrator] ${msg}`);
}

// ---------------------------------------------------------------------------
// Stats helpers — pure, exported for tests
// ---------------------------------------------------------------------------

function ratioOf(reasonBreakdown, reasons) {
  const total = Object.values(reasonBreakdown).reduce((s, n) => s + n, 0);
  if (total === 0) return 0;
  const matched = reasons.reduce((s, r) => s + (reasonBreakdown[r] || 0), 0);
  return matched / total;
}

function classifyRule(stat) {
  if (!stat || typeof stat !== 'object') return null;
  const ips = stat.uniqueIps || 0;
  const breakdown = stat.reasonBreakdown || {};
  const fpRatio = ratioOf(breakdown, ['false-positive']);
  const suppressibleRatio = ratioOf(breakdown, ['intended', 'wont-fix', 'test-only', 'deprecated']);

  // Highest-severity recommendation wins — check broadest signal first.
  if (ips >= MIN_UNIQUE_IPS_FOR_BROAD_REVIEW) {
    return {
      kind: 'reviewer-attention',
      reason: `${stat.totalDismissals} dismissals from ${ips} distinct customers — rule is being widely suppressed, requires review`,
      fpRatio: Number(fpRatio.toFixed(2)),
      suppressibleRatio: Number(suppressibleRatio.toFixed(2)),
    };
  }
  if (ips >= MIN_UNIQUE_IPS_FOR_SUPPRESS_MARKER && suppressibleRatio > SUPPRESS_THRESHOLD) {
    return {
      kind: 'add-suppression-marker',
      reason: `${(suppressibleRatio * 100).toFixed(0)}% of dismissals are intended / wont-fix / test-only / deprecated across ${ips} customers — add a documented suppression marker (e.g. \`// rule-ok\`)`,
      suppressibleRatio: Number(suppressibleRatio.toFixed(2)),
    };
  }
  if (ips >= MIN_UNIQUE_IPS_FOR_FP_DOWNGRADE && fpRatio > FP_THRESHOLD) {
    return {
      kind: 'downgrade-severity',
      reason: `${(fpRatio * 100).toFixed(0)}% of dismissals flagged as false-positive across ${ips} customers — consider downgrading severity`,
      fpRatio: Number(fpRatio.toFixed(2)),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the calibrator.
 *
 * @param {object} [opts]
 * @param {number} [opts.sinceDays=90]
 * @param {function} [opts.statsByRule]  override the read-side (for tests)
 * @returns {Promise<object>}
 */
async function calibrate(opts = {}) {
  const sinceDays = opts.sinceDays || 90;
  let statsByRule;
  try {
    if (typeof opts.statsByRule === 'function') {
      statsByRule = opts.statsByRule;
    } else {
      // Dynamic import — the TS module compiles to .js under .next/.
      // For Node-test direct execution (no compile step) we fall back
      // to require the .ts via a thin require; tests inject opts.statsByRule
      // to avoid the .ts import entirely.
      // eslint-disable-next-line global-require
      statsByRule = require('../finding-feedback-store').statsByRule;
    }
  } catch {
    statsByRule = null;
  }

  let stats = [];
  if (statsByRule) {
    try {
      stats = await statsByRule(sinceDays);
    } catch (err) {
      warnOnce(`statsByRule failed: ${err && err.message}`);
      stats = [];
    }
  }

  const recommendations = [];
  for (const stat of stats) {
    const recom = classifyRule(stat);
    if (recom) {
      recommendations.push({
        rule: stat.rule,
        ...recom,
        totalDismissals: stat.totalDismissals,
        uniqueScans: stat.uniqueScans,
        uniqueIps: stat.uniqueIps,
        reasonBreakdown: stat.reasonBreakdown,
        firstSeenAt: stat.firstSeenAt ? stat.firstSeenAt.toISOString() : null,
        lastSeenAt: stat.lastSeenAt ? stat.lastSeenAt.toISOString() : null,
      });
      if (recommendations.length >= MAX_RECOMMENDATIONS) break;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    sinceDays,
    rulesAnalysed: stats.length,
    recommendations,
    byKind: {
      'reviewer-attention':       recommendations.filter((r) => r.kind === 'reviewer-attention').length,
      'add-suppression-marker':   recommendations.filter((r) => r.kind === 'add-suppression-marker').length,
      'downgrade-severity':       recommendations.filter((r) => r.kind === 'downgrade-severity').length,
    },
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Confidence Calibrator — Nightly Recommendations');
  lines.push('');
  lines.push(`_Generated ${report.generatedAt} — looking back ${report.sinceDays} days_`);
  lines.push('');
  lines.push(`Rules analysed: **${report.rulesAnalysed}**. Recommendations: **${report.recommendations.length}** (reviewer-attention: ${report.byKind['reviewer-attention']}, suppression-marker: ${report.byKind['add-suppression-marker']}, downgrade: ${report.byKind['downgrade-severity']}).`);
  lines.push('');

  if (report.recommendations.length === 0) {
    lines.push('_No actionable suppression patterns yet. Either the corpus is empty (set DATABASE_URL) or no rule has accumulated enough customer feedback to recommend a change._');
    return lines.join('\n');
  }

  lines.push('| Rule | Recommendation | Dismissals | Unique IPs | Reason |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const r of report.recommendations) {
    lines.push(`| \`${r.rule}\` | ${r.kind} | ${r.totalDismissals} | ${r.uniqueIps} | ${r.reason.slice(0, 120).replace(/\|/g, '\\|')} |`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

async function main() {
  const report = await calibrate();
  // eslint-disable-next-line no-console
  console.log(renderMarkdown(report)); // code-quality-ok — CLI trainer prints markdown report to stdout
  const outDir = path.join(os.homedir(), '.gatetest', 'trainers');
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'confidence-calibrator-latest.json'), JSON.stringify(report, null, 2));
  } catch { /* best-effort */ }
}

if (require.main === module) {
  main().catch((err) => {
    warnOnce(`fatal: ${err && err.message}`);
    process.exit(0);
  });
}

module.exports = {
  calibrate,
  renderMarkdown,
  // exposed for tests
  _classifyRule: classifyRule,
  _ratioOf: ratioOf,
  MIN_UNIQUE_IPS_FOR_FP_DOWNGRADE,
  FP_THRESHOLD,
  MIN_UNIQUE_IPS_FOR_SUPPRESS_MARKER,
  SUPPRESS_THRESHOLD,
  MIN_UNIQUE_IPS_FOR_BROAD_REVIEW,
};
