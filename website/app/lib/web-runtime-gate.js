'use strict';

/**
 * Web runtime-scan gate — the ONE decision, shared by /api/web/scan (JSON),
 * /api/web/scan/stream and /api/wp/scan/stream (SSE), about whether the
 * headless-browser runtime pass is dispatched to the platform worker, and
 * exactly what the customer is told when it is not.
 *
 * Why it exists (KI #111, 2026-09-15): the hosted web scan sells "we open
 * your site in a real browser". Before this module the JSON route dispatched
 * whenever a callback base URL was set — even with no platform token or
 * secret — and surfaced whatever string the dispatcher returned (env-var
 * names, the platform name, up to 300 bytes of a remote error body) straight
 * to the browser; the stream routes never dispatched at all and hard-coded
 * "Runtime worker wiring pending". Neither said, in the customer's words,
 * that a whole advertised layer had not run.
 *
 * Doctrine #1 / #6: three-state answer, and the third state is printed.
 * The `runtime` block every route returns is:
 *
 *   { status: 'unavailable', reason: <code>, checked: false, jobId: null, pollUrl: null }
 *   { status: 'queued',      reason: null,   checked: false, jobId, pollUrl, timeoutSec }
 *
 * `checked` is false until a signed callback has actually landed — a queued
 * job is a promise, not a result. Reason codes (the UI maps them to plain
 * English; nothing else is ever sent to the client):
 *
 *   not-configured           token / secret / base URL / callback base absent
 *   dispatch-failed:<status> the platform answered with a non-2xx HTTP status
 *   dispatch-failed:network  the platform could not be reached
 *   dispatch-failed:timeout  the platform did not answer within the dispatch timeout
 *   callback-timeout         queued, but no callback within deadline + grace
 *
 * Fail-closed: when any prerequisite is missing NO request leaves the box —
 * one structured warning is logged server-side (variable NAMES only, never
 * values or hostnames) and the customer is told the runtime pass did not run.
 *
 * Pure module: env and fetch are injected so the control pairs in
 * tests/web-runtime-gate.test.js can assert "no fetch attempted".
 */

const { platformEnv } = require('./platform-config');

const RUNTIME_REASONS = Object.freeze({
  NOT_CONFIGURED: 'not-configured',
  CALLBACK_TIMEOUT: 'callback-timeout',
});
const DISPATCH_FAILED_PREFIX = 'dispatch-failed:';

/** Seconds the platform worker is given to finish the browser pass. */
const RUNTIME_DEADLINE_SEC = 60;
/** Extra seconds allowed for the callback to travel before the UI declares callback-timeout. */
const CALLBACK_GRACE_SEC = 30;

/** Canonical (TALLRIG_*) names of the platform env the dispatch needs. */
const PLATFORM_PREREQUISITES = Object.freeze(['BASE_URL', 'API_TOKEN', 'DISPATCH_SECRET']);

function callbackBaseFrom(env) {
  const v = env.GATETEST_PUBLIC_BASE_URL || env.NEXT_PUBLIC_BASE_URL;
  return typeof v === 'string' && v.trim() ? v.trim().replace(/\/$/, '') : '';
}

/**
 * Names of the variables that must be set before a runtime job may be
 * dispatched. Empty array = ready. Names only — safe to log.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string[]}
 */
function missingRuntimePrerequisites(env = process.env) {
  const missing = PLATFORM_PREREQUISITES
    .filter((name) => !platformEnv(name, env))
    .map((name) => `TALLRIG_${name}`);
  if (!callbackBaseFrom(env)) missing.push('GATETEST_PUBLIC_BASE_URL');
  return missing;
}

function runtimeUnavailable(reason) {
  return { status: 'unavailable', reason, checked: false, jobId: null, pollUrl: null };
}

/**
 * Map a failed dispatch result to the customer-facing reason code. Only the
 * HTTP status crosses to the client; the dispatcher's descriptive `reason`
 * (platform name, remote body) stays in the server log.
 *
 * @param {{ok:false, reason?:string, status?:number}} result
 * @returns {string}
 */
function dispatchFailureReason(result) {
  if (result && Number.isInteger(result.status) && result.status > 0) {
    return `${DISPATCH_FAILED_PREFIX}${result.status}`;
  }
  if (result && /timed out/i.test(result.reason || '')) return `${DISPATCH_FAILED_PREFIX}timeout`;
  return `${DISPATCH_FAILED_PREFIX}network`;
}

/**
 * True when a queued job has outlived its deadline plus grace without a
 * callback — the poller then reports `callback-timeout` instead of spinning.
 *
 * @param {{queuedAtMs:number, nowMs?:number, deadlineSec?:number, graceSec?:number}} args
 * @returns {boolean}
 */
function callbackTimedOut({ queuedAtMs, nowMs = Date.now(), deadlineSec = RUNTIME_DEADLINE_SEC, graceSec = CALLBACK_GRACE_SEC }) {
  if (!Number.isFinite(queuedAtMs)) return false;
  return nowMs - queuedAtMs > (deadlineSec + graceSec) * 1000;
}

/**
 * Decide, dispatch (only when every prerequisite is present), and describe.
 * Never throws; never dispatches without token + secret + base URL.
 *
 * @param {Object} args
 * @param {string} args.scanId
 * @param {string} args.targetUrl
 * @param {'web'|'wp'} args.suite
 * @param {{headers?:Object, cookie?:string}} [args.auth]
 * @param {Record<string, string|undefined>} [args.env]   injected for tests
 * @param {Function} [args.fetchFn]                        injected for tests
 * @param {Function} [args.dispatch]                       injected for tests (default: vapron-dispatch)
 * @param {Function} [args.warn]                           injected for tests (default: console.warn)
 * @returns {Promise<{status:'unavailable'|'queued', reason:string|null, checked:false, jobId:string|null, pollUrl:string|null, timeoutSec?:number}>}
 */
async function gateRuntimeScan({ scanId, targetUrl, suite, auth, env = process.env, fetchFn, dispatch, warn = console.warn }) {
  const missing = missingRuntimePrerequisites(env);
  if (missing.length > 0) {
    warn(JSON.stringify({
      event: 'web-runtime-scan.not-dispatched',
      scanId,
      suite,
      reason: RUNTIME_REASONS.NOT_CONFIGURED,
      missing,
    }));
    return runtimeUnavailable(RUNTIME_REASONS.NOT_CONFIGURED);
  }

  // Lazy so the prerequisite check above never needs the dispatcher (or crypto).
  const dispatchFn = dispatch || require('./vapron-dispatch').dispatchRuntimeScan;
  let result;
  try {
    result = await dispatchFn({
      scanId,
      targetUrl,
      suite,
      callbackUrl: `${callbackBaseFrom(env)}/api/web/scan/runtime-callback`,
      deadlineSec: RUNTIME_DEADLINE_SEC,
      ...(auth ? { auth } : {}),
      deps: {
        baseUrl: platformEnv('BASE_URL', env),
        apiToken: platformEnv('API_TOKEN', env),
        dispatchSecret: platformEnv('DISPATCH_SECRET', env),
        ...(fetchFn ? { fetchFn } : {}),
      },
    });
  } catch (err) {
    result = { ok: false, reason: (err && err.message) || String(err) };
  }

  if (!result || result.ok !== true) {
    const reason = dispatchFailureReason(result || {});
    warn(JSON.stringify({
      event: 'web-runtime-scan.dispatch-failed',
      scanId,
      suite,
      reason,
      httpStatus: result && result.status ? result.status : null,
      detail: (result && result.reason) || null,
    }));
    return runtimeUnavailable(reason);
  }

  return {
    status: 'queued',
    reason: null,
    checked: false,
    jobId: result.jobId,
    pollUrl: `/api/web/scan/runtime-status?scanId=${encodeURIComponent(scanId)}`,
    timeoutSec: RUNTIME_DEADLINE_SEC + CALLBACK_GRACE_SEC,
  };
}

module.exports = {
  RUNTIME_REASONS,
  DISPATCH_FAILED_PREFIX,
  RUNTIME_DEADLINE_SEC,
  CALLBACK_GRACE_SEC,
  missingRuntimePrerequisites,
  dispatchFailureReason,
  callbackTimedOut,
  gateRuntimeScan,
};
