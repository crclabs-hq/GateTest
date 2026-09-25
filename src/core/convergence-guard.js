'use strict';

/**
 * Convergence guard — the one definition of "when does an iterative
 * review/fix loop stop, and why" (doctrine #4). Three loops each grew their
 * own private answer to that question:
 *   - website/app/lib/fix-attempt-loop.js — per-file fix retries
 *     (`maxAttempts`, `finalReason: "exhausted N attempts"`)
 *   - src/core/cli-fix-orchestrator.js — `gatetest fix` hypothesis retries
 *   - bin/gatetest.js `runCrawlLoop` — the `--crawl-loop` round loop
 *
 * Complaint C23 (CodeRabbit G2): a review/fix loop that never converges —
 * it re-flags the fix it just made, or burns its whole attempt budget with
 * no explanation of why it stopped. This module gives every loop the same
 * six termination reasons and the same "own-fix" bookkeeping, so a finding
 * the loop itself just produced is never chased forever, and every result
 * says why it stopped in one line a human can read.
 *
 * This module owns ONLY the iteration/convergence decision. It does not
 * decide what a finding's identity is — callers pass finding ids already
 * computed from the canonical source for their domain (a check's
 * module+name+file for a scan result, `report-provenance.fingerprintFindings`
 * for a whole gate result, a syntax-error string for a hypothesis retry).
 * A second answer to "how do we hash a finding" would be exactly the bug
 * doctrine #4 forbids, so this module hashes whatever ids it is handed
 * without reinterpreting them.
 */

const crypto = require('crypto');

/** The six termination reasons a loop result is always exactly one of. */
const REASONS = Object.freeze({
  CONVERGED: 'converged',
  NO_PROGRESS: 'no-progress',
  OSCILLATING: 'oscillating',
  MAX_ITERATIONS: 'max-iterations',
  BUDGET: 'budget',
  FIX_REJECTED: 'fix-rejected',
});

function _plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Sort + de-dupe + hash a finding-id set. Pure, exported for tests. */
function hashFindingSet(ids) {
  const sorted = [...new Set((ids || []).map(String))].sort();
  const hash = crypto.createHash('sha256').update(sorted.join('\n')).digest('hex');
  return { ids: sorted, hash };
}

/**
 * @param {object} [opts]
 * @param {number} [opts.maxIterations=3]     hard ceiling — becomes `max-iterations`
 *                                             (this is the existing `maxAttempts` cap,
 *                                             unchanged in meaning)
 * @param {number|null} [opts.budgetMs=null]  wall-clock budget; null = unmetered
 * @param {() => number} [opts.now=Date.now]  injectable clock for tests
 * @returns {{step: Function, getResult: Function, REASONS: object}}
 */
function createConvergenceGuard(opts = {}) {
  const { maxIterations = 3, budgetMs = null, now = Date.now } = opts;
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new RangeError('maxIterations must be a positive integer');
  }

  const startedAt = now();
  const history = [];       // { iteration, hash, ids }
  let lastFixed = new Map(); // findingId -> last attempted change description
  let done = false;
  let result = null;

  function finish(reason, message, unresolved) {
    done = true;
    result = { reason, iterations: history.length, message, unresolved: unresolved || [] };
    return { done: true, reason, message, iteration: history.length };
  }

  function unresolvedFrom(ids) {
    return ids.map((id) => ({
      id,
      origin: lastFixed.has(id) ? 'own-fix' : undefined,
      lastAttempt: lastFixed.get(id) || null,
    }));
  }

  /**
   * Advance the loop by one iteration.
   *
   * @param {object} step
   * @param {string[]} [step.findingIds]  finding ids in scope after this
   *        iteration ran (post-fix). An empty array means the scope is clean.
   * @param {Array<{id: string, change?: string}>} [step.fixed]
   *        findings the loop attempted to fix THIS iteration — carried
   *        forward so a re-flag next iteration can be reported as
   *        `origin: "own-fix"` with the last attempted change.
   * @param {boolean} [step.fixRejected=false]
   *        the fake-fix detector or a test run rejected the change just
   *        made — an immediate, unconditional stop.
   * @returns {{done: boolean, reason: string|null, message: string|null, iteration: number}}
   */
  function step({ findingIds = [], fixed = [], fixRejected = false } = {}) {
    if (done) return { done: true, reason: result.reason, message: result.message, iteration: history.length };

    const iteration = history.length + 1;
    const { ids, hash } = hashFindingSet(findingIds);

    if (fixRejected) {
      history.push({ iteration, hash, ids });
      return finish(
        REASONS.FIX_REJECTED,
        `stopped: fix rejected at iteration ${iteration} — the fix did not pass validation`,
        unresolvedFrom(ids)
      );
    }

    // Own-fix re-flag: a finding the loop itself just tried to fix is back,
    // with the same id, one iteration later. Trying the same fix again
    // would just repeat the cycle — stop and hand the human the last
    // attempted change instead.
    const reflagged = ids.filter((id) => lastFixed.has(id));
    if (reflagged.length > 0) {
      history.push({ iteration, hash, ids });
      return finish(
        REASONS.NO_PROGRESS,
        `stopped: no progress after iteration ${iteration} — ${_plural(reflagged.length, 'finding')} came back after the loop's own fix`,
        reflagged.map((id) => ({ id, origin: 'own-fix', lastAttempt: lastFixed.get(id) }))
      );
    }

    if (ids.length === 0) {
      history.push({ iteration, hash, ids });
      return finish(REASONS.CONVERGED, `stopped: converged after iteration ${iteration} — no findings left in scope`);
    }

    const prev = history[history.length - 1];
    if (prev && prev.hash === hash) {
      history.push({ iteration, hash, ids });
      return finish(
        REASONS.NO_PROGRESS,
        `stopped: no progress after iteration ${iteration} — the same ${_plural(ids.length, 'finding')} came back`,
        unresolvedFrom(ids)
      );
    }

    // Two-state alternation: this iteration's set matches the one from two
    // iterations ago but not the one immediately before it.
    const prev2 = history[history.length - 2];
    if (prev2 && prev2.hash === hash) {
      history.push({ iteration, hash, ids });
      return finish(
        REASONS.OSCILLATING,
        `stopped: oscillating after iteration ${iteration} — the finding set is alternating between two states`,
        unresolvedFrom(ids)
      );
    }

    history.push({ iteration, hash, ids });

    if (budgetMs != null && (now() - startedAt) >= budgetMs) {
      return finish(
        REASONS.BUDGET,
        `stopped: time/token budget hit after iteration ${iteration}`,
        unresolvedFrom(ids)
      );
    }

    if (iteration >= maxIterations) {
      return finish(
        REASONS.MAX_ITERATIONS,
        `stopped: reached the max-iterations cap (${maxIterations}) after iteration ${iteration}`,
        unresolvedFrom(ids)
      );
    }

    // Roll `fixed` forward so the NEXT iteration can detect a re-flag.
    lastFixed = new Map((fixed || []).map((f) => [String(f.id), f.change || null]));

    return { done: false, reason: null, message: null, iteration };
  }

  /** `{reason, iterations, message, unresolved}` — reason is null until `step()` finishes the loop. */
  function getResult() {
    return result || { reason: null, iterations: history.length, message: null, unresolved: [] };
  }

  return { step, getResult, REASONS };
}

module.exports = { createConvergenceGuard, hashFindingSet, REASONS };
