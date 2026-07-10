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

let persistentMemory = null;
try { persistentMemory = require('./persistent-memory'); } catch { /* optional */ } // error-ok

// ── Consent ─────────────────────────────────────────────────────────────────

/**
 * Is anonymized telemetry allowed? Off when GATETEST_NO_TELEMETRY is truthy
 * or the project's .gatetest.json sets "telemetry": false. Defaults ON
 * (opt-out model, Craig 2026-07-11).
 *
 * @param {string} [projectRoot]
 * @returns {boolean}
 */
function telemetryEnabled(projectRoot) {
  const env = process.env.GATETEST_NO_TELEMETRY;
  if (env && env !== '0' && env.toLowerCase() !== 'false') return false;
  if (projectRoot) {
    try {
      const cfgPath = path.join(projectRoot, '.gatetest.json');
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      if (cfg && cfg.telemetry === false) return false;
    } catch { /* no config / unreadable → default on */ } // error-ok
  }
  return true;
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
      status:   r.status === 'failed' || r.status === 'skipped' ? r.status : 'ok',
    });
  }
  return {
    ts:         new Date().toISOString(),
    source:     _sanitiseModuleName(source) || 'unknown', // cli | website | mcp | action
    suite:      _sanitiseModuleName(suite) || _sanitiseModuleName(summary && summary.suite) || 'unknown',
    gateStatus: summary && summary.gateStatus === 'PASSED' ? 'PASSED' : 'BLOCKED',
    durationMs: _int(summary && summary.duration),
    totalErrors:   _int(summary && summary.checks && summary.checks.errors),
    totalWarnings: _int(summary && summary.checks && summary.checks.warnings),
    modules,
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
    }

    return { recorded: true };
  } catch {
    return { recorded: false, reason: 'exception' };
  }
}

module.exports = {
  recordScanFindings,
  telemetryEnabled,
  SCAN_FINDINGS_FILE,
  // Exposed for tests.
  _buildRecord,
};
