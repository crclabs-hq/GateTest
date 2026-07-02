/**
 * Reliability — drift detector.
 *
 * Compares the latest suite run against a baseline (a previous run we've
 * accepted as the source of truth) and emits a structured drift report:
 *
 *   {
 *     summary: {
 *       baselineRunId, latestRunId,
 *       casesAdded, casesRemoved,
 *       newlyFailing, newlyPassing,
 *       findingsDelta: { errors, warnings },
 *       performanceDelta: { medianMs, p95Ms },
 *     },
 *     regressions: [...],      // cases that were passing, now failing
 *     fixes:       [...],      // cases that were failing, now passing
 *     unchanged:   [...],      // same outcome both runs
 *     newCases:    [...],      // cases only in latest
 *     removedCases:[...],      // cases only in baseline
 *   }
 *
 * The nightly workflow opens a PR when `regressions.length > 0` so a
 * human can decide: real bug we ship a fix for, or expected drift we
 * accept by updating the baseline.
 *
 * Pure logic — given two suite-run JSON blobs, produce a diff. No I/O.
 */

"use strict";

function indexByName(suiteRun) {
  const out = new Map();
  for (const r of (suiteRun && suiteRun.results) || []) {
    if (r && r.name) out.set(r.name, r);
  }
  return out;
}

function median(nums) {
  if (!nums.length) return 0;
  const sorted = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(nums, p) {
  if (!nums.length) return 0;
  const sorted = nums.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function summariseDurations(results) {
  const durations = results.filter((r) => typeof r.durationMs === "number").map((r) => r.durationMs);
  return {
    medianMs: median(durations),
    p95Ms: percentile(durations, 95),
    maxMs: durations.length ? Math.max(...durations) : 0,
  };
}

/**
 * Detect drift between baseline and latest suite runs.
 *
 * @param {object} args
 * @param {object} args.baseline   suiteRun JSON from prior nightly
 * @param {object} args.latest     suiteRun JSON from current nightly
 * @returns {object}               drift report
 */
function detectDrift({ baseline, latest }) {
  const baseIdx = indexByName(baseline || { results: [] });
  const latestIdx = indexByName(latest || { results: [] });

  const baseNames = new Set(baseIdx.keys());
  const latestNames = new Set(latestIdx.keys());

  const newCases = [];
  const removedCases = [];
  const regressions = [];
  const fixes = [];
  const unchanged = [];

  for (const name of latestNames) {
    if (!baseNames.has(name)) {
      newCases.push(name);
      continue;
    }
    const base = baseIdx.get(name);
    const lat = latestIdx.get(name);
    if (base.passed === false && lat.passed === true) {
      fixes.push({ name, baselineIssues: base.issues, latestIssues: [] });
    } else if (base.passed === true && lat.passed === false) {
      regressions.push({ name, latestIssues: lat.issues, baselineIssues: [] });
    } else {
      unchanged.push(name);
    }
  }
  for (const name of baseNames) {
    if (!latestNames.has(name)) removedCases.push(name);
  }

  // Findings delta — sums across all cases. We use this to spot the
  // "we added a noisy module" or "we silently lost a rule" pattern.
  const sumTotals = (run) => {
    let errs = 0, warns = 0;
    for (const r of (run && run.results) || []) {
      if (r && r.totals) {
        errs += r.totals.errors || 0;
        warns += r.totals.warnings || 0;
      }
    }
    return { errors: errs, warnings: warns };
  };
  const baseTotals = sumTotals(baseline);
  const latestTotals = sumTotals(latest);

  const basePerf = summariseDurations((baseline && baseline.results) || []);
  const latPerf = summariseDurations((latest && latest.results) || []);

  return {
    summary: {
      baselineRunId: baseline?.runId || null,
      latestRunId: latest?.runId || null,
      casesAdded: newCases.length,
      casesRemoved: removedCases.length,
      newlyFailing: regressions.length,
      newlyPassing: fixes.length,
      unchanged: unchanged.length,
      findingsDelta: {
        errors: latestTotals.errors - baseTotals.errors,
        warnings: latestTotals.warnings - baseTotals.warnings,
      },
      performanceDelta: {
        medianMs: latPerf.medianMs - basePerf.medianMs,
        p95Ms: latPerf.p95Ms - basePerf.p95Ms,
        maxMs: latPerf.maxMs - basePerf.maxMs,
      },
    },
    regressions,
    fixes,
    unchanged,
    newCases,
    removedCases,
  };
}

/**
 * Render a drift report as customer-facing markdown — suitable for a
 * nightly-run PR description.
 */
function renderDriftReport(drift) {
  const lines = [];
  lines.push("## GateTest reliability — nightly drift report");
  lines.push("");
  const s = drift.summary;
  lines.push("| Metric | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Cases added | ${s.casesAdded} |`);
  lines.push(`| Cases removed | ${s.casesRemoved} |`);
  lines.push(`| Newly failing | ${s.newlyFailing} |`);
  lines.push(`| Newly passing | ${s.newlyPassing} |`);
  lines.push(`| Unchanged | ${s.unchanged} |`);
  lines.push(`| Findings delta (errors) | ${s.findingsDelta.errors >= 0 ? "+" : ""}${s.findingsDelta.errors} |`);
  lines.push(`| Findings delta (warnings) | ${s.findingsDelta.warnings >= 0 ? "+" : ""}${s.findingsDelta.warnings} |`);
  lines.push(`| Median scan time Δ | ${s.performanceDelta.medianMs >= 0 ? "+" : ""}${s.performanceDelta.medianMs.toFixed(0)}ms |`);
  lines.push(`| p95 scan time Δ | ${s.performanceDelta.p95Ms >= 0 ? "+" : ""}${s.performanceDelta.p95Ms.toFixed(0)}ms |`);
  lines.push("");

  if (drift.regressions.length > 0) {
    lines.push(`### ⚠️ Regressions (${drift.regressions.length})`);
    lines.push("");
    for (const r of drift.regressions) {
      lines.push(`- **${r.name}**`);
      for (const issue of r.latestIssues || []) lines.push(`  - ${issue}`);
    }
    lines.push("");
  }
  if (drift.fixes.length > 0) {
    lines.push(`### ✅ Fixed (${drift.fixes.length})`);
    lines.push("");
    for (const f of drift.fixes) lines.push(`- **${f.name}**`);
    lines.push("");
  }
  if (drift.newCases.length > 0) {
    lines.push(`### ➕ New cases (${drift.newCases.length})`);
    lines.push("");
    for (const n of drift.newCases) lines.push(`- ${n}`);
    lines.push("");
  }
  if (drift.removedCases.length > 0) {
    lines.push(`### ➖ Removed cases (${drift.removedCases.length})`);
    lines.push("");
    for (const n of drift.removedCases) lines.push(`- ${n}`);
    lines.push("");
  }

  return lines.join("\n");
}

module.exports = {
  detectDrift,
  renderDriftReport,
  median,
  percentile,
};
