'use strict';

/**
 * Runtime-pass reason codes and the plain-English sentence for each — ONE
 * definition (Doctrine #4, issue #768 item 5).
 *
 * Pure (no requires) on purpose: the browser UI imports it, and the server
 * gate (web-runtime-gate.js, which pulls in platform env and the dispatcher)
 * must not be dragged into the client bundle. The gate re-exports the codes,
 * so the code list and its wording cannot drift apart.
 *
 * The code is the only thing the server ever sends about WHY — no variable
 * names, hostnames or upstream error bodies reach the customer.
 */

const RUNTIME_REASONS = Object.freeze({
  NOT_CONFIGURED: 'not-configured',
  CALLBACK_TIMEOUT: 'callback-timeout',
  // The JSON route's wall-clock budget ran out before the dispatch was attempted (#768 item 1).
  BUDGET_EXHAUSTED: 'budget-exhausted',
});
const DISPATCH_FAILED_PREFIX = 'dispatch-failed:';

/**
 * Plain-English rendering of a reason code. An unknown code still gets a
 * truthful sentence rather than nothing.
 *
 * @param {string|null|undefined} reason
 * @returns {string}
 */
function describeRuntimeReason(reason) {
  if (reason === RUNTIME_REASONS.NOT_CONFIGURED) return 'the live-browser worker is not switched on for this deployment yet';
  if (reason === RUNTIME_REASONS.BUDGET_EXHAUSTED) return 'the scan ran out of time before the live-browser worker could be started';
  if (reason === RUNTIME_REASONS.CALLBACK_TIMEOUT) return 'the live-browser worker did not report back within the time limit';
  if (reason === `${DISPATCH_FAILED_PREFIX}timeout`) return 'the live-browser worker did not answer in time';
  if (reason === `${DISPATCH_FAILED_PREFIX}network`) return 'the live-browser worker could not be reached';
  if (typeof reason === 'string' && reason.startsWith(DISPATCH_FAILED_PREFIX)) {
    return `the live-browser worker refused the job (HTTP ${reason.slice(DISPATCH_FAILED_PREFIX.length)})`;
  }
  return 'it could not be started this time';
}

/**
 * The sentence every hosted web scan surface (JSON `notCheckedReasons` and
 * `runtime.explanation`, and the /web page) prints when the runtime pass did
 * not run — three-state, never a silent gap, never the bare reason code.
 *
 * @param {string|null|undefined} reason
 * @returns {string}
 */
function runtimeNotRunExplanation(reason) {
  return `Runtime checks (real-browser errors, headers under load) were not run: ${describeRuntimeReason(reason)}.`;
}

/** The engine module whose silence the runtime explanation stands in for. */
const RUNTIME_NOT_CHECKED_MODULE = 'runtimeErrors';

/**
 * The runtime module reports a PASS on a deployment with no browser
 * (`runtime-errors:playwright-missing` is an info check, not not-checked),
 * so a scan without the worker looked like one whose runtime layer came back
 * clean. When the gate says the pass did not run, list that module as not
 * checked with the explanation — unless something already listed it (a
 * budget cut, or the module's own not-checked). Coverage is returned, not
 * mutated; the total does not change because the module was already counted.
 *
 * @param {{totalModules: number, checkedModules: number, notChecked: Array<{module: string, reason: string}>}} coverage
 * @param {string|null|undefined} reason  the gate's reason code
 */
function markRuntimeNotChecked(coverage, reason) {
  if (coverage.notChecked.some((n) => n.module === RUNTIME_NOT_CHECKED_MODULE)) return coverage;
  const notChecked = [...coverage.notChecked, { module: RUNTIME_NOT_CHECKED_MODULE, reason: runtimeNotRunExplanation(reason) }];
  return { ...coverage, notChecked, checkedModules: Math.max(0, coverage.totalModules - notChecked.length) };
}

module.exports = {
  RUNTIME_REASONS,
  DISPATCH_FAILED_PREFIX,
  RUNTIME_NOT_CHECKED_MODULE,
  describeRuntimeReason,
  runtimeNotRunExplanation,
  markRuntimeNotChecked,
};
