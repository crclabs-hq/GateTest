/**
 * AI evidence gate — no AI finding ships without checkable evidence
 * (2026-08-18 audit advancement #5, competitor complaint #9: hallucinated
 * AI findings — "python 3.14 does not exist yet").
 *
 * The model is REQUIRED (by the ai-review prompt contract) to quote the
 * exact code it is flagging. This gate verifies the quote against the
 * files that were actually reviewed:
 *
 *   confirmed  — the quote appears at (or within ±3 lines of) the claimed
 *                line; the finding's line is corrected to where the code
 *                really is.
 *   relocated  — the quote appears in the claimed file but somewhere else;
 *                the finding survives with the corrected line and a note.
 *                (Models are good at seeing bugs and bad at counting
 *                lines — dropping these would throw away real findings.)
 *   rejected   — the file was never in the review batch, the quote appears
 *                nowhere in it, or no quote was supplied at all. The
 *                finding does NOT ship as a defect; it is surfaced in an
 *                aggregate "rejected by evidence gate" info line so the
 *                gate itself is auditable (Forbidden #16: never silently
 *                fail — and never silently discard, either).
 *
 * Matching is whitespace-normalized (models re-indent quotes) but
 * otherwise exact. Pure functions, no fs, no network — tested directly.
 */

'use strict';

/** Collapse all whitespace runs so re-indented quotes still match. */
function normalizeSnippet(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Verify one AI finding against the reviewed file contents.
 *
 * @param {{ file?: string, line?: number, evidence?: string }} issue
 * @param {Map<string, string>} filesByPath  normalized rel path → content
 * @returns {{ verdict: 'confirmed'|'relocated'|'rejected', line?: number, reason?: string }}
 */
function verifyAiFinding(issue, filesByPath) {
  const file = normalizePath(issue && issue.file);
  if (!file || !filesByPath.has(file)) {
    return { verdict: 'rejected', reason: `file not in the review batch: ${file || '(none)'}` };
  }
  const evidence = normalizeSnippet(issue && issue.evidence);
  if (!evidence) {
    return { verdict: 'rejected', reason: 'no evidence quote supplied' };
  }

  const content = filesByPath.get(file);
  const lines = content.split(/\r?\n/);

  // Find every line where the (possibly multi-line) quote starts. A quote
  // spanning lines is matched by walking a normalized window forward.
  const evidenceFirstLine = normalizeSnippet(evidence.split(/\r?\n/)[0]);
  const matches = [];
  for (let i = 0; i < lines.length; i += 1) {
    const one = normalizeSnippet(lines[i]);
    if (!one) continue;
    if (one.includes(evidenceFirstLine) || evidenceFirstLine.includes(one)) {
      // Candidate start — verify the full quote from here.
      let window = '';
      for (let k = i; k < Math.min(lines.length, i + 20); k += 1) {
        window = window ? `${window} ${normalizeSnippet(lines[k])}` : normalizeSnippet(lines[k]);
        if (window.includes(evidence)) { matches.push(i + 1); break; }
        if (window.length > evidence.length + 400) break;
      }
    }
  }

  if (matches.length === 0) {
    return { verdict: 'rejected', reason: 'quoted code does not appear in the file' };
  }

  const claimed = Number(issue.line) || 0;
  // Nearest match to the claimed line wins.
  let best = matches[0];
  for (const m of matches) {
    if (Math.abs(m - claimed) < Math.abs(best - claimed)) best = m;
  }
  if (claimed >= 1 && Math.abs(best - claimed) <= 3) {
    return { verdict: 'confirmed', line: best };
  }
  return { verdict: 'relocated', line: best };
}

/**
 * Gate a whole review. Returns the surviving issues (with corrected
 * lines and a `evidenceVerdict` field) plus the rejects with reasons.
 *
 * @param {Array<object>} issues
 * @param {Array<{path: string, content: string}>} fileContents
 * @returns {{ accepted: Array<object>, rejected: Array<{ issue: object, reason: string }> }}
 */
function gateAiReview(issues, fileContents) {
  const filesByPath = new Map();
  for (const f of Array.isArray(fileContents) ? fileContents : []) {
    if (f && typeof f.path === 'string') filesByPath.set(normalizePath(f.path), String(f.content || ''));
  }
  const accepted = [];
  const rejected = [];
  for (const issue of Array.isArray(issues) ? issues : []) {
    const v = verifyAiFinding(issue || {}, filesByPath);
    if (v.verdict === 'rejected') {
      rejected.push({ issue, reason: v.reason });
    } else {
      accepted.push({ ...issue, line: v.line, evidenceVerdict: v.verdict });
    }
  }
  return { accepted, rejected };
}

module.exports = { verifyAiFinding, gateAiReview };
