'use strict';
/**
 * Noise model — turns the flywheel's per-module history into (a) confidence
 * penalties the runner applies automatically and (b) a ranked "what's noisy"
 * report for `gatetest --noise`.
 *
 * Signal sources (both read defensively, never written here):
 *   - .gatetest/memory.json (persistent-memory): per-module runs / fires /
 *     fireRate / suppressions across all scans.
 *   - .gatetest/memory/false-positives.json (memory store): per-finding
 *     dismissals keyed "module:rule:file:line".
 *
 * A module earns a penalty when it fires often AND is dismissed repeatedly —
 * i.e. the team keeps telling us it's noise. The penalty multiplies the
 * finding's confidence so a chronically-noisy module drops below the 0.7 block
 * threshold (still reported, no longer blocking) until the pattern changes.
 *
 * Pure-ish: only file reads, no writes, never throws.
 */

const fs = require('fs');
const path = require('path');

let persistentMemory = null;
try { persistentMemory = require('./persistent-memory'); } catch { /* optional */ } // error-ok

// Tuning. A module needs at least MIN_RUNS of history and MIN_DISMISSALS of
// "this is noise" before we soften it — we never penalise on thin evidence.
const MIN_RUNS = 3;
const MIN_DISMISSALS = 3;
const HIGH_FIRE_RATE = 0.5;
const PENALTY_FLOOR = 0.5; // strongest softening (0.5 * confidence)

function _readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch { return fallback; }
}

/**
 * Count false-positive dismissals per module from false-positives.json.
 * Keys look like "module:rule:file:line" — we take the segment before the
 * first colon as the module.
 * @returns {Record<string, number>}
 */
function _dismissalsByModule(projectRoot) {
  const fps = _readJson(path.join(projectRoot, '.gatetest', 'memory', 'false-positives.json'), {});
  const counts = {};
  for (const key of Object.keys(fps || {})) {
    const mod = String(key).split(':')[0];
    if (!mod) continue;
    counts[mod] = (counts[mod] || 0) + 1;
  }
  return counts;
}

/**
 * Build the per-module noise view: runs, fires, fireRate, dismissals, penalty.
 * @param {string} projectRoot
 * @returns {Array<{module,runs,fires,fireRate,dismissals,penalty,noisy}>}
 */
function getNoiseReport(projectRoot) {
  const root = projectRoot || process.cwd();
  const mem = persistentMemory ? safeLoad(root) : { modules: {} };
  const dismissals = _dismissalsByModule(root);

  const names = new Set([
    ...Object.keys((mem && mem.modules) || {}),
    ...Object.keys(dismissals),
  ]);

  const rows = [];
  for (const module of names) {
    const s = (mem.modules && mem.modules[module]) || { runs: 0, fires: 0, fireRate: 0, suppressions: 0 };
    const dismissCount = Math.max(dismissals[module] || 0, s.suppressions || 0);
    const penalty = _penaltyFor(s, dismissCount);
    rows.push({
      module,
      runs: s.runs || 0,
      fires: s.fires || 0,
      fireRate: s.fireRate || 0,
      dismissals: dismissCount,
      penalty,
      noisy: penalty < 1,
    });
  }

  // Rank: penalised modules first (strongest penalty), then by fireRate.
  rows.sort((a, b) => (a.penalty - b.penalty) || (b.fireRate - a.fireRate) || (b.dismissals - a.dismissals));
  return rows;
}

function _penaltyFor(stats, dismissCount) {
  const runs = stats.runs || 0;
  const fireRate = stats.fireRate || 0;
  if (runs < MIN_RUNS) return 1;
  if (dismissCount < MIN_DISMISSALS) return 1;
  if (fireRate < HIGH_FIRE_RATE) return 1;
  // More dismissals → stronger softening, floored. 3 → ~0.8, 10+ → 0.5.
  const scaled = 1 - Math.min(0.5, (dismissCount - MIN_DISMISSALS + 3) * 0.05);
  return Math.max(PENALTY_FLOOR, Number(scaled.toFixed(3)));
}

/**
 * Per-module confidence multipliers for the runner. Only includes modules
 * that actually earned a penalty (< 1), so the runner map stays small.
 * @param {string} projectRoot
 * @returns {Record<string, number>}
 */
function computePenalties(projectRoot) {
  const penalties = {};
  for (const row of getNoiseReport(projectRoot)) {
    if (row.penalty < 1) penalties[row.module] = row.penalty;
  }
  return penalties;
}

function safeLoad(root) {
  try { return persistentMemory.load(root) || { modules: {} }; }
  catch { return { modules: {} }; }
}

module.exports = { computePenalties, getNoiseReport, MIN_RUNS, MIN_DISMISSALS };
