'use strict';

/**
 * What a hosted scan did NOT check, in sentences a customer can act on.
 *
 * Audit 2026-10-02 (build-order item 15): the paid scan page showed "All
 * Clear" even when the full engine had crashed and an in-memory 23-module
 * fallback ran, or when a large repository was cut at the per-scan file cap.
 * The data was on the response (`coverage`) — only the PR comment
 * (github-callback.js notCheckedLines) and the free playground said so.
 * Same conditions as notCheckedLines: engine !== 'cli' on an engine tier,
 * and truncated with both file counts known.
 *
 * @param {{ filesAnalysed?: number|null, filesInRepo?: number|null, truncated?: boolean, engine?: string|null } | null | undefined} coverage
 * @returns {string[]}
 */
function notCheckedNotices(coverage) {
  const out = [];
  if (!coverage) return out;
  if (typeof coverage.engine === 'string' && coverage.engine !== 'cli') {
    out.push('Partial scan: the full engine was unavailable for this run, so a reduced module set ran. Findings are a subset — a pass here is not a full verdict. Re-run the scan for the full engine.');
  }
  const { filesAnalysed, filesInRepo } = coverage;
  if (coverage.truncated === true && typeof filesAnalysed === 'number' && typeof filesInRepo === 'number' && filesInRepo > filesAnalysed) {
    const missed = filesInRepo - filesAnalysed;
    out.push(`Coverage: ${filesAnalysed} of ${filesInRepo} files analysed — the repository is over the per-scan file cap, so ${missed} file${missed === 1 ? ' was' : 's were'} not checked.`);
  }
  return out;
}

module.exports = { notCheckedNotices };
