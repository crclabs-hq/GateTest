'use strict';
/**
 * Scan Telemetry — anonymized per-scan finding signal for the flywheel.
 *
 * Every scan (CLI, website, MCP, Action) emits ONE record: which modules ran,
 * how many errors/warnings each fired, gate status, duration. This is the
 * feedback loop that lets us see which modules are noisy across the whole
 * customer base and tune the engine continuously.
 *
 * CONTRACTS (identical privacy bar to flywheel-playback-engine.js):
 *   - NEVER throws. A failure here must never block or slow a scan.
 *   - No PII, ever: no file paths, no code, no repo name, no finding text.
 *     Only our own module names (which are public) + integer counts.
 *   - Opt-out honored: GATETEST_NO_TELEMETRY=1 (env) or .gatetest.json
 *     { "telemetry": false } silences ALL writes and the persistent-memory
 *     update in one place, so every entry point inherits the same guard.
 *   - Zero new npm dependencies — Node.js built-ins only.
 *
 * Local capture is unconditional-on-consent; the central upload is a separate
 * best-effort step (see telemetry-uploader.js) so this recorder has no network
 * dependency and works fully offline.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const SCAN_FINDINGS_FILE = path.join(os.homedir(), '.gatetest', 'telemetry', 'scan-findings.jsonl');
const MAX_MODULE_LEN = 100;
const MAX_MODULES_PER_RECORD = 200; // sanity cap — the engine has 120
const MAX_RULES_PER_RECORD = 400;
const MAX_RULE_LEN = 120;
const { ruleIdentity } = require('./rule-identity');
const { GATE_STATUSES } = require('./report-schema');

/**
 * A rule id is a code identifier (`secrets:aws-key`), never a path or text.
 * ruleIdentity strips the embedded file:line; anything that still carries a
 * separator or a space is dropped rather than shipped.
 */
function _ruleId(check) {
  const id = ruleIdentity(check);
  if (!id || id.length > MAX_RULE_LEN) return null;
  if (/[\s/\\]/.test(id)) return null;
  return id;
}

/**
 * Per-rule signal for the flywheel leaderboard (the Fifty, move 07): how
 * many findings each rule produced in this scan, and how many the team had
 * silenced through .gatetestignore / an ignore reply. A baselined finding is
 * "real, fix later", not a dismissal, and is not counted as silenced.
 */
function _buildRules(results) {
  const byRule = new Map();
  for (const r of results) {
    for (const c of (r && r.checks) || []) {
      if (!c || c.passed) continue;
      const id = _ruleId(c);
      if (!id) continue;
      const entry = byRule.get(id) || { id, fired: 0, silenced: 0 };
      if (c.suppressed) {
        if (c.suppressReason !== 'baseline') entry.silenced++;
      } else {
        entry.fired++;
      }
      byRule.set(id, entry);
    }
  }
  return [...byRule.values()]
    .filter((e) => e.fired + e.silenced > 0)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .slice(0, MAX_RULES_PER_RECORD);
}

let persistentMemory = null;
try { persistentMemory = require('./persistent-memory'); } catch { /* optional */ } // error-ok

// ── Consent ─────────────────────────────────────────────────────────────────

/**
 * The owner's default for a machine with no switch set: 'on' (opt-out) or
 * 'off' (opt-in). ONE definition — flipping it is this one line. Everything
 * that reports or enforces the default (telemetryEnabled, --telemetry-status,
 * the first-run notice, the README) reads it from here.
 */
const TELEMETRY_DEFAULT = 'on';

function _truthy(v) {
  return typeof v === 'string' && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

/** '1'|'true'|'on' -> true, '0'|'false'|'off' -> false, anything else -> null. */
function _parseSwitch(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase();
  if (t === '1' || t === 'true' || t === 'on') return true;
  if (t === '0' || t === 'false' || t === 'off') return false;
  return null;
}

/**
 * Decide whether telemetry is on, and say which switch decided. Precedence,
 * first match wins:
 *   1. GATETEST_NO_TELEMETRY truthy  -> off, source 'env'  (legacy alias; also
 *      what --offline sets, so offline can never be overridden upward)
 *   2. GATETEST_TELEMETRY=1|0        -> source 'env'
 *   3. .gatetest.json "telemetry": true|false -> source 'project config'
 *   4. TELEMETRY_DEFAULT             -> source 'default'
 *
 * @param {string} [projectRoot]
 * @param {Record<string,string|undefined>} [env]
 * @returns {{ enabled: boolean, source: 'env'|'project config'|'default', detail: string }}
 */
function resolveTelemetry(projectRoot, env = process.env) {
  if (_truthy(env.GATETEST_NO_TELEMETRY)) {
    return { enabled: false, source: 'env', detail: 'GATETEST_NO_TELEMETRY' };
  }
  const explicit = _parseSwitch(env.GATETEST_TELEMETRY);
  if (explicit !== null) {
    return { enabled: explicit, source: 'env', detail: 'GATETEST_TELEMETRY' };
  }
  if (projectRoot) {
    try {
      const cfgPath = path.join(projectRoot, '.gatetest.json');
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      if (cfg && typeof cfg.telemetry === 'boolean') {
        return { enabled: cfg.telemetry, source: 'project config', detail: '.gatetest.json' };
      }
    } catch { /* no config / unreadable → default */ } // error-ok
  }
  return { enabled: TELEMETRY_DEFAULT === 'on', source: 'default', detail: 'nothing set' };
}

/**
 * Is anonymized telemetry allowed? See resolveTelemetry for the precedence.
 *
 * @param {string} [projectRoot]
 * @returns {boolean}
 */
function telemetryEnabled(projectRoot) {
  return resolveTelemetry(projectRoot).enabled;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _sanitiseModuleName(s) {
  if (typeof s !== 'string') return null;
  // Module names are our own identifiers, but strip path separators defensively
  // so a malformed result can never smuggle a path into the record.
  return s.replace(/[/\\]/g, '-').slice(0, MAX_MODULE_LEN);
}

function _int(n) {
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

/**
 * Reduce a runner summary to the anonymized per-module signal. Reads only
 * counts + our module names off summary.results — never a check's message,
 * file, or line.
 */
function _buildRecord(summary, { source, suite }) {
  const results = Array.isArray(summary && summary.results) ? summary.results : [];
  const modules = [];
  for (const r of results.slice(0, MAX_MODULES_PER_RECORD)) {
    const name = _sanitiseModuleName(r && r.module);
    if (!name) continue;
    modules.push({
      name,
      errors:   _int(r.errors),
      warnings: _int(r.warnings),
      soft:     _int(r.softErrors),
      // Carried so recordScan can count a silenced module as still firing.
      suppressed: _int(r.suppressedChecks),
      status:   r.status === 'failed' || r.status === 'skipped' ? r.status : 'ok',
    });
  }
  return {
    ts:         new Date().toISOString(),
    source:     _sanitiseModuleName(source) || 'unknown', // cli | website | mcp | action
    suite:      _sanitiseModuleName(suite) || _sanitiseModuleName(summary && summary.suite) || 'unknown',
    // PASSED / BLOCKED / REPORT_ONLY (src/core/report-schema.js); anything else is BLOCKED, never a fake pass.
    gateStatus: summary && GATE_STATUSES.includes(summary.gateStatus) ? summary.gateStatus : 'BLOCKED',
    durationMs: _int(summary && summary.duration),
    totalErrors:   _int(summary && summary.checks && summary.checks.errors),
    totalWarnings: _int(summary && summary.checks && summary.checks.warnings),
    modules,
    rules: _buildRules(results),
  };
}

/**
 * The names of the fields one upload carries, no values — the first-run
 * notice prints this list. Derived from a real record built by _buildRecord,
 * so the notice can never drift from what is actually sent.
 *
 * @returns {{ record: string[], module: string[], rule: string[] }}
 */
function recordFieldNames() {
  const sample = _buildRecord({
    results: [{ module: 'sample', errors: 1, checks: [{ name: 'sample:rule', passed: false, severity: 'error' }] }],
  }, { source: 'cli', suite: 'quick' });
  return {
    record: Object.keys(sample),
    module: Object.keys(sample.modules[0] || {}),
    rule: Object.keys(sample.rules[0] || {}),
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Record one scan's anonymized finding signal. Writes the JSONL line locally
 * and updates persistent-memory (per-module fireRate). NEVER throws.
 *
 * @param {object} summary                 — the runner summary (_buildSummary output)
 * @param {object} opts
 * @param {string}  opts.source            — 'cli' | 'website' | 'mcp' | 'action'
 * @param {string} [opts.projectRoot]      — for consent + persistent-memory
 * @param {string} [opts.suite]            — suite name if not on the summary
 * @param {string} [opts.filePath]         — override JSONL path (tests)
 * @returns {{ recorded: boolean, reason?: string }}
 */
function recordScanFindings(summary, opts = {}) {
  try {
    const { source = 'unknown', projectRoot, suite, filePath = SCAN_FINDINGS_FILE } = opts;
    if (!telemetryEnabled(projectRoot)) return { recorded: false, reason: 'opted-out' };
    if (!summary || typeof summary !== 'object') return { recorded: false, reason: 'no-summary' };

    const record = _buildRecord(summary, { source, suite });

    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf-8');
    } catch { /* best-effort local write */ } // error-ok

    // Update per-repo compounding memory (fireRate etc.) — this is the piece
    // that was exposed but never auto-called by the runner. Map the summary
    // into the shape persistent-memory.recordScan expects.
    if (persistentMemory && projectRoot) {
      try {
        persistentMemory.recordScan(projectRoot, {
          modules:     record.modules,
          totalIssues: record.totalErrors + record.totalWarnings,
          duration:    record.durationMs,
          suite:       record.suite,
        });
      } catch { /* best-effort */ } // error-ok

      // Feed the noise model its missing input (KI #76). Every rule the user
      // silenced in .gatetestignore this run is a declared false positive.
      // Without this, recordSuppression had ZERO callers, dismissCount was
      // permanently 0, and computePenalties() could only ever return {} —
      // `gatetest --noise` said "No modules softened yet" forever.
      //
      // MUST run after recordScan: recordSuppressions only increments
      // modules[m].suppressions for modules that already exist in memory, and
      // recordScan is what creates them on a first-ever scan.
      try {
        const suppressed = Array.isArray(summary.suppressedRules) ? summary.suppressedRules : [];
        if (suppressed.length > 0 && typeof persistentMemory.recordSuppressions === 'function') {
          persistentMemory.recordSuppressions(projectRoot, suppressed);
        }
      } catch { /* best-effort */ } // error-ok
    }

    return { recorded: true };
  } catch {
    return { recorded: false, reason: 'exception' };
  }
}

module.exports = {
  recordScanFindings,
  telemetryEnabled,
  resolveTelemetry,
  TELEMETRY_DEFAULT,
  recordFieldNames,
  SCAN_FINDINGS_FILE,
  // Exposed for tests.
  _buildRecord,
};
