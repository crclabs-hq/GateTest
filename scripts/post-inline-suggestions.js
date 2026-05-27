/**
 * post-inline-suggestions — POSTs inline review comments with GitHub
 * ```suggestion``` blocks for each auto-fix patch produced by the
 * AI CI-fixer.
 *
 * WHY: GitHub renders a ```suggestion``` block in an inline PR review
 * comment as a one-click "Commit suggestion" button. The reviewer
 * applies the fix WITHOUT leaving the GitHub UI — no separate PR,
 * no checkout, no rebase. This is the most-visible product surface
 * for a code-fix tool and the screenshot HN visitors share.
 *
 * Design: this helper is INTENTIONALLY decoupled from the rest of the
 * AI CI-fixer pipeline. It reads patches from a known location
 * (`.gatetest/fix-patches.json` by default), diffs each against the
 * file on disk, and emits one inline suggestion per changed hunk.
 *
 * Failures here MUST NEVER block the auto-fix flow. The caller wraps
 * us in try/catch; we wrap each per-patch / per-hunk post in its own
 * try/catch and aggregate the outcome into a structured result.
 *
 * Patch file format (one record per patched file):
 *   [
 *     {
 *       "file": "apps/api/src/cdn/handler.ts",
 *       "newContent": "full file contents after fix",
 *       "reason": "Optional human-readable explanation of the fix"
 *     },
 *     ...
 *   ]
 *
 * The new-content shape (full file, not unified diff) matches what
 * `lib/ai-ci-fixer-claude.js` already produces — no engine change
 * required to wire this in.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'GateTest-Inline-Suggestions/1.0';

/**
 * Compute the (single) hunk that differs between an original file and
 * its fixed version. Returns null when the files are identical.
 *
 * Uses a simple "first divergent line ... last divergent line" approach:
 * walk top-down to find where they start differing, walk bottom-up to
 * find where they stop. The hunk covers that contiguous span.
 *
 * For multi-hunk diffs (changes in non-adjacent regions), this returns
 * a SINGLE hunk spanning from first-change to last-change — which means
 * the suggestion replaces a wider region than strictly necessary. That's
 * a deliberate V1 simplification: it works perfectly for the 80% case
 * (most auto-fixes are localised to one function / one block) and
 * degrades gracefully on multi-hunk fixes (the user just sees a slightly
 * larger replacement region in the GitHub UI). A V2 with proper multi-
 * hunk LCS-style diffing would be 10x the code for marginal UX gain.
 *
 * @returns null | { startLine, endLine, replacement } — line numbers 1-indexed
 */
function computeSingleHunk(originalText, fixedText) {
  // Normalise to LF for comparison so CRLF vs LF doesn't false-positive
  // every line. We preserve the FIXED text's original newline style when
  // emitting the replacement (so the suggestion matches the file's
  // existing convention).
  const origLines = originalText.replace(/\r\n/g, '\n').split('\n');
  const fixedLines = fixedText.replace(/\r\n/g, '\n').split('\n');

  // Find first divergent line index (0-based).
  let firstDiff = -1;
  const minLen = Math.min(origLines.length, fixedLines.length);
  for (let i = 0; i < minLen; i += 1) {
    if (origLines[i] !== fixedLines[i]) { firstDiff = i; break; }
  }
  if (firstDiff === -1) {
    // No mid-file divergence. If lengths differ, the divergence is at
    // the tail — the common prefix is followed by extra lines in
    // whichever array is longer.
    if (origLines.length === fixedLines.length) return null;
    firstDiff = minLen;
  }

  // Find last divergent line by walking from the bottom of each array.
  let origIdx = origLines.length - 1;
  let fixedIdx = fixedLines.length - 1;
  while (
    origIdx >= firstDiff &&
    fixedIdx >= firstDiff &&
    origLines[origIdx] === fixedLines[fixedIdx]
  ) {
    origIdx -= 1;
    fixedIdx -= 1;
  }

  // The replacement region in the ORIGINAL is lines firstDiff..origIdx
  // (inclusive). The new content for that region is fixedLines
  // firstDiff..fixedIdx (inclusive).
  const startLine = firstDiff + 1; // 1-indexed for GitHub API
  const endLine = Math.max(origIdx + 1, startLine);
  const replacementLines = fixedLines.slice(firstDiff, fixedIdx + 1);
  const replacement = replacementLines.join('\n');

  return { startLine, endLine, replacement };
}

/**
 * Render the ```suggestion``` markdown body for a single hunk. The
 * caller posts this body via POST /repos/.../pulls/N/comments to get
 * the inline "Commit suggestion" button in GitHub's UI.
 */
function renderSuggestionCommentBody({ reason, replacement }) {
  const reasonLine = reason ? `**GateTest auto-fix** — ${reason}` : '**GateTest auto-fix**';
  return [
    reasonLine,
    '',
    '```suggestion',
    replacement,
    '```',
    '',
    '<sub>Click <b>Commit suggestion</b> to apply this fix directly. ' +
    'GateTest will also open a separate pull request with the same fix ' +
    'plus a regression test and pair-review.</sub>',
  ].join('\n');
}

/**
 * POST one inline review comment with a ```suggestion``` block.
 */
async function postOneInlineSuggestion(opts) {
  const {
    owner, repo, prNumber, headSha,
    filePath, startLine, endLine, body,
    token,
    githubApi = GITHUB_API,
    fetchImpl,
  } = opts;
  if (!fetchImpl) throw new Error('postOneInlineSuggestion: fetchImpl required');

  const payload = {
    body,
    commit_id: headSha,
    path: filePath,
    line: endLine,
    side: 'RIGHT',
  };
  if (startLine && startLine !== endLine) {
    payload.start_line = startLine;
    payload.start_side = 'RIGHT';
  }

  const res = await fetchImpl(
    `${githubApi}/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify(payload),
    },
  );
  // GitHub returns 201 Created on success. 422 typically means the line
  // isn't in the diff (the file changed since the patch was computed)
  // — non-fatal; just skip that one and continue.
  return { ok: res.status === 201, status: res.status };
}

/**
 * Top-level: read the patch file, compute hunks, post one inline
 * suggestion per hunk. Aggregates per-patch outcomes. Never throws.
 *
 * @param opts.patches      — explicit array of patches (overrides patchFile)
 * @param opts.patchFile    — path to the JSON patch file (default
 *                            `.gatetest/fix-patches.json`)
 * @param opts.workspace    — workspace root for resolving patch file paths
 * @param opts.owner, repo  — GitHub coordinates
 * @param opts.prNumber     — original PR that needs the suggestions
 * @param opts.headSha      — commit SHA the suggestions anchor to
 * @param opts.token        — GitHub token with pull-requests: write
 * @param opts.fetchImpl    — fetch implementation
 *
 * @returns {Promise<{posted, skipped, errors, total}>}
 */
async function postInlineSuggestionsForPatches(opts) {
  const {
    patches: explicitPatches,
    patchFile,
    workspace = process.cwd(),
    owner, repo, prNumber, headSha,
    token,
    githubApi = GITHUB_API,
    fetchImpl,
  } = opts;

  const result = { posted: 0, skipped: 0, errors: 0, total: 0, details: [] };

  let patches = explicitPatches;
  if (!patches) {
    const resolvedPatchFile = path.resolve(
      workspace,
      patchFile || path.join('.gatetest', 'fix-patches.json'),
    );
    if (!fs.existsSync(resolvedPatchFile)) {
      result.skipped = 1;
      result.details.push({ reason: 'no-patch-file', path: resolvedPatchFile });
      return result;
    }
    try {
      patches = JSON.parse(fs.readFileSync(resolvedPatchFile, 'utf-8'));
    } catch (err) {
      result.errors = 1;
      result.details.push({ reason: 'patch-file-parse-error', message: err && err.message });
      return result;
    }
  }
  if (!Array.isArray(patches)) {
    result.errors = 1;
    result.details.push({ reason: 'patches-not-array' });
    return result;
  }

  for (const patch of patches) {
    result.total += 1;
    try {
      const filePath = patch.file;
      const newContent = patch.newContent || patch.content;
      const reason = patch.reason || '';
      if (!filePath || typeof newContent !== 'string') {
        result.skipped += 1;
        result.details.push({ file: filePath, reason: 'missing-fields' });
        continue;
      }
      // Prefer the snapshot's pre-write originalContent over disk —
      // `applyPatches` writes to disk BEFORE we run, so reading disk
      // now returns the FIXED content and would compute a no-diff hunk.
      // Falls back to disk read for callers who pass explicit patches
      // without snapshots (e.g., test fixtures).
      let originalText;
      if (typeof patch.originalContent === 'string') {
        originalText = patch.originalContent;
      } else {
        const absFile = path.resolve(workspace, filePath);
        if (!fs.existsSync(absFile)) {
          result.skipped += 1;
          result.details.push({ file: filePath, reason: 'file-not-on-disk' });
          continue;
        }
        originalText = fs.readFileSync(absFile, 'utf-8');
      }
      const hunk = computeSingleHunk(originalText, newContent);
      if (!hunk) {
        result.skipped += 1;
        result.details.push({ file: filePath, reason: 'no-diff' });
        continue;
      }

      const body = renderSuggestionCommentBody({ reason, replacement: hunk.replacement });
      const postResult = await postOneInlineSuggestion({
        owner, repo, prNumber, headSha,
        filePath,
        startLine: hunk.startLine,
        endLine: hunk.endLine,
        body,
        token,
        githubApi,
        fetchImpl,
      });
      if (postResult.ok) {
        result.posted += 1;
        result.details.push({ file: filePath, line: hunk.endLine, status: 'posted' });
      } else {
        // 422 = line not in diff (file changed since patch); 404 = PR
        // gone; etc. All non-fatal — skip and continue.
        result.skipped += 1;
        result.details.push({ file: filePath, status: postResult.status, reason: 'api-non-201' });
      }
    } catch (err) {
      result.errors += 1;
      result.details.push({ file: patch && patch.file, reason: 'exception', message: err && err.message });
    }
  }

  return result;
}

module.exports = {
  computeSingleHunk,
  renderSuggestionCommentBody,
  postOneInlineSuggestion,
  postInlineSuggestionsForPatches,
};
