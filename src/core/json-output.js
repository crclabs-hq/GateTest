'use strict';

/**
 * `gatetest --format json` — the one JSON document a scan prints on stdout.
 *
 * WHY
 * ---
 * The VS Code extension has spawned `gatetest --suite <s> --format json
 * --project <root> [--file <f>]` and JSON.parsed stdout since it was
 * written. The CLI never had `--format`: the flag was reported as unknown,
 * the scan printed the human report, and the extension failed on every run
 * (verified 2026-09-15). This module is the contract the extension (and any
 * other editor or script) can rely on.
 *
 * WHAT
 * ----
 * The document is derived from the SAME summary the console/JSON/SARIF
 * reporters read — `summary.findings`, the ranked, cross-module-deduped
 * view from src/core/finding-registry.js — so it can never disagree with
 * what a human run shows. No second finding model, no second severity
 * scale: `severity` is the registry's 'error' | 'warning' | 'info'.
 *
 * Lines and columns are 1-based, as modules report them; `null` when the
 * module did not give one. Files are repo-relative, '/'-joined, on every OS.
 *
 * Cross-module duplicates (the same line flagged by two modules) are folded
 * into ONE issue, as the console does — an editor showing the same squiggle
 * twice is noise. The folded count is reported, not hidden.
 */

const path = require('path');
const { repoRelative, toPosix } = require('./repo-path');

const PKG_VERSION = require('../../package.json').version;

/** The severities an issue may carry — pinned so a consumer can switch on them. */
const SEVERITIES = ['error', 'warning', 'info'];

/**
 * The exit code a scan ends with — ONE definition shared by the human and
 * JSON paths so the two can never disagree (the whole point of the JSON
 * carrying `exitCode` is that an editor can trust it without re-deriving
 * the gate rule).
 *
 *   --baseline   capturing is setup, not a gate run: 0 unless the capture
 *                itself failed.
 *   otherwise    0 when the gate PASSED, 1 when BLOCKED.
 */
function scanExitCode(summary, { baseline = false } = {}) {
  if (baseline) {
    const b = (summary && summary.baseline) || {};
    return b.error ? 1 : 0;
  }
  return summary && summary.gateStatus === 'PASSED' ? 0 : 1;
}

function relFile(root, file) {
  if (!file) return null;
  const f = String(file);
  const rel = root && path.isAbsolute(f) ? repoRelative(root, f) : toPosix(f);
  return rel.replace(/^\.\//, '') || null;
}

function intOrNull(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Index the raw checks by the registry's finding id (`module:name`) so the
 * fields the registry does not carry (column, autoFix) can be read off the
 * original check without re-deriving anything.
 */
function indexChecks(results) {
  const byId = new Map();
  for (const r of results || []) {
    const mod = r.module || r.name || 'unknown';
    for (const c of r.checks || []) {
      if (!c || c.passed) continue;
      const id = `${mod}:${c.name}`;
      if (!byId.has(id)) byId.set(id, c);
    }
  }
  return byId;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * One line a status bar or output channel can show.
 * "quick scan BLOCKED — 2 errors, 3 warnings, 1 note across 12 modules (1.2s)"
 */
function summaryLine({ scope, gateStatus, counts, modules, duration, nothingChecked, files }) {
  const parts = [plural(counts.errors, 'error'), plural(counts.warnings, 'warning'), plural(counts.notes, 'note')];
  const where = files && files.length ? ` in ${plural(files.length, 'file')}` : '';
  const secs = typeof duration === 'number' ? ` (${(duration / 1000).toFixed(1)}s)` : '';
  const empty = nothingChecked ? ' — no source files found under the project root' : '';
  return `${scope} ${gateStatus} — ${parts.join(', ')}${where} across ${plural(modules.total, 'module')}${secs}${empty}`;
}

/**
 * Build the stdout document for `--format json`.
 *
 * @param {object} summary   the runner summary (GateTest.runSuite / runModule)
 * @param {object} ctx
 * @param {string} ctx.projectRoot   absolute project root
 * @param {string} [ctx.suite]       suite name (null when --module was used)
 * @param {string} [ctx.module]      module name (null when a suite ran)
 * @param {string[]} [ctx.files]     repo-relative --file list, or null
 * @param {number} ctx.exitCode      the code the process is about to exit with
 * @param {string} [ctx.version]     tool version (defaults to package.json)
 * @param {string} [ctx.reportPath]  the on-disk JSON report, when written
 */
function buildJsonOutput(summary, ctx) {
  const root = path.resolve(ctx.projectRoot);
  const checks = indexChecks(summary.results);
  const issues = [];
  let duplicatesCollapsed = 0;
  for (const f of Array.isArray(summary.findings) ? summary.findings : []) {
    if (f.duplicateOf) { duplicatesCollapsed++; continue; }
    const c = checks.get(f.id) || {};
    const severity = SEVERITIES.includes(f.severity) ? f.severity : 'info';
    const column = intOrNull(c.column !== undefined ? c.column : (c.col !== undefined ? c.col : (c.details && !Array.isArray(c.details) ? c.details.column : null)));
    issues.push({
      id: f.id,
      module: f.module,
      ruleId: f.rule || null,
      severity,
      message: f.message,
      file: relFile(root, f.file),
      line: intOrNull(f.line),
      column,
      blocking: f.blocking === true,
      confidence: typeof f.confidence === 'number' ? f.confidence : null,
      // A fix the engine can apply itself (`gatetest --fix` / the fix engine)
      fixable: typeof c.autoFix === 'function' || c.fixable === true,
      suggestion: f.suggestion || null,
      ignoreLine: f.ignoreLine || null,
    });
  }
  const counts = {
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warning').length,
    notes: issues.filter((i) => i.severity === 'info').length,
    blocking: issues.filter((i) => i.blocking).length,
    total: issues.length,
    duplicatesCollapsed,
  };
  const modules = summary.modules || { total: 0, passed: 0, failed: 0, skipped: 0 };
  // KI #112 G3 (issue #630/#633): `--json` had whole-run `duration` but no
  // per-module timing, so a customer profiling a slow scan on a large
  // monorepo could not tell which of the suite's modules to look at without
  // re-running under `--module`. The console reporter has had a per-module
  // elapsed line since #644 (src/reporters/console-reporter.js, from
  // TestResult.duration — one definition, not re-measured here);
  // `modules.list` is the same numbers, one entry per module that actually
  // ran, in run order. `durationMs` is `null` only when a module result
  // carries no numeric duration (defensive — never fabricated).
  const moduleTimings = Array.isArray(summary.results)
    ? summary.results.map((r) => ({
      module: r.module,
      status: r.status,
      durationMs: typeof r.duration === 'number' ? r.duration : null,
    }))
    : [];
  const gateStatus = summary.gateStatus || 'BLOCKED';
  const files = Array.isArray(ctx.files) && ctx.files.length ? ctx.files.slice() : null;
  const scope = ctx.module ? `module ${ctx.module}` : `${ctx.suite || 'standard'} scan`;

  return {
    version: ctx.version || PKG_VERSION,
    generatedAt: new Date().toISOString(),
    suite: ctx.module ? null : (ctx.suite || 'standard'),
    module: ctx.module || null,
    project: root,
    files,
    passed: gateStatus === 'PASSED',
    gateStatus,
    // KI #107: whether GATETEST_ADMIN=1 softened a blocking result this run,
    // and what the verdict would have been without it. Never leave a
    // consumer reading "gateStatus: PASSED" with no trace that a blocking
    // result was overridden (Forbidden #16 — never silently pass).
    adminOverride: summary.adminOverride === true,
    rawGateStatus: summary.rawGateStatus || gateStatus,
    exitCode: ctx.exitCode,
    nothingChecked: summary.nothingChecked === true,
    summary: summaryLine({ scope, gateStatus, counts, modules, duration: summary.duration, nothingChecked: summary.nothingChecked === true, files }),
    counts,
    modules: {
      total: modules.total || 0,
      passed: modules.passed || 0,
      failed: modules.failed || 0,
      skipped: modules.skipped || 0,
      list: moduleTimings,
    },
    checks: summary.checks || null,
    duration: typeof summary.duration === 'number' ? summary.duration : null,
    deferred: Array.isArray(summary.deferred) ? summary.deferred : [],
    // Move 4 (time-to-verdict contract) — never let a --budget-limited
    // run's JSON read like a full one. See runner.js `_buildSummary`.
    budgetLimited: summary.budgetLimited === true,
    slowestModules: Array.isArray(summary.slowestModules) ? summary.slowestModules : [],
    // KI #112 (issue #633): null when .gatetest.json has no unrecognised
    // root keys — never a placeholder object. See src/core/config.js
    // getUnknownKeysCheck() for the one definition of this shape.
    configCheck: summary.configCheck || null,
    failedModules: Array.isArray(summary.failedModules) ? summary.failedModules : [],
    report: ctx.reportPath || null,
    issues,
    // Accepted-risk overrides that applied this run (move 3,
    // docs/LAUNCH_BOARD.md) — a recorded, expiring alternative to
    // .gatetestignore. Always an array, never omitted (Forbidden #16):
    // an empty run must say "no overrides", not leave the key absent.
    overrides: Array.isArray(summary.overrides) ? summary.overrides : [],
  };
}

module.exports = { buildJsonOutput, scanExitCode, summaryLine, SEVERITIES };
