/**
 * The flake segment of the README badge (launch board move 6).
 *
 * The engine measures a repo's flake rate when it runs the repo's tests more
 * than once (src/core/flaky-ledger.js): flaky tests over the tests the last run
 * saw. It lands in a scan record as `flake` on the unit-test module's entry
 * (`{ measured, rate, flakyTests, tests, runs }`), or on that module's
 * `flake-ledger` check when the entry carries its checks.
 *
 * This file answers ONE question, for the badge route: what does the flake
 * segment say for this scan? Two honest answers only:
 *
 *   - a ledger exists   -> `flake 2.5%` (the measured number, never rounded to
 *     look better: 0.04 of a percent prints `flake <0.1%`, not `flake 0%`)
 *   - no ledger exists  -> `flake not measured` (Doctrine 1: a repo whose tests
 *     the engine never ran must not read as a repo with no flakes)
 *
 * Plain CommonJS so tests/ can require it without a TypeScript build.
 */

/** @param {unknown} v */
function isMeasured(v) {
  return Boolean(v) && typeof v === 'object' && v.measured === true
    && typeof v.rate === 'number' && Number.isFinite(v.rate) && v.rate >= 0 && v.rate <= 100;
}

/**
 * The ledger's flake summary from a scan's per-module results, or null.
 *
 * @param {unknown} results the `results` JSON of a completed scan
 * @returns {{ measured: true, rate: number, flakyTests?: number, tests?: number, runs?: number } | null}
 */
function flakeFromResults(results) {
  if (!Array.isArray(results)) return null;
  for (const entry of results) {
    if (!entry || typeof entry !== 'object') continue;
    if (isMeasured(entry.flake)) return entry.flake;
    if (Array.isArray(entry.checks)) {
      for (const check of entry.checks) {
        if (check && isMeasured(check.flake)) return check.flake;
      }
    }
  }
  return null;
}

/**
 * The badge segment: its text and whether it carries a measurement.
 *
 * @param {unknown} results
 * @returns {{ text: string, measured: boolean, rate: number | null }}
 */
function flakeSegment(results) {
  const flake = flakeFromResults(results);
  if (!flake) return { text: 'flake not measured', measured: false, rate: null };
  const rate = flake.rate;
  const shown = rate > 0 && rate < 0.1 ? '<0.1' : String(Math.round(rate * 10) / 10);
  return { text: `flake ${shown}%`, measured: true, rate };
}

module.exports = { flakeFromResults, flakeSegment };
