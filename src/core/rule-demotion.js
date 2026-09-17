'use strict';
/**
 * Applies field-measured demotions (the Fifty, move 08) to a finding's
 * severity: a rule the field has silenced more than 20% of the time, with
 * enough findings to trust that rate, ships as a warning instead of an
 * error. One definition, imported once — src/core/runner.js's `addCheck`,
 * the single place every module's severity is finalised.
 *
 * The demotion list itself is generated data, not authored here:
 * data/rule-demotions.json, produced by scripts/generate-rule-demotions.js
 * from a noise snapshot aggregated by website/app/lib/rule-noise.js (the
 * same maths /api/noise publishes). Loading is defensive — a missing,
 * empty, or malformed file means zero demotions, never a thrown error
 * blocking a scan (Forbidden #1: never ship code that fails silently in
 * the OTHER direction either — a demotion bug must not become a hang).
 *
 * Demoted findings are never hidden: they still appear as warnings, and
 * the finding itself carries `demotedBy` (from/to/reason/silencedRate/
 * sampleSize) so a report can say exactly why it isn't blocking.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_PATH = path.join(__dirname, '..', '..', 'data', 'rule-demotions.json');

let _cache = null;
let _cachedPath = null;

function _load(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    const demotions = (data && typeof data === 'object' && data.demotions && typeof data.demotions === 'object')
      ? data.demotions
      : {};
    return {
      demotions,
      generatedAt: (data && data.generatedAt) || null,
      status: (data && data.status) || 'ok',
    };
  } catch {
    // Missing file (nothing generated yet), unreadable, or malformed JSON —
    // all three mean "no demotions", not a crash. `status` distinguishes
    // this from a real generated-but-empty file for a caller that cares.
    return { demotions: {}, generatedAt: null, status: 'unavailable' };
  }
}

/**
 * Loaded demotion table, cached per file path so a scan doesn't re-read the
 * file on every finding. Tests pass an explicit `filePath` to bypass the
 * shared cache (see `_resetCache`).
 */
function loadDemotions(filePath = DEFAULT_PATH) {
  if (_cache && _cachedPath === filePath) return _cache;
  _cache = _load(filePath);
  _cachedPath = filePath;
  return _cache;
}

/** Test-only: clears the cache so a rewritten fixture file is re-read. */
function _resetCache() {
  _cache = null;
  _cachedPath = null;
}

/**
 * Demotes one rule's severity if it is on the active list. Only 'error'
 * severities are ever touched — the mechanism can soften, never sharpen,
 * and a rule already reported as 'warning' or 'info' is left alone.
 *
 * @param {string} ruleId - rule identity (src/core/rule-identity.js)
 * @param {string} severity - the severity `addCheck` computed
 * @param {object} [opts]
 * @param {object} [opts.demotions] - an already-loaded table (tests)
 * @param {string} [opts.demotionsPath] - override the file loaded
 * @returns {{severity: string, demotion: object|null}}
 */
function applyDemotion(ruleId, severity, opts = {}) {
  if (severity !== 'error' || !ruleId) return { severity, demotion: null };
  const table = opts.demotions || loadDemotions(opts.demotionsPath).demotions;
  const entry = table && table[ruleId];
  if (!entry || entry.to !== 'warning') return { severity, demotion: null };
  return {
    severity: entry.to,
    demotion: {
      from: entry.from || severity,
      to: entry.to,
      reason: entry.reason || 'field silence data',
      silencedRate: entry.silencedRate,
      sampleSize: entry.sampleSize,
    },
  };
}

/** How many rules are on the active demotion list right now — the one CLI line. */
function activeDemotionCount(filePath = DEFAULT_PATH) {
  const { demotions } = loadDemotions(filePath);
  return Object.keys(demotions).length;
}

module.exports = { loadDemotions, applyDemotion, activeDemotionCount, _resetCache, DEFAULT_PATH };
