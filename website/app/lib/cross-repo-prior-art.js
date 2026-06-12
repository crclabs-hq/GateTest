/**
 * Cross-repo prior-art lookup — the CONSUME side of the cross-repo flywheel.
 *
 * The cross-repo-promoter trainer writes anonymised structural fix vectors
 * to `~/.gatetest/cross-repo-corpus/<fingerprint>.json`. Until now nothing
 * read them back — the corpus compounded but fixes never benefited. This
 * helper closes the loop: after a fix is produced, classify its diff shape
 * the same way the promoter does and look up whether the same structural
 * fix shape has shipped before. A hit is a confidence signal surfaced in
 * the PR body ("this fix shape has shipped N times across the corpus").
 *
 * Privacy: lookups are local-disk reads of vectors that contain no
 * customer strings (tokenHistogram + operatorClass only). Nothing is
 * written here; this module is read-only over the corpus.
 *
 * RESILIENCE CONTRACT: never throws. Missing corpus dir, malformed
 * vectors, oversized files — all degrade to "no prior art".
 */

'use strict';

const { splitLines, diffLines } = require('./inline-diff');
const CrossRepoPromoter = require('./trainers/cross-repo-promoter');

// inline-diff's LCS is O(n*m); skip prior-art classification on huge files
// rather than burn function time on a cosmetic annotation.
const MAX_LINES_FOR_CLASSIFY = 2000;

/**
 * Compute the {added, removed} line counts for one fix.
 * Returns null when the file is too large to classify cheaply.
 */
function diffShapeForFix(original, fixed) {
  const oldLines = splitLines(typeof original === 'string' ? original : '');
  const newLines = splitLines(typeof fixed === 'string' ? fixed : '');
  if (oldLines.length > MAX_LINES_FOR_CLASSIFY || newLines.length > MAX_LINES_FOR_CLASSIFY) {
    return null;
  }
  let added = 0;
  let removed = 0;
  for (const edit of diffLines(oldLines, newLines)) {
    if (edit.type === 'add') added++;
    else if (edit.type === 'del') removed++;
  }
  return { added, removed, fileCount: 1, hunkCount: 0 };
}

/**
 * Look up prior art for one completed fix.
 *
 * @param {object} fix — { file, original, fixed }
 * @param {object} [opts] — { corpusDir } passthrough for tests
 * @returns {object|null} — { fileExt, operatorClass, sampleSize,
 *   plausibilityScore } for the strongest matching vector, or null.
 */
function lookupPriorArt(fix, opts = {}) {
  try {
    if (!fix || typeof fix.file !== 'string') return null;
    const extMatch = /\.([a-zA-Z0-9]+)$/.exec(fix.file);
    const fileExt = extMatch ? '.' + extMatch[1].toLowerCase() : null;
    const diffShape = diffShapeForFix(fix.original, fix.fixed);
    if (!diffShape || (diffShape.added === 0 && diffShape.removed === 0)) return null;

    // Reuse the promoter's own classifier so CONSUME matches PROMOTE
    // bucket-for-bucket — a private export, but the two sides of one
    // fingerprint scheme must never drift apart.
    const oc = CrossRepoPromoter._operatorClass({
      sampleDiffs: [{ added: diffShape.added, removed: diffShape.removed, files: [fix.file] }],
    });

    const hits = CrossRepoPromoter.lookup(
      { operatorClass: oc, fileExt, diffShape },
      { corpusDir: opts.corpusDir }
    );
    if (!Array.isArray(hits) || hits.length === 0) return null;
    const best = hits.reduce((a, b) => ((b.sampleSize || 0) > (a.sampleSize || 0) ? b : a));
    if (!best || (best.sampleSize || 0) < 1) return null;
    return {
      fileExt,
      operatorClass: oc,
      sampleSize: best.sampleSize || 1,
      plausibilityScore: best.plausibilityScore || 0,
    };
  } catch {
    return null;
  }
}

/**
 * Annotate a list of fixes with prior art. Returns ONLY the fixes that
 * had a corpus hit, as { file, priorArt } entries — callers render these
 * into the PR body. Empty array means no annotations (the common case
 * until the corpus matures).
 */
function annotateFixesWithPriorArt(fixes, opts = {}) {
  const out = [];
  if (!Array.isArray(fixes)) return out;
  for (const fix of fixes) {
    const priorArt = lookupPriorArt(fix, opts);
    if (priorArt) out.push({ file: fix.file, priorArt });
  }
  return out;
}

/**
 * Render the PR-body section for prior-art annotations. Returns '' when
 * there is nothing to say — composers append conditionally.
 */
function renderPriorArtSection(annotations) {
  if (!Array.isArray(annotations) || annotations.length === 0) return '';
  const lines = [
    '### Cross-repo prior art',
    '',
    'These fixes structurally match fix shapes already shipped and validated on other codebases (anonymised — no customer code is shared):',
    '',
  ];
  for (const a of annotations) {
    lines.push(
      `- \`${a.file}\` — ${a.priorArt.operatorClass} fix shape seen ${a.priorArt.sampleSize}× in the corpus`
    );
  }
  return lines.join('\n');
}

module.exports = {
  lookupPriorArt,
  annotateFixesWithPriorArt,
  renderPriorArtSection,
  _diffShapeForFix: diffShapeForFix,
};
