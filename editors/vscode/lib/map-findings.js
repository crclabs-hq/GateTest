/**
 * Pure mapping from a GateTest scan summary (the object returned by
 * `new GateTest(root).init().runSuite(...)`, i.e. `Runner.run()`'s return
 * value — see src/core/runner.js `run()`) to a plain, VS Code-shaped
 * diagnostic list per file.
 *
 * Deliberately has ZERO dependency on the `vscode` module so it can be unit
 * tested with plain `node --test`, same convention as the rest of this repo
 * (pure helpers separated from the API/wiring layer that consumes them).
 * extension.js is the thin layer that turns these plain objects into real
 * vscode.Diagnostic instances.
 */

'use strict';

const path = require('path');

/** GateTest severities → a VS Code-shaped severity string (extension.js maps this to vscode.DiagnosticSeverity). */
function toVscodeSeverity(gatetestSeverity) {
  switch (String(gatetestSeverity || '').toLowerCase()) {
    case 'error':
    case 'critical':
      return 'Error';
    case 'warning':
      return 'Warning';
    default:
      return 'Information';
  }
}

/**
 * @param {object} summary - Runner.run()'s return value.
 * @param {string} workspaceRoot - Absolute path the scan was run against;
 *   used to resolve check.file (which is project-relative) to an absolute path.
 * @returns {Map<string, Array<{line: number, message: string, severity: string, source: string, ruleName: string}>>}
 *   Keyed by absolute file path. `line` is 0-indexed (VS Code Position
 *   convention) — GateTest's own `check.line` is 1-indexed.
 */
function mapSummaryToDiagnostics(summary, workspaceRoot) {
  const byFile = new Map();
  const results = (summary && summary.results) || [];

  for (const result of results) {
    const checks = result.checks || [];
    for (const check of checks) {
      // A passed check has nothing to show; a suppressed one was deliberately
      // silenced (.gatetestignore) and must not resurface in the editor.
      if (check.passed || check.suppressed) continue;
      if (!check.file) continue;

      const absPath = path.isAbsolute(check.file)
        ? check.file
        : path.join(workspaceRoot, check.file);

      const rawLine = parseInt(check.line, 10);
      const line = Number.isFinite(rawLine) && rawLine > 0 ? rawLine - 1 : 0;

      const entry = {
        line,
        message: check.message || check.suggestion || check.name || `${result.module} finding`,
        severity: toVscodeSeverity(check.severity),
        source: `gatetest:${result.module}`,
        ruleName: check.name || result.module,
      };

      if (!byFile.has(absPath)) byFile.set(absPath, []);
      byFile.get(absPath).push(entry);
    }
  }

  return byFile;
}

module.exports = { mapSummaryToDiagnostics, toVscodeSeverity };
