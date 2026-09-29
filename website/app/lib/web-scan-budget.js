'use strict';

/**
 * Wall-clock budget for the hosted JSON web scan (issue #768 item 1).
 *
 * The route declares `maxDuration = 60`, but the site runs `next start` on
 * the box behind Traefik, and `next start` does not enforce maxDuration at
 * all (that is a serverless-platform contract). Measured 2026-09-28: a scan
 * of a real site returned nothing in 240 s. The route therefore has to keep
 * its own clock: one deadline, every await that can hang raced against it,
 * and a 200 with `partial: true` when it fires — never a hang, never a 5xx
 * for a slow target. No proxy timeout is configured in docs/deploy (Traefik
 * defaults apply), so the budget sits under maxDuration instead.
 *
 * One definition (Doctrine #4): the route imports everything here; the
 * numbers and the wording of the budget reason are not restated anywhere.
 */

/** The route's `maxDuration`, in ms. The budget must stay below it. */
const ROUTE_MAX_DURATION_MS = 60_000;
/** Default budget: maxDuration minus 10 s to cluster, score, respond and be read by the proxy. */
const DEFAULT_WEB_SCAN_BUDGET_MS = 50_000;
/** Hard ceiling for the env override — never within 5 s of maxDuration. */
const MAX_WEB_SCAN_BUDGET_MS = ROUTE_MAX_DURATION_MS - 5_000;
/** Largest single-page fetch (matches live-scan-config / live-crawler defaults). */
const MAX_PER_PAGE_TIMEOUT_MS = 15_000;

/**
 * Budget in ms: `GATETEST_WEB_SCAN_BUDGET_MS` when it is a positive number
 * (capped under maxDuration), the default otherwise.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {number}
 */
function resolveWebScanBudgetMs(env = process.env) {
  const n = Number(env.GATETEST_WEB_SCAN_BUDGET_MS);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WEB_SCAN_BUDGET_MS;
  return Math.min(Math.floor(n), MAX_WEB_SCAN_BUDGET_MS);
}

/**
 * Per-page fetch timeout: strictly below the budget (a quarter of it, so one
 * dead page can never eat the whole budget), and never above the crawler's
 * own 15 s default.
 *
 * @param {number} budgetMs
 * @returns {number}
 */
function perPageTimeoutMs(budgetMs) {
  return Math.max(1, Math.min(MAX_PER_PAGE_TIMEOUT_MS, Math.floor(budgetMs / 4)));
}

function formatSeconds(ms) {
  return ms >= 1000 ? String(Math.round(ms / 1000)) : (ms / 1000).toFixed(1);
}

/** The not-checked reason for a module the budget cut off. */
function budgetExhaustedReason(budgetMs) {
  return `budget exhausted after ${formatSeconds(budgetMs)} s`;
}

/**
 * One deadline for one request. `raceOr` resolves to the promise's value, or
 * to `fallback` the moment the deadline fires — the abandoned promise keeps
 * running but nothing waits on it, and its rejection is swallowed here.
 *
 * @param {number} budgetMs
 * @returns {{
 *   budgetMs: number,
 *   readonly expired: boolean,
 *   remainingMs: () => number,
 *   raceOr: <T>(p: Promise<T>, fallback: T) => Promise<T>,
 *   dispose: () => void,
 * }}
 */
function createDeadline(budgetMs) {
  const startedAt = Date.now();
  let expired = false;
  let timer;
  const EXPIRED = Symbol('deadline');
  const expiry = new Promise((resolve) => {
    timer = setTimeout(() => { expired = true; resolve(EXPIRED); }, budgetMs);
  });
  return {
    budgetMs,
    get expired() { return expired; },
    // Once the timer has fired nothing remains, whatever the wall clock says:
    // setTimeout can fire a millisecond before Date.now() catches up, which
    // made `remainingMs()` read 1 right after expiry (flaky CI, PR #830).
    remainingMs() { return expired ? 0 : Math.max(0, budgetMs - (Date.now() - startedAt)); },
    async raceOr(promise, fallback) {
      const guarded = Promise.resolve(promise).catch((err) => { if (!expired) throw err; return fallback; });
      const winner = await Promise.race([guarded, expiry]);
      return winner === EXPIRED ? fallback : winner;
    },
    dispose() { clearTimeout(timer); },
  };
}

/**
 * The suite modules that produced no result before the budget ran out, as
 * the same `{module, reason}` shape `deriveModuleCoverage()` uses.
 *
 * @param {string[]} suiteModules
 * @param {Array<{module?: string, name?: string}>} results
 * @param {number} budgetMs
 * @returns {Array<{module: string, reason: string}>}
 */
function unfinishedModules(suiteModules, results, budgetMs) {
  const done = new Set((results || []).map((r) => r && (r.module || r.name)));
  const reason = budgetExhaustedReason(budgetMs);
  return (suiteModules || []).filter((m) => !done.has(m)).map((module) => ({ module, reason }));
}

/**
 * Coverage for a partial scan: the denominator is the whole suite (the
 * modules that never ran are not-checked, not absent). Never used for a
 * complete scan, whose coverage stays exactly what deriveModuleCoverage said.
 *
 * @param {{totalModules: number, checkedModules: number, notChecked: Array<{module: string, reason: string}>}} coverage
 * @param {Array<{module: string, reason: string}>} unfinished
 * @param {number} suiteSize
 */
function partialCoverage(coverage, unfinished, suiteSize) {
  const notChecked = [...coverage.notChecked, ...unfinished];
  const totalModules = Math.max(suiteSize, coverage.totalModules + unfinished.length);
  return { totalModules, checkedModules: Math.max(0, totalModules - notChecked.length), notChecked };
}

/**
 * The customer-facing sentence of a partial response, with the streaming
 * route named — that route reports each module as it finishes and is the
 * answer when a crawl legitimately needs longer than the budget.
 *
 * @param {number} budgetMs
 * @param {string} streamUrl
 */
function partialNote(budgetMs, streamUrl) {
  return `The scan stopped at its ${formatSeconds(budgetMs)} s time budget; the modules that finished are included and the rest are listed as not checked. ` +
    `For a full crawl of a slow site, POST the same body to ${streamUrl} (streams each module as it completes).`;
}

module.exports = {
  ROUTE_MAX_DURATION_MS,
  DEFAULT_WEB_SCAN_BUDGET_MS,
  MAX_WEB_SCAN_BUDGET_MS,
  resolveWebScanBudgetMs,
  perPageTimeoutMs,
  budgetExhaustedReason,
  createDeadline,
  unfinishedModules,
  partialCoverage,
  partialNote,
};
