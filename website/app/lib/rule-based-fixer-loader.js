/**
 * Rule loader — assembles the active TRANSFORMS list from:
 *   1. The hand-curated RULES exported by rule-based-fixer.js
 *   2. Any reviewer-approved auto-promoted rules in
 *      website/app/lib/rule-based-fixer-pending/*.js
 *
 * The pending rules are emitted by the recipe-auto-promoter trainer.
 * Each one carries source SHAs, a generated-at timestamp, and a
 * reviewer checklist in its header. They are NOT loaded by default —
 * a reviewer must explicitly opt in by setting GATETEST_LOAD_AUTO_RULES=1
 * after they've sanity-checked the swap.
 *
 * This is the safest possible loop closure: the trainer drafts the
 * rule, a human flips the switch, the rule activates. No code merge,
 * no deploy — just an env-flag opt-in once the human is satisfied.
 *
 * Selective loading: set GATETEST_LOAD_AUTO_RULES to a comma-separated
 * list of rule names (e.g. "auto-unsafe-legacy,auto-rejectunauth") to
 * load only those. Set to "1" / "all" to load every pending rule.
 *
 * RESILIENCE: a pending file that fails to load (syntax error, missing
 * `rule` export, etc.) is logged once and skipped. The base RULES list
 * is always returned even if every pending rule errors.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { RULES: BASE_RULES, applyRules: baseApplyRules } = require('./rule-based-fixer.js');

const PENDING_DIR = path.join(__dirname, 'rule-based-fixer-pending');

let _warnedFiles = new Set();
function warnOnceFor(file, msg) {
  if (_warnedFiles.has(file)) return;
  _warnedFiles.add(file);
  // eslint-disable-next-line no-console
  console.warn(`[rule-loader] ${file}: ${msg}`);
}

// ---------------------------------------------------------------------------
// Env parsing
// ---------------------------------------------------------------------------

function selectionFromEnv(envVar) {
  const raw = (envVar || process.env.GATETEST_LOAD_AUTO_RULES || '').trim();
  if (!raw) return { enabled: false, allowAll: false, names: new Set() };
  if (raw === '0' || raw.toLowerCase() === 'false' || raw.toLowerCase() === 'off') {
    return { enabled: false, allowAll: false, names: new Set() };
  }
  if (raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'all') {
    return { enabled: true, allowAll: true, names: new Set() };
  }
  const names = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  return { enabled: names.size > 0, allowAll: false, names };
}

// ---------------------------------------------------------------------------
// Pending-rule discovery
// ---------------------------------------------------------------------------

function listPendingRuleFiles(dir = PENDING_DIR) {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.js') && !f.startsWith('.') && !f.startsWith('_'))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function loadPendingRule(filePath) {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const mod = require(filePath);
    if (!mod || !mod.rule || typeof mod.rule !== 'object') {
      warnOnceFor(filePath, 'no `rule` export — skipped');
      return null;
    }
    const r = mod.rule;
    if (typeof r.name !== 'string' || typeof r.matches !== 'function' || typeof r.apply !== 'function') {
      warnOnceFor(filePath, '`rule` missing name/matches/apply — skipped');
      return null;
    }
    if (!r.auto) {
      warnOnceFor(filePath, '`rule.auto` flag missing — refusing to load (safety check)');
      return null;
    }
    return r;
  } catch (err) {
    warnOnceFor(filePath, `load failed: ${err && err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the full active rules list: hand-curated + opt-in auto-promoted.
 *
 * @param {object} [opts]
 * @param {string} [opts.envVar]     override the env-var value (for tests)
 * @param {string} [opts.pendingDir] override the pending-dir path (for tests)
 * @returns {{ rules: object[], autoLoaded: string[], autoSkipped: string[] }}
 */
function loadActiveRules(opts = {}) {
  const selection = selectionFromEnv(opts.envVar);
  const autoLoaded = [];
  const autoSkipped = [];

  if (!selection.enabled) {
    return { rules: BASE_RULES.slice(), autoLoaded, autoSkipped };
  }

  const files = listPendingRuleFiles(opts.pendingDir);
  const extra = [];
  for (const f of files) {
    const r = loadPendingRule(f);
    if (!r) {
      autoSkipped.push(path.basename(f));
      continue;
    }
    if (!selection.allowAll && !selection.names.has(r.name)) {
      autoSkipped.push(r.name);
      continue;
    }
    extra.push(r);
    autoLoaded.push(r.name);
  }

  return {
    rules: [...BASE_RULES, ...extra],
    autoLoaded,
    autoSkipped,
  };
}

/**
 * Drop-in replacement for applyRules() that uses the loaded set
 * (base + opt-in auto rules). For most callers this should be the
 * entry point; the base applyRules() in rule-based-fixer.js is kept
 * as the static-rules-only fast path for tests.
 */
function applyRulesWithAuto(content, filePath, issues, opts = {}) {
  const { rules } = loadActiveRules(opts);
  if (typeof content !== 'string') throw new TypeError('content must be a string');
  if (!Array.isArray(issues)) throw new TypeError('issues must be an array');

  const handled = [];
  const unhandled = [];
  let current = content;

  for (const issue of issues) {
    const rule = rules.find((r) => r.matches(issue));
    if (!rule) {
      unhandled.push(issue);
      continue;
    }
    const next = rule.apply(current, filePath || '');
    if (next !== current) {
      current = next;
      handled.push(issue);
    } else if (rule.alreadyFixed && rule.alreadyFixed(current, issue)) {
      handled.push(issue);
    } else {
      unhandled.push(issue);
    }
  }

  return { content: current, handled, unhandled };
}

module.exports = {
  loadActiveRules,
  applyRulesWithAuto,
  selectionFromEnv,
  listPendingRuleFiles,
  // re-export the static path so callers can pick
  applyRulesStatic: baseApplyRules,
  PENDING_DIR,
};
