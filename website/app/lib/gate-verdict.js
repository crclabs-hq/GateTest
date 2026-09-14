'use strict';

/**
 * THE gate verdict — one function, every host.
 *
 * Before this file, each host callback decided pass/fail on its own and both
 * got it wrong in opposite directions (measured 2026-09-02):
 *
 *   github-callback   read `module.checks` as an array of severities; the
 *                     engine emits `checks: <number>`, so strict mode could
 *                     NEVER go red. A dashboard light.
 *   gluecron-callback the .js failed on `totalIssues > 0`, but a sibling
 *                     `.ts` shadowed it in every bundle and posted "passed"
 *                     for any completed scan. In production the Gluecron
 *                     gate could never go red either. (Corrected
 *                     2026-09-01; the .ts is gone and
 *                     tests/lib-basename-collision.test.js guards it.)
 *
 * Neither used what the engine had already worked out: confidence-scored
 * `blocking` (doc/test/fixture/comment/string-literal multipliers against
 * BLOCK_THRESHOLD), cross-module de-duplication, `.gatetestignore`
 * suppression, and `inDiff` attribution against the base commit.
 *
 * What this verdict enforces, in strict/admin mode:
 *
 *   1. Only BLOCKING findings fail — error severity AND confident. A
 *      low-confidence error (a secret shape inside a docstring, eval() in a
 *      block comment) is shown, never enforced.
 *   2. Only findings IN THIS CHANGE fail, when the scan knew the base commit.
 *      Pre-existing blocking findings are counted and named in the comment
 *      but do not fail the check. "Old code counted as new" is the complaint
 *      every quality gate has had open for years; a gate that blocks a
 *      one-line PR for a bug in a file it never touched is blocking the wrong
 *      person. With no base (first push, force-push, unreadable base) the
 *      whole repo is enforced — that is the honest fallback, and the verdict
 *      says so in `attributed`.
 *   3. Advisory mode never fails on findings. The counts are still computed
 *      so the comment can say what strict mode WOULD have done.
 *   4. A scan that did not complete is 'error' in every mode — that is a
 *      GateTest problem, never a green tick.
 *
 * Source of truth, in order (the first available wins):
 *   registry  `findings[]` + `findingSummary`  — CLI engine; carries
 *             blocking / duplicateOf / inDiff per finding
 *   engine    `engineMeta.gateStatus`          — CLI engine, whole repo
 *   legacy    `modules[].checks[]` severities or `modules[].status`
 *             — the in-memory runTier fallback and hand-built results
 *
 * Pure. No I/O. Both host callbacks and the tests read from here.
 */

const ENFORCING_MODES = new Set(['strict', 'admin']);

/**
 * @param {object} scanResult
 * @param {'advisory'|'strict'|'admin'} [mode='advisory']
 * @returns {{
 *   state: 'success'|'failure'|'error',
 *   enforced: boolean,
 *   source: 'registry'|'engine'|'legacy'|'none',
 *   attributed: boolean,
 *   blocking: number,
 *   blockingInChange: number,
 *   blockingPreExisting: number,
 *   softErrors: number,
 *   wouldFail: boolean,
 *   reason: string,
 * }}
 */
function computeGateVerdict(scanResult, mode = 'advisory') {
  const enforced = ENFORCING_MODES.has(mode);
  const base = {
    enforced,
    source: 'none',
    attributed: false,
    blocking: 0,
    blockingInChange: 0,
    blockingPreExisting: 0,
    softErrors: 0,
    wouldFail: false,
  };

  if (!scanResult || scanResult.error) {
    return { ...base, state: 'error', reason: String((scanResult && scanResult.error) || 'no scan result') };
  }
  if (scanResult.status && scanResult.status !== 'complete') {
    return { ...base, state: 'error', reason: `scan status ${scanResult.status}` };
  }

  const counts = countBlocking(scanResult);
  const wouldFail = counts.attributed ? counts.blockingInChange > 0 : counts.blocking > 0;
  const state = enforced && wouldFail ? 'failure' : 'success';

  let reason;
  if (counts.source === 'none') reason = 'no findings';
  else if (!wouldFail && counts.blocking > 0) reason = `${counts.blocking} blocking finding(s), all pre-existing — not enforced on this change`;
  else if (!wouldFail) reason = counts.softErrors > 0 ? `${counts.softErrors} low-confidence error(s) held back` : 'no blocking findings';
  else if (counts.attributed) reason = `${counts.blockingInChange} blocking finding(s) in this change`;
  else reason = `${counts.blocking} blocking finding(s) (base unknown — whole repo enforced)`;
  if (!enforced && wouldFail) reason += ' · advisory mode, not enforced';

  return { ...base, ...counts, state, wouldFail, reason };
}

function countBlocking(scanResult) {
  const findings = Array.isArray(scanResult.findings) ? scanResult.findings : null;
  const hasRegistry = findings && scanResult.findingSummary && typeof scanResult.findingSummary === 'object';

  if (hasRegistry) {
    const live = findings.filter((f) => f && !f.duplicateOf);
    const blockingList = live.filter((f) => f.blocking === true);
    const attributed = typeof scanResult.changedFiles === 'number'
      && live.some((f) => typeof f.inDiff === 'boolean');
    const blockingInChange = attributed ? blockingList.filter((f) => f.inDiff).length : blockingList.length;
    return {
      source: 'registry',
      attributed,
      blocking: blockingList.length,
      blockingInChange,
      blockingPreExisting: attributed ? blockingList.length - blockingInChange : 0,
      softErrors: live.filter((f) => f.severity === 'error' && !f.blocking).length,
    };
  }

  const gateStatus = scanResult.engineMeta && scanResult.engineMeta.gateStatus;
  if (gateStatus === 'PASSED' || gateStatus === 'BLOCKED') {
    const blocking = gateStatus === 'BLOCKED' ? 1 : 0;
    return { source: 'engine', attributed: false, blocking, blockingInChange: blocking, blockingPreExisting: 0, softErrors: 0 };
  }

  // Legacy: the in-memory runTier fallback (checks as an array of
  // {severity}) or a module that only reports status. No confidence data
  // exists here, so error severity is the best available signal.
  const modules = Array.isArray(scanResult.modules) ? scanResult.modules : [];
  let blocking = 0;
  let sawAnything = false;
  for (const m of modules) {
    if (!m) continue;
    if (Array.isArray(m.checks)) {
      sawAnything = true;
      blocking += m.checks.filter((c) => c && c.severity === 'error' && c.passed !== true).length;
    } else if (m.status === 'failed') {
      sawAnything = true;
      blocking += 1;
    } else if (m.status) {
      sawAnything = true;
    }
  }
  return {
    source: sawAnything ? 'legacy' : 'none',
    attributed: false,
    blocking,
    blockingInChange: blocking,
    blockingPreExisting: 0,
    softErrors: 0,
  };
}

module.exports = { computeGateVerdict };
