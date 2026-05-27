/**
 * Recipe-promoter trainer (Wave 2).
 *
 * Consumes the pattern-miner's `recurringSubjects` output and produces
 * RECIPE PROPOSALS — structured records that name a candidate
 * deterministic fix. Each proposal is what a human or downstream agent
 * needs to write a new entry in rule-based-fixer.js' TRANSFORMS list (or
 * ast-fixer.js if it's a syntax-level concern).
 *
 * The promoter is INTENTIONALLY read-only on rule-based-fixer.js. It
 * outputs PROPOSALS, not edits. A reviewer (or a Claude-Code session)
 * then transcribes the proposal into a real rule with proper matches()
 * and apply() functions. The trainer's job is to surface the patterns —
 * the human (or next-stage agent) writes the actual recipe.
 *
 * Why propose, not auto-apply:
 *   - A recurring-subject signal is necessary but not sufficient. The
 *     human still needs to verify the diffs across the matching commits
 *     are mechanically uniform (i.e. a regex really CAN handle them).
 *   - Bible rule "Never patch symptoms" — an auto-recipe based on a
 *     subject pattern alone is exactly the kind of shallow symptom-fix
 *     the Bible bans.
 *   - The proposal carries the 5 sample commit SHAs so the reviewer can
 *     `git show <sha>` to confirm the diff shape before promoting.
 *
 * Output: ~/.gatetest/trainers/recipe-promoter-latest.json
 *
 * RESILIENCE: never throws. Empty inputs → empty proposals.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PatternMiner = require('./pattern-miner.js');

const MIN_HITS_FOR_PROPOSAL = 3;
const MAX_PROPOSALS = 20;
const MAX_DIFF_SIZE = 50_000;
const SAMPLE_DIFFS_PER_PROPOSAL = 3;

let _warnedOnce = false;
function warnOnce(msg) {
  if (_warnedOnce) return;
  _warnedOnce = true;
  // eslint-disable-next-line no-console
  console.warn(`[recipe-promoter] ${msg}`);
}

// ---------------------------------------------------------------------------
// Diff shape characterisation
// ---------------------------------------------------------------------------

/**
 * For a given commit SHA, return a coarse summary of the diff shape:
 *   - hunks: number of @@ headers
 *   - added: total added lines
 *   - removed: total removed lines
 *   - files: list of paths
 *
 * "Mechanically uniform" candidates have a low hunks-per-file count and
 * roughly balanced added/removed — i.e. small targeted swaps, not big
 * rewrites. The promoter uses this to score the recipe-candidate
 * plausibility.
 */
function characteriseCommit(repoRoot, sha) {
  try {
    const out = execFileSync('git', ['-C', repoRoot, 'show', '--stat', '--format=', sha], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    // The last line of --stat is "N files changed, X insertions(+), Y deletions(-)"
    const lines = out.trim().split('\n');
    const summaryLine = lines[lines.length - 1] || '';
    const files = lines.slice(0, -1)
      .map((l) => (l.split('|')[0] || '').trim())
      .filter(Boolean);
    const m = /(\d+)\s+insertions?\(\+\)/.exec(summaryLine);
    const n = /(\d+)\s+deletions?\(-\)/.exec(summaryLine);
    const added = m ? parseInt(m[1], 10) : 0;
    const removed = n ? parseInt(n[1], 10) : 0;
    return { files, added, removed, fileCount: files.length };
  } catch {
    return { files: [], added: 0, removed: 0, fileCount: 0 };
  }
}

/**
 * Plausibility score 0..1 for "this group of commits looks recipe-able."
 *
 *   - mechanicalUniformity: low variance in added/removed → high score
 *   - sizeContainment:       average added <= 20 → high score
 *   - fileFocus:             each commit touches < 3 files → high score
 *
 * Bias high — score < 0.4 means "skip, human will hate this proposal."
 */
function plausibilityScore(diffs) {
  if (diffs.length === 0) return 0;
  const adds = diffs.map((d) => d.added);
  const dels = diffs.map((d) => d.removed);
  const files = diffs.map((d) => d.fileCount);

  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const stddev = (xs) => {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
  };

  const meanAdd = mean(adds);
  const meanFiles = mean(files);
  const addRatio = meanAdd === 0 ? 1 : stddev(adds) / meanAdd;
  const delRatio = mean(dels) === 0 ? 1 : stddev(dels) / mean(dels);

  // Lower variance = higher uniformity.
  const uniformity = Math.max(0, 1 - (addRatio + delRatio) / 2);
  const sizeContainment = meanAdd <= 20 ? 1 : Math.max(0, 1 - (meanAdd - 20) / 80);
  const fileFocus = meanFiles <= 3 ? 1 : Math.max(0, 1 - (meanFiles - 3) / 5);

  return Number(((uniformity * 0.5 + sizeContainment * 0.3 + fileFocus * 0.2)).toFixed(3));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate recipe proposals from the latest miner output.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot=process.cwd()]
 * @param {string} [opts.sessionFixPath]
 * @param {string} [opts.fixAttemptPath]
 * @returns {Promise<object>}  Proposal report.
 */
async function propose(opts = {}) {
  const repoRoot = opts.repoRoot || process.cwd();
  const report = await PatternMiner.mine({
    sessionFixPath: opts.sessionFixPath,
    fixAttemptPath: opts.fixAttemptPath,
  });

  const proposals = [];
  const recurring = report.recurringSubjects || [];

  for (const group of recurring.slice(0, MAX_PROPOSALS)) {
    if (group.hits < MIN_HITS_FOR_PROPOSAL) continue;
    if (!Array.isArray(group.sampleShas) || group.sampleShas.length === 0) continue;

    const diffs = group.sampleShas.slice(0, SAMPLE_DIFFS_PER_PROPOSAL)
      .map((sha) => characteriseCommit(repoRoot, sha));

    // Drop proposals where all sample commits returned 0 — usually means
    // the SHAs don't exist locally (e.g. test fixtures).
    if (diffs.every((d) => d.added === 0 && d.removed === 0 && d.fileCount === 0)) {
      continue;
    }

    const score = plausibilityScore(diffs);
    const verdict = score >= 0.7 ? 'high-confidence'
                  : score >= 0.4 ? 'review'
                  : 'low-confidence-skip';

    proposals.push({
      pattern: group.pattern,
      hits: group.hits,
      sampleShas: group.sampleShas,
      sampleDiffs: diffs.map((d, i) => ({
        sha: group.sampleShas[i],
        files: d.files.slice(0, 10),
        added: d.added,
        removed: d.removed,
      })),
      plausibilityScore: score,
      verdict,
      proposedRule: {
        // Skeleton — reviewer fills in matches() and apply() bodies.
        name: 'rule-' + group.pattern.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 50).toLowerCase(),
        sourceCommits: group.sampleShas,
        suggestedLocation: 'website/app/lib/rule-based-fixer.js (TRANSFORMS list)',
        action: 'transcribe the mechanical change observed across sample commits into a regex-based TRANSFORM',
      },
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    minerInputs: report.inputs,
    proposalsTotal: proposals.length,
    highConfidence: proposals.filter((p) => p.verdict === 'high-confidence').length,
    review: proposals.filter((p) => p.verdict === 'review').length,
    skipped: proposals.filter((p) => p.verdict === 'low-confidence-skip').length,
    proposals,
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Recipe Promoter — Nightly Proposals');
  lines.push('');
  lines.push(`_Generated ${report.generatedAt}_`);
  lines.push('');
  lines.push(`Total: **${report.proposalsTotal}** (high-confidence: ${report.highConfidence}, review: ${report.review}, skipped: ${report.skipped})`);
  lines.push('');

  if (report.proposalsTotal === 0) {
    lines.push('_No recurring patterns met the threshold for recipe promotion yet._');
    lines.push('');
    return lines.join('\n');
  }

  for (const p of report.proposals) {
    lines.push(`## ${p.proposedRule.name}  \`(${p.verdict})\``);
    lines.push('');
    lines.push(`- Pattern: \`${p.pattern}\``);
    lines.push(`- Hits: ${p.hits}`);
    lines.push(`- Plausibility: ${p.plausibilityScore}`);
    lines.push(`- Sample commits: ${p.sampleShas.slice(0, 5).map((s) => '`' + s.slice(0, 8) + '`').join(', ')}`);
    lines.push('');
    lines.push('Sample diff shapes:');
    lines.push('');
    lines.push('| SHA | Files | +Added | -Removed |');
    lines.push('| --- | --- | --- | --- |');
    for (const d of p.sampleDiffs) {
      lines.push(`| \`${d.sha.slice(0, 8)}\` | ${d.files.length} | +${d.added} | -${d.removed} |`);
    }
    lines.push('');
    lines.push(`Next step: ${p.proposedRule.action}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

async function main() {
  const report = await propose();
  // eslint-disable-next-line no-console
  console.log(renderMarkdown(report)); // code-quality-ok — CLI trainer prints markdown report to stdout
  const outDir = path.join(os.homedir(), '.gatetest', 'trainers');
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'recipe-promoter-latest.json'), JSON.stringify(report, null, 2));
  } catch { /* best-effort */ }
}

if (require.main === module) {
  main().catch((err) => {
    warnOnce(`fatal: ${err && err.message}`);
    process.exit(0);
  });
}

module.exports = {
  propose,
  renderMarkdown,
  _characteriseCommit: characteriseCommit,
  _plausibilityScore: plausibilityScore,
};
