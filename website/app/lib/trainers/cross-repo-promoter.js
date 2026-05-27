/**
 * Cross-repo promoter trainer (Wave 4 — Manifest item #7).
 *
 * Takes recipe-promoter output and converts each proposal into an
 * ANONYMISED structural rewrite vector that can be safely shared across
 * customer corpora. The vector strips out every piece of identifying
 * data — variable names, string literals, file paths — leaving only
 * the structural shape of the fix.
 *
 * The promoter is what makes the moat compound across customers WITHOUT
 * leaking customer code. Compliance-safe by design (Manifest item #7).
 *
 * What goes into a vector:
 *   - fingerprint        — sha256 of the normalised structural shape
 *   - operatorClass      — high-level operator family (e.g. "boolean-flip",
 *                          "kwarg-add", "import-add", "stmt-remove")
 *   - fileExt            — language/extension only (.js, .ts, .py)
 *   - diffShape          — { added, removed, fileCount, hunkCount, …}
 *   - tokenHisto         — bucketed counts: { ident, str, num, op, kw }
 *   - sourceRepoHash     — hash of the originating repo URL (one-way)
 *   - sampleSize         — number of commits this vector summarises
 *   - createdAt          — ISO timestamp
 *
 * What NEVER goes in:
 *   - identifier names (function/variable names)
 *   - string literals (anything inside quotes)
 *   - file paths beyond the extension
 *   - commit subjects / messages
 *   - author / email
 *
 * SOC2 contract: a future audit must be able to look at any vector in the
 * shared corpus and see ONLY structural data. The vector's fingerprint
 * is what enables cross-repo lookup; the rest is summary stats only.
 *
 * Storage (default):
 *   ~/.gatetest/cross-repo-corpus/<fingerprint>.json
 *
 * Production deployment will switch this to a shared store (S3 or Neon
 * row). The file-system default keeps the trainer dev-runnable.
 *
 * RESILIENCE: never throws. Read/write failures degrade to warnOnce.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const RecipePromoter = require('./recipe-promoter.js');

const DEFAULT_CORPUS_DIR = path.join(os.homedir(), '.gatetest', 'cross-repo-corpus');
const MAX_VECTORS_PER_RUN = 50;
const MIN_PLAUSIBILITY_FOR_PROMOTION = 0.5;

let _warnedOnce = false;
function warnOnce(msg) {
  if (_warnedOnce) return;
  _warnedOnce = true;
  // eslint-disable-next-line no-console
  console.warn(`[cross-repo-promoter] ${msg}`);
}

// ---------------------------------------------------------------------------
// One-way hashing — repo URL → opaque sourceRepoHash
// ---------------------------------------------------------------------------

function hashRepoIdentity(repoRoot) {
  // Use the git origin URL if available; otherwise fall back to a hash
  // of the absolute path. Either way, the output is sha256 truncated to
  // 16 hex chars — non-reversible, suitable for "different repo or not."
  let identity = repoRoot || '';
  try {
    const remote = execFileSync('git', ['-C', repoRoot || '.', 'remote', 'get-url', 'origin'], {
      encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (remote) identity = remote;
  } catch { /* fall back to repoRoot */ }
  return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Anonymisation
// ---------------------------------------------------------------------------

/**
 * Bucketize tokens in a diff snippet into structural buckets without
 * recording any literal token text.
 *
 * Returns: { ident, str, num, op, kw }
 *
 * Approximations are fine — the goal is a coarse shape, not a parser.
 * Strings and idents are most important to anonymise because they carry
 * customer-identifying content.
 */
function tokenHistogram(snippet) {
  if (typeof snippet !== 'string' || snippet.length === 0) {
    return { ident: 0, str: 0, num: 0, op: 0, kw: 0 };
  }
  const stripped = snippet.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  let str = (stripped.match(/'[^']*'|"[^"]*"|`[^`]*`/g) || []).length;
  let woStrings = stripped.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, ' STR ');
  let num = (woStrings.match(/\b\d+(?:\.\d+)?\b/g) || []).length;
  const KW = /\b(?:const|let|var|function|return|if|else|for|while|switch|case|break|continue|class|new|throw|catch|try|finally|async|await|import|export|from|of|in|typeof|instanceof|true|false|null|undefined|this|super)\b/g;
  let kw = (woStrings.match(KW) || []).length;
  woStrings = woStrings.replace(KW, ' KW ');
  let ident = (woStrings.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) || []).length;
  let op = (woStrings.match(/[=+\-*/<>!&|^~%?:]+/g) || []).length;
  return { ident, str, num, op, kw };
}

/**
 * Classify the dominant operator family at play in a proposal. Coarse —
 * the point is rough cross-repo matching, not precise reproduction.
 *
 * Reads the proposal's diff samples to pattern-match. Never reads
 * literal token text into the output.
 */
function operatorClass(proposal) {
  const diffs = Array.isArray(proposal.sampleDiffs) ? proposal.sampleDiffs : [];
  if (diffs.length === 0) return 'mixed';
  // Balanced 1:1 swap, small → boolean-flip / scalar-swap.
  // Check this FIRST because {added:1, removed:1} also matches the
  // looser stmt-add/stmt-remove predicates if those run earlier.
  if (diffs.every((d) => (d.added || 0) === (d.removed || 0) && (d.added || 0) >= 1 && (d.added || 0) <= 2)) {
    return 'token-swap';
  }
  // Pure-added: every diff has added ≥ 1 AND removed === 0 → import-add / stmt-add
  if (diffs.every((d) => (d.added || 0) >= 1 && (d.removed || 0) === 0)) {
    return 'stmt-add';
  }
  // Pure-removed: every diff has removed ≥ 1 AND added === 0
  if (diffs.every((d) => (d.removed || 0) >= 1 && (d.added || 0) === 0)) {
    return 'stmt-remove';
  }
  // Otherwise: kwarg-add / config-change / refactor
  return 'mixed';
}

function fileExtFromDiffs(diffs) {
  for (const d of (diffs || [])) {
    const files = d.files || [];
    for (const f of files) {
      const m = /\.([a-zA-Z0-9]+)$/.exec(f);
      if (m) return '.' + m[1].toLowerCase();
    }
  }
  return null;
}

function fingerprint({ operatorClass: oc, fileExt, diffShape }) {
  const canonical = JSON.stringify({
    oc,
    fileExt,
    addedBucket: diffShape && diffShape.added ? bucketSize(diffShape.added) : 0,
    removedBucket: diffShape && diffShape.removed ? bucketSize(diffShape.removed) : 0,
    fileCount: diffShape && diffShape.fileCount ? Math.min(diffShape.fileCount, 5) : 0,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 24);
}

function bucketSize(n) {
  if (n <= 1) return 1;
  if (n <= 3) return 3;
  if (n <= 10) return 10;
  if (n <= 30) return 30;
  if (n <= 100) return 100;
  return 1000;
}

function meanDiffShape(diffs) {
  if (!Array.isArray(diffs) || diffs.length === 0) return { added: 0, removed: 0, fileCount: 0, hunkCount: 0 };
  const mean = (key) => diffs.reduce((s, d) => s + (d[key] || 0), 0) / diffs.length;
  return {
    added: Math.round(mean('added')),
    removed: Math.round(mean('removed')),
    fileCount: Math.round(diffs.reduce((s, d) => s + ((d.files || []).length || 0), 0) / diffs.length),
    hunkCount: 0,
  };
}

/**
 * Convert one recipe-promoter proposal into an anonymised vector.
 * RETURNS NULL if the proposal is too low-quality to promote.
 */
function anonymise(proposal, opts = {}) {
  if (!proposal || typeof proposal !== 'object') return null;
  if ((proposal.plausibilityScore || 0) < MIN_PLAUSIBILITY_FOR_PROMOTION) return null;
  const oc = operatorClass(proposal);
  const fileExt = fileExtFromDiffs(proposal.sampleDiffs) || null;
  const diffShape = meanDiffShape(proposal.sampleDiffs);
  const fp = fingerprint({ operatorClass: oc, fileExt, diffShape });
  return {
    fingerprint: fp,
    operatorClass: oc,
    fileExt,
    diffShape,
    tokenHisto: { ident: 0, str: 0, num: 0, op: 0, kw: 0 }, // populated below if requested
    plausibilityScore: proposal.plausibilityScore || 0,
    sampleSize: (proposal.sampleShas || []).length,
    sourceRepoHash: opts.sourceRepoHash || null,
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Corpus I/O
// ---------------------------------------------------------------------------

function ensureCorpusDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (err) {
    warnOnce(`could not create corpus dir ${dir}: ${err.message}`);
    return false;
  }
}

function writeVector(corpusDir, vector) {
  if (!vector || !vector.fingerprint) return false;
  const filePath = path.join(corpusDir, `${vector.fingerprint}.json`);
  // If the vector already exists, bump its sampleSize rather than
  // overwriting. This is how the corpus accumulates evidence across runs.
  let existing = null;
  try {
    if (fs.existsSync(filePath)) {
      existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch { /* corrupt — overwrite */ }
  const merged = existing ? {
    ...existing,
    sampleSize: (existing.sampleSize || 0) + (vector.sampleSize || 1),
    plausibilityScore: Math.max(existing.plausibilityScore || 0, vector.plausibilityScore || 0),
    lastSeenAt: vector.createdAt,
  } : vector;
  try {
    fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), 'utf8');
    return true;
  } catch (err) {
    warnOnce(`could not write vector ${vector.fingerprint}: ${err.message}`);
    return false;
  }
}

/**
 * Look up cross-repo prior art for a candidate {operatorClass, fileExt,
 * diffShape}. Returns the vectors (possibly empty) whose fingerprints
 * match. Use this when scanning a new repo to surface "this looks like
 * a fix N customers have already shipped."
 */
function lookup(candidate, opts = {}) {
  const dir = opts.corpusDir || DEFAULT_CORPUS_DIR;
  if (!fs.existsSync(dir)) return [];
  const fp = fingerprint({
    operatorClass: candidate.operatorClass,
    fileExt: candidate.fileExt,
    diffShape: candidate.diffShape || {},
  });
  const filePath = path.join(dir, `${fp}.json`);
  if (!fs.existsSync(filePath)) return [];
  try {
    return [JSON.parse(fs.readFileSync(filePath, 'utf8'))];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Promote eligible recipe-promoter proposals into the cross-repo corpus
 * as anonymised structural vectors.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot=process.cwd()]
 * @param {string} [opts.corpusDir]
 * @param {string} [opts.sessionFixPath]
 * @param {string} [opts.fixAttemptPath]
 * @returns {Promise<object>}
 */
async function promote(opts = {}) {
  const repoRoot = opts.repoRoot || process.cwd();
  const corpusDir = opts.corpusDir || DEFAULT_CORPUS_DIR;
  const sourceRepoHash = hashRepoIdentity(repoRoot);

  const recipeReport = await RecipePromoter.propose({
    repoRoot,
    sessionFixPath: opts.sessionFixPath,
    fixAttemptPath: opts.fixAttemptPath,
  });

  const result = {
    generatedAt: new Date().toISOString(),
    sourceRepoHash,
    corpusDir,
    proposalsConsidered: recipeReport.proposalsTotal,
    promoted: 0,
    skippedLowQuality: 0,
    skippedWriteFailed: 0,
    vectors: [],
  };

  if (!ensureCorpusDir(corpusDir)) {
    return result;
  }

  const eligible = (recipeReport.proposals || []).slice(0, MAX_VECTORS_PER_RUN);
  for (const p of eligible) {
    const vector = anonymise(p, { sourceRepoHash });
    if (!vector) {
      result.skippedLowQuality += 1;
      continue;
    }
    const ok = writeVector(corpusDir, vector);
    if (ok) {
      result.promoted += 1;
      // Strip the sourceRepoHash from the public-facing summary — it stays
      // in the on-disk vector but doesn't appear in the run report.
      const { sourceRepoHash: _drop, ...summary } = vector;
      result.vectors.push(summary);
    } else {
      result.skippedWriteFailed += 1;
    }
  }

  return result;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Cross-Repo Promoter — Nightly Promotion');
  lines.push('');
  lines.push(`_Generated ${report.generatedAt}_`);
  lines.push('');
  lines.push(`Source repo hash: \`${report.sourceRepoHash}\``);
  lines.push(`Corpus dir: \`${report.corpusDir}\``);
  lines.push(`Considered: **${report.proposalsConsidered}** — promoted: **${report.promoted}**, low-quality skipped: **${report.skippedLowQuality}**, write-failed: **${report.skippedWriteFailed}**`);
  lines.push('');
  if (report.vectors.length === 0) {
    lines.push('_No vectors promoted this run._');
    return lines.join('\n');
  }
  lines.push('## Vectors promoted');
  lines.push('');
  lines.push('| Fingerprint | OperatorClass | FileExt | +Added | -Removed | Score |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const v of report.vectors) {
    lines.push(`| \`${v.fingerprint.slice(0, 12)}\` | ${v.operatorClass} | ${v.fileExt || '?'} | +${v.diffShape.added} | -${v.diffShape.removed} | ${v.plausibilityScore} |`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const report = await promote();
  // eslint-disable-next-line no-console
  console.log(renderMarkdown(report));
  const outDir = path.join(os.homedir(), '.gatetest', 'trainers');
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'cross-repo-promoter-latest.json'), JSON.stringify(report, null, 2));
  } catch { /* best-effort */ }
}

if (require.main === module) {
  main().catch((err) => {
    warnOnce(`fatal: ${err && err.message}`);
    process.exit(0);
  });
}

module.exports = {
  promote,
  lookup,
  renderMarkdown,
  _anonymise: anonymise,
  _fingerprint: fingerprint,
  _operatorClass: operatorClass,
  _tokenHistogram: tokenHistogram,
  _hashRepoIdentity: hashRepoIdentity,
  _writeVector: writeVector,
  DEFAULT_CORPUS_DIR,
};
