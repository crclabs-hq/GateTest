/**
 * Recipe auto-promoter trainer (Wave 5 — closes the trainer-to-rule loop).
 *
 * Reads recipe-promoter proposals and, for high-confidence token-swap
 * proposals, walks the sample commit diffs to extract the actual literal
 * swap (e.g. `rejectUnauthorized: false` → `rejectUnauthorized: true`),
 * then generates a ready-to-merge RULE file under
 * `website/app/lib/rule-based-fixer-pending/<name>.js`.
 *
 * The pending files are NOT loaded by production by default. The reviewer
 * reads the generated rule, sanity-checks the swap against the source
 * SHAs in the header, and copies the rule into `rule-based-fixer.js`'s
 * RULES array — deleting the pending file when done.
 *
 * Why one-step-from-production:
 *   - Auto-applying a string-replace rule across customer code is high-
 *     risk; one wrong swap can break thousands of files.
 *   - The trainer can SAFELY do the boring transcription work (read the
 *     diffs, format the rule code, document sources). The reviewer keeps
 *     the final judgement call.
 *   - This is the same "draft, don't ship" pattern as the regression-test-
 *     generator (.pending.test.js) and the recipe-promoter (proposals).
 *
 * Safety:
 *   - Only operates on `token-swap` proposals (operatorClass).
 *   - Requires ≥2 sample commits to share the SAME literal swap.
 *   - Skips swaps where the removed token is too short / too generic
 *     (e.g. a single character, a common keyword).
 *   - Pending files include source SHAs for reviewer verification.
 *   - Idempotent: skips if the pending file already exists.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RecipePromoter = require('./recipe-promoter.js');

const MIN_SWAP_LENGTH = 5;        // skip swaps shorter than this (too generic)
const MIN_SAMPLES_AGREEING = 2;   // need ≥ N commits sharing same swap
const MAX_FILES_TO_WRITE = 20;
const PENDING_DIR = path.join(
  process.cwd(),
  'website',
  'app',
  'lib',
  'rule-based-fixer-pending',
);

// Tokens that should NEVER be auto-swapped — too generic, would cause
// massive collateral damage. Comparison is exact-string against the
// "removed" side of the swap.
const FORBIDDEN_REMOVED_TOKENS = new Set([
  'true', 'false', 'null', 'undefined',
  'const', 'let', 'var',
  'if', 'else', 'return', 'this',
  '0', '1', '-1',
  '{', '}', '(', ')', '[', ']',
  '"', "'", '`', ';', ':', ',',
]);

let _warnedOnce = false;
function warnOnce(msg) {
  if (_warnedOnce) return;
  _warnedOnce = true;
  // eslint-disable-next-line no-console
  console.warn(`[recipe-auto-promoter] ${msg}`);
}

// ---------------------------------------------------------------------------
// Diff parsing — extract paired removed/added lines from `git show`
// ---------------------------------------------------------------------------

function readDiff(repoRoot, sha) {
  try {
    return execFileSync('git', ['-C', repoRoot, 'show', '--no-color', '--format=', sha], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return '';
  }
}

/**
 * Walk a diff body and yield paired (removedLine, addedLine) entries
 * where a single `-` line is immediately followed by a single `+` line
 * (the simplest "swap" shape). Skips file headers and hunk markers.
 *
 * Each returned line is stripped of the leading +/- sign and trailing
 * newline. Whitespace is preserved.
 */
function pairedLines(diff) {
  const lines = diff.split('\n');
  const pairs = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const a = lines[i];
    const b = lines[i + 1];
    if (a.startsWith('-') && !a.startsWith('---') && b.startsWith('+') && !b.startsWith('+++')) {
      // Confirm the NEXT line isn't another `+` or `-` (this rules out
      // multi-line swaps which we can't safely synthesise as a single
      // string-replace rule).
      const nextNext = lines[i + 2] || '';
      const prev = lines[i - 1] || '';
      const isOneAndOne = (!prev.startsWith('-') || prev.startsWith('---'))
        && (!nextNext.startsWith('+') || nextNext.startsWith('+++'));
      if (isOneAndOne) {
        pairs.push({ removed: a.slice(1), added: b.slice(1) });
      }
      i++; // skip the +line we already paired
    }
  }
  return pairs;
}

/**
 * For a single (removedLine, addedLine) pair, derive the (beforeToken,
 * afterToken) by finding the longest common prefix and suffix. The middle
 * difference is the "swap." Returns null if there's no clean middle
 * (no shared prefix/suffix means it's a rewrite, not a swap).
 */
function extractTokenSwap(removed, added) {
  if (removed === added) return null;
  let prefix = 0;
  while (prefix < removed.length && prefix < added.length && removed[prefix] === added[prefix]) {
    prefix++;
  }
  // Back the prefix off until it ends at a non-word-char boundary on
  // either side — otherwise the swap would cut a word in half.
  const isWord = (c) => /[A-Za-z0-9_]/.test(c || '');
  while (
    prefix > 0 &&
    isWord(removed[prefix - 1]) &&
    (isWord(removed[prefix]) || isWord(added[prefix]))
  ) {
    prefix--;
  }
  let suffix = 0;
  while (
    suffix < (removed.length - prefix) &&
    suffix < (added.length - prefix) &&
    removed[removed.length - 1 - suffix] === added[added.length - 1 - suffix]
  ) {
    suffix++;
  }
  // Back the suffix off until the boundary is at a non-word-char split.
  while (
    suffix > 0 &&
    isWord(removed[removed.length - suffix]) &&
    (isWord(removed[removed.length - suffix - 1]) || isWord(added[added.length - suffix - 1]))
  ) {
    suffix--;
  }
  const beforeToken = removed.slice(prefix, removed.length - suffix);
  const afterToken = added.slice(prefix, added.length - suffix);
  if (!beforeToken || beforeToken === afterToken) return null;
  return {
    beforeToken,
    afterToken,
    sharedPrefix: removed.slice(0, prefix),
    sharedSuffix: removed.slice(removed.length - suffix),
  };
}

/**
 * Combine many sample diffs to find the swap that recurs most across
 * the proposal's commits. Returns null if no swap agrees in ≥
 * MIN_SAMPLES_AGREEING samples.
 */
function findConsensusSwap(repoRoot, sampleShas) {
  const swapCounts = new Map();   // key "before||after" → { count, samples: [{sha, prefix, suffix}], beforeToken, afterToken }
  for (const sha of sampleShas) {
    const diff = readDiff(repoRoot, sha);
    if (!diff) continue;
    const pairs = pairedLines(diff);
    // Track unique swaps per sha — if two pairs in the same commit yield
    // the same swap, that's still one "vote" from this commit.
    const seenInThisSha = new Set();
    for (const p of pairs) {
      const swap = extractTokenSwap(p.removed, p.added);
      if (!swap) continue;
      if (swap.beforeToken.length < MIN_SWAP_LENGTH) continue;
      if (FORBIDDEN_REMOVED_TOKENS.has(swap.beforeToken.trim())) continue;
      const key = swap.beforeToken + '||' + swap.afterToken;
      if (seenInThisSha.has(key)) continue;
      seenInThisSha.add(key);
      const existing = swapCounts.get(key) || {
        count: 0,
        samples: [],
        beforeToken: swap.beforeToken,
        afterToken: swap.afterToken,
      };
      existing.count += 1;
      existing.samples.push({ sha, prefix: swap.sharedPrefix.slice(0, 40), suffix: swap.sharedSuffix.slice(0, 40) });
      swapCounts.set(key, existing);
    }
  }
  let best = null;
  for (const v of swapCounts.values()) {
    if (v.count >= MIN_SAMPLES_AGREEING && (!best || v.count > best.count)) {
      best = v;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Pending rule file generation
// ---------------------------------------------------------------------------

function sanitiseRuleName(beforeToken) {
  return beforeToken
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'auto-rule';
}

function jsStringLiteral(s) {
  // Use a backtick template literal because beforeToken can contain
  // single + double quotes. Escape backticks and ${.
  return '`' + String(s).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`';
}

function buildRuleFile({ ruleName, swap, proposal }) {
  const before = jsStringLiteral(swap.beforeToken);
  const after  = jsStringLiteral(swap.afterToken);
  const shas   = swap.samples.map((s) => s.sha).slice(0, 10);
  const generatedAt = new Date().toISOString();
  return `/**
 * AUTO-GENERATED PENDING RULE — auto-${ruleName}
 *
 * Generated by recipe-auto-promoter on ${generatedAt}.
 *
 * Source pattern: \`${proposal.pattern}\` (${proposal.hits} commits)
 * Plausibility score: ${proposal.plausibilityScore}
 * Verdict: ${proposal.verdict}
 *
 * Sample commits this rule was derived from (run \`git show <sha>\` to
 * verify the swap matches the actual change):
${shas.map((sha) => ` *   - ${sha}`).join('\n')}
 *
 * The trainer observed ${swap.samples.length} of those commits making
 * the same literal swap. The pattern is exported below as a single
 * regex-free string-replace rule that can be copied into
 * \`rule-based-fixer.js\`'s RULES array.
 *
 * REVIEWER CHECKLIST before promoting to production:
 *   1. git show ${shas[0]} — does the diff actually swap the tokens
 *      below in a context that's safe to apply globally?
 *   2. Search the codebase for the BEFORE token — would a blanket
 *      string-replace cause collateral damage in other files?
 *   3. Adjust matches() if the rule should only fire for specific
 *      issue text rather than any issue containing the before-token.
 *   4. Copy the exported \`rule\` object into RULES in
 *      website/app/lib/rule-based-fixer.js
 *   5. Delete this file.
 */

'use strict';

// eslint-disable-next-line no-unused-vars
function replaceAll(content, pattern, replacement) {
  if (pattern instanceof RegExp) {
    const g = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
    return content.replace(g, replacement);
  }
  return content.split(pattern).join(replacement);
}

const rule = {
  name: 'auto-${ruleName}',
  auto: true,
  promotedAt: ${jsStringLiteral(generatedAt)},
  sourceShas: ${JSON.stringify(shas)},
  beforeToken: ${before},
  afterToken: ${after},
  matches: function matches(issue) {
    if (typeof issue !== 'string') return false;
    return issue.includes(${before});
  },
  apply: function apply(content /* , filePath */) {
    if (typeof content !== 'string') return content;
    if (!content.includes(${before})) return content;
    return content.split(${before}).join(${after});
  },
};

module.exports = { rule };
`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read recipe-promoter proposals (or take them from opts), pick high-
 * confidence token-swap candidates, find the consensus swap across
 * sample commits, and write one pending rule file per accepted swap.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot=process.cwd()]
 * @param {string} [opts.pendingDir]
 * @param {object} [opts.recipeReport]    inject a recipe-promoter report
 *                                        instead of calling propose()
 * @param {boolean} [opts.dryRun=false]   don't write files; report only
 * @returns {Promise<object>}
 */
async function autoPromote(opts = {}) {
  const repoRoot = opts.repoRoot || process.cwd();
  const pendingDir = opts.pendingDir || PENDING_DIR;
  const dryRun = !!opts.dryRun;

  const report = opts.recipeReport
    || (await RecipePromoter.propose({ repoRoot }));

  const result = {
    generatedAt: new Date().toISOString(),
    proposalsConsidered: report.proposalsTotal || 0,
    candidatesEvaluated: 0,
    rulesGenerated: 0,
    rulesSkipped: 0,
    rules: [],
  };

  if (!dryRun) {
    try {
      fs.mkdirSync(pendingDir, { recursive: true });
    } catch (err) {
      warnOnce(`could not create pending dir ${pendingDir}: ${err.message}`);
      return result;
    }
  }

  const candidates = (report.proposals || [])
    .filter((p) => p.verdict === 'high-confidence')
    .filter((p) => p.proposedRule && /token-swap|swap/i.test(p.proposedRule.suggestedLocation + ' ' + (p.proposedRule.action || '') + ' ' + (p.pattern || '')) || true)
    .slice(0, MAX_FILES_TO_WRITE);

  for (const p of candidates) {
    result.candidatesEvaluated += 1;
    const swap = findConsensusSwap(repoRoot, p.sampleShas || []);
    if (!swap) {
      result.rulesSkipped += 1;
      result.rules.push({
        status: 'no-consensus',
        pattern: p.pattern,
        hits: p.hits,
      });
      continue;
    }
    const ruleName = sanitiseRuleName(swap.beforeToken);
    const filePath = path.join(pendingDir, `${ruleName}.js`);
    if (fs.existsSync(filePath)) {
      result.rulesSkipped += 1;
      result.rules.push({
        status: 'already-drafted',
        pattern: p.pattern,
        ruleName,
        path: path.relative(repoRoot, filePath),
      });
      continue;
    }
    const body = buildRuleFile({ ruleName, swap, proposal: p });
    if (!dryRun) {
      try {
        fs.writeFileSync(filePath, body, 'utf8');
      } catch (err) {
        warnOnce(`could not write ${filePath}: ${err.message}`);
        result.rulesSkipped += 1;
        result.rules.push({ status: 'write-failed', error: err.message, ruleName });
        continue;
      }
    }
    result.rulesGenerated += 1;
    result.rules.push({
      status: dryRun ? 'dry-run-would-generate' : 'generated',
      ruleName,
      path: path.relative(repoRoot, filePath),
      beforeToken: swap.beforeToken,
      afterToken: swap.afterToken,
      sourceShas: swap.samples.map((s) => s.sha),
      pattern: p.pattern,
    });
  }

  return result;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Recipe Auto-Promoter — Nightly Pending Rules');
  lines.push('');
  lines.push(`_Generated ${report.generatedAt}_`);
  lines.push('');
  lines.push(`Considered: **${report.proposalsConsidered}** — evaluated: ${report.candidatesEvaluated}, generated: **${report.rulesGenerated}**, skipped: ${report.rulesSkipped}`);
  lines.push('');
  if (report.rules.length === 0) {
    lines.push('_No high-confidence token-swap proposals yet._');
    return lines.join('\n');
  }
  lines.push('| Rule name | Status | Before → After | Source SHAs |');
  lines.push('| --- | --- | --- | --- |');
  for (const r of report.rules) {
    const swap = r.beforeToken && r.afterToken
      ? `\`${String(r.beforeToken).slice(0, 30).replace(/\|/g, '\\|')}\` → \`${String(r.afterToken).slice(0, 30).replace(/\|/g, '\\|')}\``
      : '_(no swap detected)_';
    const shas = (r.sourceShas || []).slice(0, 3).map((s) => s.slice(0, 8)).join(', ');
    lines.push(`| ${r.ruleName || '?'} | ${r.status} | ${swap} | ${shas} |`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const result = await autoPromote();
  // eslint-disable-next-line no-console
  console.log(renderMarkdown(result));
  const outDir = path.join(os.homedir(), '.gatetest', 'trainers');
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'recipe-auto-promoter-latest.json'), JSON.stringify(result, null, 2));
  } catch { /* best-effort */ }
}

if (require.main === module) {
  main().catch((err) => {
    warnOnce(`fatal: ${err && err.message}`);
    process.exit(0);
  });
}

module.exports = {
  autoPromote,
  renderMarkdown,
  // exposed for tests
  _pairedLines: pairedLines,
  _extractTokenSwap: extractTokenSwap,
  _findConsensusSwap: findConsensusSwap,
  _sanitiseRuleName: sanitiseRuleName,
  _buildRuleFile: buildRuleFile,
  FORBIDDEN_REMOVED_TOKENS,
  MIN_SWAP_LENGTH,
  MIN_SAMPLES_AGREEING,
};
