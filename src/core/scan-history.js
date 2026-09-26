'use strict';

/**
 * Scan history — the ETA line's memory (move 4, the time-to-verdict
 * contract). Every run appends its per-module wall-clock time (and the
 * file count it ran against) to `.gatetest/reports/scan-history.json`, so
 * `scan-eta.js` can learn a real ms-per-file coefficient per module instead
 * of guessing from a static table forever. One definition (Doctrine #4):
 * every reader and writer of this file goes through here.
 *
 * Best-effort, always. A corrupt or missing history file must never break a
 * scan — it just means the ETA falls back to the static default table and
 * prints a range instead of a point estimate (the "thin history" case).
 *
 * Filename note: `src/reporters/html-reporter.js` ALREADY writes
 * `.gatetest/reports/scan-history.json` — an ARRAY of past run summaries
 * with no per-module timing, unconditionally attached on every scan
 * (src/index.js). Reusing that exact path for this file's different
 * (object-shaped, per-module) schema crashed it on the very next scan
 * (`history.push is not a function` — html-reporter.js read this file's
 * object back as its own array). Doctrine #4 is "one definition" for a
 * given piece of data, not "one filename" for two different ones — this
 * gets its own path, `scan-eta-history.json`, alongside it.
 */

const fs = require('fs');
const path = require('path');

const HISTORY_REL_PATH = path.join('.gatetest', 'reports', 'scan-eta-history.json');

// A module that gets renamed or removed should not accumulate forever —
// bound the number of distinct module keys the file can hold.
const MAX_MODULES = 200;

function historyPath(projectRoot) {
  return path.join(projectRoot, HISTORY_REL_PATH);
}

function emptyHistory() {
  return { totalRuns: 0, modules: {} };
}

/**
 * @param {string} projectRoot
 * @returns {{ totalRuns: number, modules: Object<string, {count:number, totalMs:number, totalFiles:number}> }}
 */
function loadHistory(projectRoot) {
  try {
    const raw = fs.readFileSync(historyPath(projectRoot), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.modules !== 'object' || parsed.modules === null) {
      return emptyHistory();
    }
    return {
      totalRuns: Number.isFinite(parsed.totalRuns) ? parsed.totalRuns : 0,
      modules: parsed.modules,
    };
  } catch {
    return emptyHistory(); // missing file, first run ever, or a corrupt one — same fallback
  }
}

/**
 * Record one completed run's per-module timings. Never throws — a failure
 * here (read-only filesystem, disk full) must not affect the scan that just
 * finished.
 *
 * @param {string} projectRoot
 * @param {{ fileCount: number, results: Array<{module:string, duration:number}> }} run
 */
function recordRun(projectRoot, { fileCount, results } = {}) {
  try {
    if (!projectRoot || !Array.isArray(results) || results.length === 0) return;
    const history = loadHistory(projectRoot);
    history.totalRuns = (history.totalRuns || 0) + 1;
    const files = Number.isFinite(fileCount) && fileCount > 0 ? fileCount : 0;

    for (const r of results) {
      if (!r || typeof r.module !== 'string' || typeof r.duration !== 'number' || r.duration < 0) continue;
      const entry = history.modules[r.module] || { count: 0, totalMs: 0, totalFiles: 0 };
      entry.count += 1;
      entry.totalMs += r.duration;
      entry.totalFiles += files;
      history.modules[r.module] = entry;
    }

    const keys = Object.keys(history.modules);
    if (keys.length > MAX_MODULES) {
      // Drop the oldest-inserted entries first (object key order is
      // insertion order in V8) rather than an arbitrary slice of a Set.
      for (const k of keys.slice(0, keys.length - MAX_MODULES)) delete history.modules[k];
    }

    const dir = path.dirname(historyPath(projectRoot));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(historyPath(projectRoot), JSON.stringify(history, null, 2));
  } catch {
    // error-ok — history is an optimisation for next run's ETA, never a
    // reason to fail or even warn about the scan that just completed.
  }
}

module.exports = { loadHistory, recordRun, historyPath, HISTORY_REL_PATH };
