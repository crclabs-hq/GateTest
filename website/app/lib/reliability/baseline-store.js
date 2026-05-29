/**
 * Reliability — baseline store.
 *
 * Persists per-case baselines as JSON under
 * `reliability-corpus/baselines/<name>.json`. Each baseline captures
 * the full case result so the drift detector can compare against it
 * on subsequent runs.
 *
 * Lifecycle:
 *   1. New case lands in the corpus with `expected: {}` (no bounds).
 *   2. Operator runs `gatetest-reliability --capture-baselines`
 *      which writes the current result as the baseline.
 *   3. Subsequent runs compare against the baseline. Drift opens a
 *      PR for human review.
 *   4. When the human accepts the drift, they re-run with
 *      `--capture-baselines` to lock in the new shape.
 *
 * Pure logic over an injectable fs. No I/O when called with a mock.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const BASELINE_VERSION = 1;

/**
 * Build a baseline object from a CaseResult.
 *
 * Captures: name, category, tier, target, findings tally, summary
 * stats. Discards: durationMs (varies run-to-run), peakMemoryMb
 * (varies), deterministic (a transient check result).
 */
function buildBaseline({ caseResult, runMetadata = {} }) {
  if (!caseResult || !caseResult.name) {
    throw new TypeError("buildBaseline: caseResult.name required");
  }
  return {
    version: BASELINE_VERSION,
    name: caseResult.name,
    category: caseResult.category,
    tier: caseResult.tier,
    target: caseResult.target,
    url: caseResult.url || null,
    capturedAt: runMetadata.capturedAt || new Date().toISOString(),
    capturedBy: runMetadata.capturedBy || "unknown",
    capturedFrom: runMetadata.capturedFrom || null,
    findingsByModule: caseResult.findingsByModule || {},
    totals: caseResult.totals || { errors: 0, warnings: 0, info: 0 },
    passed: caseResult.passed,
    // Preserve evidence summary so future regressions can be
    // explained against the original observation.
    note: runMetadata.note || null,
  };
}

/**
 * Resolve the on-disk path for a case's baseline file.
 */
function baselinePath({ corpusRoot, caseName }) {
  if (!corpusRoot || !caseName) {
    throw new TypeError("baselinePath: corpusRoot + caseName required");
  }
  return path.join(corpusRoot, "baselines", `${caseName}.json`);
}

/**
 * Write a baseline atomically (write to tmp then rename).
 *
 * @returns { written: true, path } on success.
 */
function writeBaseline({ baseline, corpusRoot, _fs = fs }) {
  if (!baseline || !baseline.name) {
    throw new TypeError("writeBaseline: baseline.name required");
  }
  const dest = baselinePath({ corpusRoot, caseName: baseline.name });
  const dir = path.dirname(dest);
  if (!_fs.existsSync(dir)) {
    _fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = dest + ".tmp";
  _fs.writeFileSync(tmp, JSON.stringify(baseline, null, 2) + "\n");
  // Atomic rename when supported; fallback to write+unlink otherwise.
  if (typeof _fs.renameSync === "function") {
    _fs.renameSync(tmp, dest);
  } else {
    _fs.writeFileSync(dest, JSON.stringify(baseline, null, 2) + "\n");
    if (typeof _fs.unlinkSync === "function") _fs.unlinkSync(tmp);
  }
  return { written: true, path: dest };
}

/**
 * Read a stored baseline. Returns null if no file exists.
 */
function readBaseline({ corpusRoot, caseName, _fs = fs }) {
  const p = baselinePath({ corpusRoot, caseName });
  if (!_fs.existsSync(p)) return null;
  try {
    return JSON.parse(_fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Capture baselines for every case in a suite run. Returns a list of
 * results: written / unchanged / errored.
 */
function captureBaselines({
  suiteRun,
  corpusRoot,
  runMetadata = {},
  _fs = fs,
}) {
  if (!suiteRun || !Array.isArray(suiteRun.results)) {
    throw new TypeError("captureBaselines: suiteRun.results required");
  }
  const out = [];
  for (const caseResult of suiteRun.results) {
    try {
      const baseline = buildBaseline({ caseResult, runMetadata });
      const r = writeBaseline({ baseline, corpusRoot, _fs });
      out.push({ name: caseResult.name, status: "written", path: r.path });
    } catch (err) {
      out.push({
        name: caseResult && caseResult.name ? caseResult.name : "<unknown>",
        status: "errored",
        error: err.message || String(err),
      });
    }
  }
  return out;
}

/**
 * Compare a fresh CaseResult against its stored baseline. Returns
 * `{ status, drift: [...] }`:
 *   - status: "no-baseline" | "matches" | "drift"
 *   - drift:  array of human-readable difference descriptions
 */
function compareCaseToBaseline({ caseResult, corpusRoot, _fs = fs }) {
  const baseline = readBaseline({ corpusRoot, caseName: caseResult.name, _fs });
  if (!baseline) return { status: "no-baseline", drift: [] };

  const drift = [];

  // Pass / fail flip
  if (baseline.passed !== caseResult.passed) {
    drift.push(`passed flipped: was ${baseline.passed}, now ${caseResult.passed}`);
  }

  // Totals delta
  const bt = baseline.totals || {};
  const ct = caseResult.totals || {};
  for (const sev of ["errors", "warnings"]) {
    const delta = (ct[sev] || 0) - (bt[sev] || 0);
    if (delta !== 0) drift.push(`totals.${sev}: ${delta > 0 ? "+" : ""}${delta} (was ${bt[sev] || 0}, now ${ct[sev] || 0})`);
  }

  // Per-module delta
  const allMods = new Set([
    ...Object.keys(baseline.findingsByModule || {}),
    ...Object.keys(caseResult.findingsByModule || {}),
  ]);
  for (const mod of allMods) {
    const b = (baseline.findingsByModule || {})[mod] || { errors: 0, warnings: 0 };
    const c = (caseResult.findingsByModule || {})[mod] || { errors: 0, warnings: 0 };
    if ((b.errors || 0) !== (c.errors || 0)) {
      drift.push(`${mod}.errors: was ${b.errors || 0}, now ${c.errors || 0}`);
    }
    if ((b.warnings || 0) !== (c.warnings || 0)) {
      drift.push(`${mod}.warnings: was ${b.warnings || 0}, now ${c.warnings || 0}`);
    }
  }

  return { status: drift.length === 0 ? "matches" : "drift", drift, baseline };
}

module.exports = {
  buildBaseline,
  writeBaseline,
  readBaseline,
  captureBaselines,
  compareCaseToBaseline,
  baselinePath,
  BASELINE_VERSION,
};
