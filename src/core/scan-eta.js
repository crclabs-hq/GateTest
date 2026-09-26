'use strict';

/**
 * ETA estimation (move 4, the time-to-verdict contract).
 *
 * Complaint C2: gates whose duration cannot be predicted get abandoned
 * (CodeQL 3-10 min per 100K LOC, 45-min PR scans; GateTest's own #630 quick
 * suite ran >10 min on a 76-package monorepo with no warning). Per-module
 * elapsed prints (#650) and a typescript-strict budget cut both help AFTER
 * a scan starts; neither tells the user up front what to expect.
 *
 * The model: fileCount × a per-module coefficient (ms/file), summed across
 * the suite's modules. The coefficient is learned from
 * `src/core/scan-history.js` once a module has run at least once on this
 * repo; a static default table covers the very first run. History always
 * wins per module the moment it has a sample — the static table is a
 * cold-start fallback, never a ceiling on it.
 *
 * Honesty (Doctrine #1): fewer than MIN_SAMPLES_FOR_POINT_ESTIMATE modules
 * with real history yields a RANGE (`~40-90 s`), not a point value. A single
 * confident number backed by zero measurement is the "reports success while
 * doing nothing" failure shape wearing a stopwatch.
 */

// ms/file, cold start only. Heavy modules cost far more per file than a
// lint-style pass; anything not listed falls back to DEFAULT_MS_PER_FILE.
// Replaced by measured history the first time a module actually runs here.
const STATIC_DEFAULT_MS_PER_FILE = {
  unitTests: 8,
  integrationTests: 12,
  typescriptStrictness: 4,
  e2e: 40,
  visual: 35,
  chaos: 25,
  mutation: 200,
  accessibility: 6,
  performance: 10,
  security: 3,
  spineHealth: 2,
  importCycle: 2,
  crossFileTaint: 3,
  dataIntegrity: 3,
};
const DEFAULT_MS_PER_FILE = 0.8;

// A module needs at least this many recorded runs, across at least this
// fraction of the suite's modules, before the estimate is a point value
// rather than a range.
const MIN_SAMPLES_FOR_POINT_ESTIMATE = 3;

// Every module costs something just to start (require, read its own
// config) even on a zero-file repo — never estimate zero.
const MIN_MODULE_MS = 25;

/**
 * @param {string} moduleName
 * @param {{modules: object}} history
 * @returns {{ msPerFile: number, flatMs?: number, samples: number, fromHistory: boolean }}
 */
function coefficientFor(moduleName, history) {
  const h = history && history.modules && history.modules[moduleName];
  if (h && h.count > 0 && h.totalFiles > 0) {
    return { msPerFile: h.totalMs / h.totalFiles, samples: h.count, fromHistory: true };
  }
  if (h && h.count > 0) {
    // File-count-independent module (fileCount was 0 on every past run, or
    // the module's cost genuinely doesn't scale with file count) — use the
    // observed flat per-run cost instead of dividing by zero.
    return { msPerFile: 0, flatMs: h.totalMs / h.count, samples: h.count, fromHistory: true };
  }
  const fallback = Object.prototype.hasOwnProperty.call(STATIC_DEFAULT_MS_PER_FILE, moduleName)
    ? STATIC_DEFAULT_MS_PER_FILE[moduleName]
    : DEFAULT_MS_PER_FILE;
  return { msPerFile: fallback, samples: 0, fromHistory: false };
}

/**
 * @param {object} opts
 * @param {number} opts.fileCount
 * @param {string[]} opts.modules
 * @param {object} [opts.history] — from scan-history.loadHistory()
 * @param {boolean} [opts.parallel]
 * @returns {{ ms: number, lowMs: number, highMs: number, thin: boolean, sampledModules: number }}
 */
function estimateScanMs({ fileCount, modules, history, parallel }) {
  const files = Number.isFinite(fileCount) && fileCount > 0 ? fileCount : 0;
  const list = Array.isArray(modules) ? modules : [];
  let sampledModules = 0;

  const perModuleMs = list.map((name) => {
    const c = coefficientFor(name, history);
    if (c.samples > 0) sampledModules += 1;
    const ms = typeof c.flatMs === 'number' ? c.flatMs : c.msPerFile * files;
    return Math.max(MIN_MODULE_MS, ms);
  });

  const sum = perModuleMs.reduce((a, b) => a + b, 0);
  const max = perModuleMs.reduce((a, b) => Math.max(a, b), 0);
  // A parallel run's wall clock tracks its slowest module, not the sum of
  // all of them — but real concurrency is bounded by CPU/IO, not infinite,
  // so this is a heuristic (a quarter of the sequential sum, floored at the
  // single slowest module), never a promise of measured speedup.
  const ms = parallel ? Math.max(max, sum / 4) : sum;

  const thin = list.length === 0
    || sampledModules < Math.min(MIN_SAMPLES_FOR_POINT_ESTIMATE, list.length);

  return {
    ms: Math.round(ms),
    lowMs: Math.round(ms * 0.5),
    highMs: Math.round(ms * 1.5),
    thin,
    sampledModules,
  };
}

function formatSeconds(ms) {
  const s = ms / 1000;
  return s >= 10 ? `${Math.round(s)}` : s.toFixed(1);
}

/** Render an estimate the way the ETA line prints it: a range when thin, a point otherwise. */
function formatEta(estimate) {
  if (!estimate) return 'unknown';
  if (estimate.thin) return `~${formatSeconds(estimate.lowMs)}-${formatSeconds(estimate.highMs)} s`;
  return `~${formatSeconds(estimate.ms)} s`;
}

module.exports = {
  estimateScanMs,
  formatEta,
  coefficientFor,
  STATIC_DEFAULT_MS_PER_FILE,
  DEFAULT_MS_PER_FILE,
  MIN_SAMPLES_FOR_POINT_ESTIMATE,
  MIN_MODULE_MS,
};
