'use strict';
/**
 * Persistent Per-Repo Memory — GateTest's learning layer.
 *
 * Every scan writes to `.gatetest/memory.json`. Over time the file
 * accumulates knowledge about THIS specific codebase:
 *
 *   - Which modules fire often (upweight them in smart suite selection)
 *   - Which findings the team consistently suppresses (mark as low-signal)
 *   - Which fix types get merged vs. rejected (tune confidence auto-merge)
 *   - Recurring bug patterns (surface in the developer digest)
 *   - Code quality trend (issues introduced vs. fixed across scans)
 *
 * After 10 scans GateTest knows your codebase better than a new engineer
 * who just joined. After 50 scans it knows it better than most seniors.
 * This is the compounding moat — every scan makes every future scan smarter.
 *
 * The file is committed to the repo (.gatetest/memory.json). Teams share
 * the learning. A new team member gets the institutional knowledge for free.
 */

const fs   = require('fs');
const path = require('path');

const MEMORY_DIR      = '.gatetest';
const MEMORY_FILENAME = 'memory.json';
const SCHEMA_VERSION  = 2;

// How many scan records to keep (rolling window for trend analysis)
const MAX_SCAN_HISTORY = 100;

// ── Default schema ────────────────────────────────────────────────────────────

function createEmpty(projectRoot) {
  return {
    version:    SCHEMA_VERSION,
    projectRoot,
    createdAt:  new Date().toISOString(),
    updatedAt:  new Date().toISOString(),
    scanCount:  0,

    // Per-module stats across all scans
    modules: {},
    // { moduleName: { runs: N, fires: N, suppressions: N, fireRate: 0.0 } }

    // Fix feedback — which fix types the team accepts
    fixes: {},
    // { ruleKey: { attempts: N, merges: N, rejections: N, acceptRate: 0.0 } }

    // Recurring patterns — same bug showing up repeatedly
    patterns: [],
    // [{ description: string, module: string, occurrences: N, firstSeen: ISO, lastSeen: ISO }]

    // Code quality trend — rolling window of (introduced, fixed) pairs
    qualityTrend: [],
    // [{ date: ISO, introduced: N, fixed: N, netDelta: N, totalIssues: N }]

    // Scan history (capped at MAX_SCAN_HISTORY)
    scans: [],
    // [{ date, duration, modules, totalIssues, filesChanged, suite }]

    // Team suppressions — patterns developers consistently mark as noise
    suppressions: {},
    // { "module:ruleKey": { count: N, pattern: string } }
  };
}

// ── I/O helpers ───────────────────────────────────────────────────────────────

/**
 * Load the memory file. Returns the default schema if absent or corrupted.
 * Never throws.
 */
function load(projectRoot) {
  const filePath = path.join(projectRoot, MEMORY_DIR, MEMORY_FILENAME);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    // Migrate if schema version is old
    if (!parsed.version || parsed.version < SCHEMA_VERSION) {
      return Object.assign(createEmpty(projectRoot), parsed, { version: SCHEMA_VERSION });
    }
    return parsed;
  } catch {
    return createEmpty(projectRoot);
  }
}

/**
 * Save the memory file. Creates .gatetest/ if needed. Never throws.
 */
function save(projectRoot, data) {
  const dir      = path.join(projectRoot, MEMORY_DIR);
  const filePath = path.join(dir, MEMORY_FILENAME);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    data.updatedAt = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch { // error-ok — memory write is best-effort; never block a scan
  }
}

// ── Update helpers ────────────────────────────────────────────────────────────

/**
 * Record a completed scan.
 *
 * @param {string}   projectRoot
 * @param {object}   scanResult         — { modules, totalIssues, duration, suite }
 * @param {string[]} [changedFiles]      — files that were part of a smart diff
 */
function recordScan(projectRoot, scanResult, changedFiles = []) {
  const data = load(projectRoot);
  data.scanCount++;

  // Update per-module stats
  for (const mod of (scanResult.modules || [])) {
    const name  = mod.name || mod;
    const fired = (mod.status === 'failed') || (mod.errors > 0) || (mod.warnings > 0);

    if (!data.modules[name]) {
      data.modules[name] = { runs: 0, fires: 0, suppressions: 0, fireRate: 0 };
    }
    const s = data.modules[name];
    s.runs++;
    if (fired) s.fires++;
    s.fireRate = s.runs > 0 ? +(s.fires / s.runs).toFixed(3) : 0;
  }

  // Record quality trend entry
  const introduced = (scanResult.introduced != null) ? scanResult.introduced : 0;
  const fixed      = (scanResult.fixed != null) ? scanResult.fixed : 0;
  data.qualityTrend.push({
    date:        new Date().toISOString(),
    introduced,
    fixed,
    netDelta:    introduced - fixed,
    totalIssues: scanResult.totalIssues || 0,
  });
  // Keep trend manageable
  if (data.qualityTrend.length > MAX_SCAN_HISTORY) {
    data.qualityTrend = data.qualityTrend.slice(-MAX_SCAN_HISTORY);
  }

  // Record scan summary (rolling cap)
  data.scans.push({
    date:         new Date().toISOString(),
    duration:     scanResult.duration || 0,
    modules:      (scanResult.modules || []).length,
    totalIssues:  scanResult.totalIssues || 0,
    filesChanged: changedFiles.length,
    suite:        scanResult.suite || 'unknown',
  });
  if (data.scans.length > MAX_SCAN_HISTORY) {
    data.scans = data.scans.slice(-MAX_SCAN_HISTORY);
  }

  // Detect recurring patterns: any module that has fired in ≥80% of the
  // last 10 scans gets flagged as a recurring pattern.
  _updateRecurringPatterns(data);

  save(projectRoot, data);
}

/**
 * Record fix feedback (merge = accepted, reject = declined).
 *
 * @param {string}  projectRoot
 * @param {string}  ruleKey
 * @param {boolean} accepted
 */
function recordFixFeedback(projectRoot, ruleKey, accepted) {
  const data = load(projectRoot);
  if (!data.fixes[ruleKey]) {
    data.fixes[ruleKey] = { attempts: 0, merges: 0, rejections: 0, acceptRate: 0 };
  }
  const f = data.fixes[ruleKey];
  f.attempts++;
  if (accepted) f.merges++; else f.rejections++;
  f.acceptRate = f.attempts > 0 ? +(f.merges / f.attempts).toFixed(3) : 0;
  save(projectRoot, data);
}

/**
 * Record a team suppression (developer marked a finding as noise).
 *
 * @param {string} projectRoot
 * @param {string} module
 * @param {string} ruleKey
 * @param {string} [pattern]  — the actual finding text / pattern
 */
function recordSuppression(projectRoot, module, ruleKey, pattern = '') {
  const data = load(projectRoot);
  const key = `${module}:${ruleKey}`;
  if (!data.suppressions[key]) {
    data.suppressions[key] = { count: 0, pattern };
  }
  data.suppressions[key].count++;
  if (pattern) data.suppressions[key].pattern = pattern;
  if (data.modules[module]) data.modules[module].suppressions++;
  save(projectRoot, data);
}

// ── Smart suite integration ───────────────────────────────────────────────────

/**
 * Compute memory-based module weight boosts for the smart suite selector.
 * Modules that fire often for this repo get upweighted so they always
 * appear in the smart suite even when the diff doesn't directly suggest them.
 *
 * @param {string} projectRoot
 * @returns {object}  — { moduleName: boostWeight } for modules with fireRate > 0.4
 */
function getSmartSuiteBoosts(projectRoot) {
  const data = load(projectRoot);
  const boosts = {};

  for (const [name, stats] of Object.entries(data.modules || {})) {
    if (stats.runs < 3) continue; // need enough data to be meaningful
    // Modules firing in >40% of scans get a 1-point boost
    // Modules firing in >70% of scans get a 3-point boost (always show up)
    if (stats.fireRate >= 0.70) boosts[name] = 3;
    else if (stats.fireRate >= 0.40) boosts[name] = 1;
  }

  return boosts;
}

/**
 * Get confidence adjustment for a fix, based on historical acceptance rate.
 * If a fix type has been rejected >60% of the time, reduce its auto-merge
 * eligibility by returning a penalty multiplier < 1.
 *
 * @param {string} projectRoot
 * @param {string} ruleKey
 * @returns {number}  — multiplier in [0.5, 1.0]; 1.0 = no adjustment
 */
function getFixConfidenceMultiplier(projectRoot, ruleKey) {
  const data = load(projectRoot);
  const f = data.fixes[ruleKey];
  if (!f || f.attempts < 3) return 1.0; // not enough data — trust the base confidence

  // If accepted ≥ 70% of the time, slight upboost
  if (f.acceptRate >= 0.70) return 1.05;
  // If rejected > 60% of the time, apply penalty
  if (f.acceptRate < 0.40) return 0.60;
  if (f.acceptRate < 0.55) return 0.80;
  return 1.0;
}

/**
 * Get the developer quality trend summary (for digest/dashboard).
 *
 * @param {string} projectRoot
 * @param {number} [windowDays] — look-back window in days (default 7)
 * @returns {{ trend: string, netDelta: number, scansInWindow: number, topModule: string|null }}
 */
function getQualityTrend(projectRoot, windowDays = 7) {
  const data = load(projectRoot);
  const cutoff = new Date(Date.now() - windowDays * 86400_000).toISOString();

  const recent = (data.qualityTrend || []).filter(e => e.date >= cutoff);
  if (recent.length === 0) return { trend: 'insufficient-data', netDelta: 0, scansInWindow: 0, topModule: null };

  const netDelta = recent.reduce((s, e) => s + e.netDelta, 0);

  // Top firing module across all time
  let topModule = null;
  let topRate   = 0;
  for (const [name, stats] of Object.entries(data.modules || {})) {
    if (stats.runs >= 3 && stats.fireRate > topRate) {
      topRate   = stats.fireRate;
      topModule = name;
    }
  }

  const trend = netDelta < -5 ? 'improving' : netDelta > 5 ? 'declining' : 'stable';
  return { trend, netDelta, scansInWindow: recent.length, topModule };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _updateRecurringPatterns(data) {
  const newPatterns = [];
  const recent10 = data.scans.slice(-10);
  if (recent10.length < 5) return; // need enough history

  for (const [name, stats] of Object.entries(data.modules || {})) {
    if (stats.runs < 5) continue;
    if (stats.fireRate < 0.80) continue;

    const existing = (data.patterns || []).find(p => p.module === name);
    if (existing) {
      existing.occurrences = stats.fires;
      existing.lastSeen    = new Date().toISOString();
    } else {
      newPatterns.push({
        description: `${name} fires in ${Math.round(stats.fireRate * 100)}% of scans`,
        module:      name,
        occurrences: stats.fires,
        firstSeen:   new Date().toISOString(),
        lastSeen:    new Date().toISOString(),
      });
    }
  }

  if (newPatterns.length > 0) {
    data.patterns = [...(data.patterns || []), ...newPatterns].slice(-50);
  }
}

module.exports = {
  load,
  save,
  recordScan,
  recordFixFeedback,
  recordSuppression,
  getSmartSuiteBoosts,
  getFixConfidenceMultiplier,
  getQualityTrend,
};
