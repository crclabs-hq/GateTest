'use strict';
/**
 * Flywheel Playback Engine
 *
 * Records dense fix telemetry, clusters bug lineages by fingerprint,
 * replays historical fixes without a Claude call, and distills high-
 * confidence patterns into permanent recipe JSON files.
 *
 * ARCHITECTURE:
 *   recordFixEvent   → ~/ .gatetest/telemetry/fix-events.jsonl
 *   clusterBugLineages → reads fix-events.jsonl, returns ranked clusters
 *   executePlaybackSimulation → auto-distill local recipe lookup (zero API)
 *   distillRecipes   → auto-distill.distillClaudeFix for certified fixes
 *
 * CONTRACTS:
 *   - All four public functions NEVER throw. A failure in recording or
 *     playback must never block the underlying fix operation.
 *   - No PII: no file paths, no repo names, no file contents reach the JSONL.
 *     Only anonymised shape metadata (ruleKey, module, fileExt, layer, success).
 *   - Zero new npm dependencies — Node.js built-ins only.
 *   - Website lib deps (auto-distill, fix-telemetry) are loaded defensively;
 *     the engine degrades gracefully when they aren't available.
 */

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const crypto   = require('crypto');
const readline = require('readline');

// ── Constants ─────────────────────────────────────────────────────────────────

const EVENTS_FILE       = path.join(os.homedir(), '.gatetest', 'telemetry', 'fix-events.jsonl');
const MAX_RULE_KEY_LEN  = 200;
const MAX_MODULE_LEN    = 100;
const CLUSTER_MIN_COUNT = 3;
const CLUSTER_MIN_CONF  = 0.85;

// ── Defensive module loader ───────────────────────────────────────────────────

function _safeRequire(specifier) {
  try { return require(specifier); } catch { return null; }
}

function _loadAutoDistill() {
  return _safeRequire(path.join(__dirname, '../../website/app/lib/auto-distill'));
}

function _loadTelemetry() {
  return _safeRequire(path.join(__dirname, '../../website/app/lib/fix-telemetry'));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _ensureDir(filePath) {
  try { fs.mkdirSync(path.dirname(filePath), { recursive: true }); } catch { /* best-effort */ } // error-ok
}

function _sanitiseStr(s, max) {
  if (typeof s !== 'string') return null;
  // Strip path separators — never let a file path slip through
  return s.replace(/[/\\]/g, '-').slice(0, max);
}

/**
 * Stable fingerprint for a (module, ruleKey, fileExt) triple.
 * Used as the cluster key — the same bug pattern in the same module
 * always maps to the same fingerprint regardless of order.
 */
function _fingerprint(module, ruleKey, fileExt) {
  const canonical = [
    typeof module  === 'string' ? module.slice(0, 100)  : '',
    typeof ruleKey === 'string' ? ruleKey.slice(0, 200) : '',
    typeof fileExt === 'string' ? fileExt.slice(0, 20)  : '',
  ].join('\x00');
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

// ── recordFixEvent ────────────────────────────────────────────────────────────

/**
 * Record a fix event to the dense fix-events JSONL and forward standard
 * fields to fix-telemetry.recordFixAttempt (the admin-dashboard feed).
 *
 * @param {object} opts
 * @param {string}  [opts.ruleKey]                — finding rule identifier
 * @param {string}  [opts.module]                 — GateTest module name
 * @param {string}  [opts.fileExt]                — file extension (.js, .ts …)
 * @param {string}  [opts.layer]                  — 'claude' | 'recipe' | …
 * @param {boolean} [opts.success]                — fix applied successfully
 * @param {number}  [opts.durationMs]             — wall-clock ms for the fix
 * @param {boolean|null} [opts.bidirectionalCertified] — gate result
 * @param {string}  [opts.hypothesisName]         — Alpha | Beta | Gamma
 * @param {number}  [opts.lineDelta]              — |lines_fixed - lines_original|
 * @param {number}  [opts.attempt]                — 1-based attempt number
 * @param {string}  [opts.eventsPath]             — override JSONL path (tests)
 * @returns {{ recorded: boolean, reason?: string }}
 */
function recordFixEvent(opts) {
  try {
    const {
      ruleKey     = '',
      module: mod = '',
      fileExt     = '',
      layer       = 'claude',
      success     = false,
      durationMs  = 0,
      bidirectionalCertified = null,
      hypothesisName         = null,
      lineDelta   = 0,
      attempt     = 1,
      eventsPath  = EVENTS_FILE,
    } = opts || {};

    // ── 1. Forward standard fields to fix-telemetry for admin dashboard ──────
    const telemetry = _loadTelemetry();
    if (telemetry && typeof telemetry.recordFixAttempt === 'function') {
      try {
        telemetry.recordFixAttempt({
          layer:        layer || 'claude',
          success:      !!success,
          issueRuleKey: _sanitiseStr(ruleKey, MAX_RULE_KEY_LEN) || null,
          module:       _sanitiseStr(mod, MAX_MODULE_LEN) || null,
          durationMs:   Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0,
          costUsd:      0,
          reason:       hypothesisName ? _sanitiseStr(hypothesisName, 100) : null,
        });
      } catch { /* telemetry is best-effort */ } // error-ok
    }

    // ── 2. Append dense event to fix-events.jsonl ────────────────────────────
    const record = {
      ts:          new Date().toISOString(),
      fingerprint: _fingerprint(mod, ruleKey, fileExt),
      ruleKey:     _sanitiseStr(ruleKey, MAX_RULE_KEY_LEN),
      module:      _sanitiseStr(mod, MAX_MODULE_LEN),
      fileExt:     _sanitiseStr(fileExt, 20),
      layer:       typeof layer === 'string' ? layer.slice(0, 20) : null,
      success:     !!success,
      certified:   typeof bidirectionalCertified === 'boolean' ? bidirectionalCertified : null,
      hypothesis:  hypothesisName ? _sanitiseStr(hypothesisName, 20) : null,
      lineDelta:   Number.isFinite(lineDelta) ? Math.max(0, lineDelta) : 0,
      attempt:     Number.isFinite(attempt)   ? Math.max(1, attempt)   : 1,
    };

    _ensureDir(eventsPath);
    fs.appendFileSync(eventsPath, JSON.stringify(record) + '\n', 'utf-8');
    return { recorded: true };
  } catch {
    return { recorded: false, reason: 'exception' };
  }
}

// ── clusterBugLineages ────────────────────────────────────────────────────────

/**
 * Read the fix-events JSONL and cluster events by fingerprint (module + ruleKey
 * + fileExt). Returns clusters sorted by confidence descending, total count
 * descending.
 *
 * A cluster reaches Rank 1 when:
 *   confidence ≥ CLUSTER_MIN_CONF (0.85) AND totalCount ≥ CLUSTER_MIN_COUNT (3)
 *
 * @param {object} [opts]
 * @param {string} [opts.eventsPath]  — override JSONL path (tests)
 * @param {Date}   [opts.since]       — only events after this date
 * @returns {Promise<{
 *   clusters: Array<{
 *     fingerprint: string,
 *     ruleKey: string,
 *     module: string,
 *     fileExt: string,
 *     successCount: number,
 *     certifiedCount: number,
 *     totalCount: number,
 *     confidence: number,
 *     rank: number,
 *   }>,
 *   totalEvents: number,
 * }>}
 */
async function clusterBugLineages(opts) {
  try {
    const { eventsPath = EVENTS_FILE, since } = opts || {};
    const sinceMs = since instanceof Date ? since.getTime() : -Infinity;

    const byFingerprint = new Map();

    let exists = false;
    try { fs.accessSync(eventsPath, fs.constants.R_OK); exists = true; } catch { /* ok */ } // error-ok
    if (!exists) return { clusters: [], totalEvents: 0 };

    let totalEvents = 0;

    await new Promise((resolve) => {
      let stream;
      try {
        stream = fs.createReadStream(eventsPath, { encoding: 'utf-8', highWaterMark: 64 * 1024 });
      } catch {
        resolve();
        return;
      }
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      rl.on('line', (line) => {
        if (!line || !line.trim()) return;
        let rec;
        try { rec = JSON.parse(line); } catch { return; }
        if (!rec || typeof rec !== 'object') return;

        const t = rec.ts ? Date.parse(rec.ts) : NaN;
        if (Number.isFinite(t) && t < sinceMs) return;

        totalEvents++;
        const fp = rec.fingerprint;
        if (!fp) return;

        if (!byFingerprint.has(fp)) {
          byFingerprint.set(fp, {
            fingerprint:    fp,
            ruleKey:        rec.ruleKey || '',
            module:         rec.module  || '',
            fileExt:        rec.fileExt || '',
            successCount:   0,
            certifiedCount: 0,
            totalCount:     0,
          });
        }
        const cluster = byFingerprint.get(fp);
        cluster.totalCount++;
        if (rec.success)              cluster.successCount++;
        if (rec.certified === true)   cluster.certifiedCount++;
        // Keep the most representative ruleKey / module (first non-empty wins)
        if (!cluster.ruleKey && rec.ruleKey) cluster.ruleKey = rec.ruleKey;
        if (!cluster.module  && rec.module)  cluster.module  = rec.module;
        if (!cluster.fileExt && rec.fileExt) cluster.fileExt = rec.fileExt;
      });
      rl.on('error', () => resolve());
      rl.on('close', () => resolve());
    });

    const clusters = Array.from(byFingerprint.values()).map((c) => {
      const confidence = c.totalCount > 0 ? c.successCount / c.totalCount : 0;
      const rank = (confidence >= CLUSTER_MIN_CONF && c.totalCount >= CLUSTER_MIN_COUNT) ? 1 : 2;
      return { ...c, confidence, rank };
    });

    // Sort: rank ASC (1=best), confidence DESC, totalCount DESC
    clusters.sort((a, b) =>
      a.rank - b.rank || b.confidence - a.confidence || b.totalCount - a.totalCount
    );

    return { clusters, totalEvents };
  } catch {
    return { clusters: [], totalEvents: 0 };
  }
}

// ── executePlaybackSimulation ─────────────────────────────────────────────────

/**
 * Before calling Claude, check whether a stable recipe in the local store
 * can handle this fix. Returns the patched content when a recipe hits.
 *
 * @param {object} opts
 * @param {string}   opts.content        — current file content
 * @param {string[]} opts.issues         — issue descriptions / ruleKeys
 * @param {string}   [opts.fileExt]      — file extension
 * @param {string}   [opts.module]       — GateTest module name
 * @param {string}   [opts.recipePath]   — path to local recipe store JSON
 * @returns {{ hit: boolean, code?: string, recipeId?: string, layer: string }}
 */
function executePlaybackSimulation(opts) {
  try {
    const {
      content,
      issues,
      fileExt = '',
      module: mod = '',
      recipePath,
    } = opts || {};

    if (typeof content !== 'string' || !Array.isArray(issues) || issues.length === 0) {
      return { hit: false, layer: 'recipe' };
    }

    const autoDistill = _loadAutoDistill();
    if (!autoDistill || typeof autoDistill.findMatchingRecipeLocal !== 'function') {
      return { hit: false, layer: 'recipe' };
    }
    if (!autoDistill.applyRecipe) {
      return { hit: false, layer: 'recipe' };
    }

    // Try each issue as a potential ruleKey
    for (const issue of issues) {
      const ruleKey = typeof issue === 'string' ? issue.slice(0, MAX_RULE_KEY_LEN) : '';
      const recipe = autoDistill.findMatchingRecipeLocal({
        ruleKey,
        module:       mod,
        fileExt,
        content,
        recipeStorePath:    recipePath || null,
        includeLowConfidence: false, // only "stable" recipes
      });
      if (!recipe) continue;

      const patched = autoDistill.applyRecipe(content, recipe);
      if (!patched || patched === content) continue;

      // Bump the application counter (promotes to stable at count=3)
      if (recipePath && typeof autoDistill.incrementApplicationCount === 'function') {
        try { autoDistill.incrementApplicationCount(recipe.id, recipePath); } catch { /* best-effort */ } // error-ok
      }

      return { hit: true, code: patched, recipeId: recipe.id, layer: 'recipe' };
    }

    return { hit: false, layer: 'recipe' };
  } catch {
    return { hit: false, layer: 'recipe' };
  }
}

// ── distillRecipes ────────────────────────────────────────────────────────────

/**
 * Distill a successful, bidirectionally-certified Claude fix into the local
 * recipe store so future identical patterns can be replayed without API cost.
 *
 * @param {object} opts
 * @param {string}  opts.originalContent  — buggy file content (before fix)
 * @param {string}  opts.fixedContent     — fixed file content (after fix)
 * @param {string}  [opts.ruleKey]        — finding rule identifier
 * @param {string}  [opts.module]         — GateTest module name
 * @param {string}  [opts.fileExt]        — file extension
 * @param {string}  [opts.recipePath]     — local recipe store path (JSON)
 * @param {string}  [opts.modelId]        — Claude model that produced the fix
 * @returns {{ distilled: boolean, recipeId?: string, reason?: string }}
 */
function distillRecipes(opts) {
  try {
    const {
      originalContent,
      fixedContent,
      ruleKey  = '',
      module: mod = '',
      fileExt  = '',
      recipePath,
      modelId  = 'claude-sonnet-5',
    } = opts || {};

    if (typeof originalContent !== 'string' || typeof fixedContent !== 'string') {
      return { distilled: false, reason: 'invalid-content' };
    }
    if (originalContent === fixedContent) {
      return { distilled: false, reason: 'no-change' };
    }
    if (!recipePath) {
      return { distilled: false, reason: 'no-recipe-path' };
    }

    const autoDistill = _loadAutoDistill();
    if (!autoDistill || typeof autoDistill.distillClaudeFix !== 'function') {
      return { distilled: false, reason: 'auto-distill-unavailable' };
    }

    const result = autoDistill.distillClaudeFix({
      originalContent,
      fixedContent,
      ruleKey:         _sanitiseStr(ruleKey, MAX_RULE_KEY_LEN) || '',
      module:          _sanitiseStr(mod, MAX_MODULE_LEN) || '',
      fileExt:         _sanitiseStr(fileExt, 20) || '',
      recipeStorePath: recipePath,
      modelId,
    });

    if (!result) return { distilled: false, reason: 'not-templatey' };
    return { distilled: true, recipeId: result.id };
  } catch {
    return { distilled: false, reason: 'exception' };
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  recordFixEvent,
  clusterBugLineages,
  executePlaybackSimulation,
  distillRecipes,
  // Exposed for testing
  _fingerprint,
};
