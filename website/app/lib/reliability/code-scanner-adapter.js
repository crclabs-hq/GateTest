/**
 * Reliability — code-target scanner adapter.
 *
 * Spawns the production gatetest CLI against a code workspace, reads
 * the JSON report it always writes to `.gatetest/reports/`, and maps
 * the result to the framework's finding shape:
 *
 *   { module, severity, file, line, rule, message }
 *
 * Using the CLI as a subprocess (rather than importing src/core/runner.js
 * directly) is the right call for three reasons:
 *
 *   1. Exact same code path as customer scans — what reliability tests
 *      pass is what customers experience.
 *   2. Process isolation — a crashing module brings down the child,
 *      not the runner.
 *   3. Memory budget enforcement — we can ulimit / measure the child
 *      without affecting the orchestrator.
 *
 * Production uses node + the local gatetest binary; tests inject _exec
 * and _readReport adapters to run offline.
 */

"use strict";

const path = require("path");
const fs = require("fs");

/**
 * Find the most recently-modified JSON report file under
 * <projectRoot>/.gatetest/reports/. Returns the absolute path or null.
 */
function findLatestReport(projectRoot, _fs = fs) {
  const dir = path.join(projectRoot, ".gatetest", "reports");
  if (!_fs.existsSync(dir)) return null;
  const entries = _fs.readdirSync(dir);
  // Only consider files matching the actual gatetest report pattern.
  // The runner also writes `scan-history.json` (summary metadata) at
  // the end of each run — that file is newer than the report but isn't
  // the report. Picking the wrong one silently returns empty findings.
  const jsons = entries
    .filter((n) => n.endsWith(".json") && /gatetest-report/.test(n))
    .map((n) => ({ name: n, path: path.join(dir, n), mtimeMs: _fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return jsons.length > 0 ? jsons[0].path : null;
}

/**
 * Map a gatetest JSON report to the framework's findings shape.
 *
 * @param {object} report  parsed report JSON
 * @param {string} [projectRoot] base for relative paths
 * @returns {Array<object>} findings array
 */
function reportToFindings(report, projectRoot) {
  if (!report || !Array.isArray(report.results)) return [];
  const findings = [];
  for (const moduleResult of report.results) {
    if (!moduleResult || !Array.isArray(moduleResult.checks)) continue;
    for (const check of moduleResult.checks) {
      if (!check || check.passed) continue;
      const severity = String(check.severity || "info").toLowerCase();
      // Use the module's category as the module name in our finding
      // shape; this mirrors how the rest of the engine speaks.
      const finding = {
        module: moduleResult.module,
        severity,
        file: check.file || null,
        line: typeof check.line === "number" ? check.line : null,
        rule: check.name || null,
        message: check.message || "",
      };
      if (projectRoot && finding.file && path.isAbsolute(finding.file)) {
        // Make file paths workspace-relative for stability across boxes
        finding.file = path.relative(projectRoot, finding.file);
      }
      findings.push(finding);
    }
  }
  return findings;
}

/**
 * Default exec adapter — runs the gatetest CLI in a child process.
 */
const DEFAULT_EXEC = {
  async run(cmd, args, opts) {
    // eslint-disable-next-line global-require
    const cp = require("child_process");
    return new Promise((resolve) => {
      const child = cp.spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...(opts.env || {}) } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } },
        (opts.timeoutMs || 120_000));
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({
          exitCode: code,
          signal,
          stdout,
          stderr,
          killed: signal === "SIGKILL",
        });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ exitCode: -1, signal: null, stdout, stderr: stderr + String(err.message || err), killed: false });
      });
    });
  },
};

/**
 * Scan a code workspace by spawning gatetest CLI and parsing the
 * resulting JSON report.
 *
 * @param {object} args
 * @param {object} args.manifest         normalised manifest
 * @param {object} args.target           { type: "code", codeRoot }
 * @param {string} args.gatetestBin      path to gatetest CLI
 * @param {object} [args._exec]          injectable exec adapter
 * @param {object} [args._fs]            injectable fs for tests
 * @param {number} [args.timeoutMs]
 * @returns {Promise<{ findings: Array, peakMemoryMb: number|null, error?: string }>}
 */
async function scanCode({
  manifest,
  target,
  gatetestBin,
  _exec = DEFAULT_EXEC,
  _fs = fs,
  timeoutMs,
} = {}) {
  if (!target || target.type !== "code") {
    return { findings: [], peakMemoryMb: null, error: "target-not-code" };
  }
  if (!target.codeRoot) {
    return { findings: [], peakMemoryMb: null, error: "codeRoot-missing" };
  }
  if (!_fs.existsSync(target.codeRoot)) {
    return { findings: [], peakMemoryMb: null, error: "codeRoot-not-found" };
  }
  if (!gatetestBin) {
    return { findings: [], peakMemoryMb: null, error: "gatetestBin-missing" };
  }

  const tier = manifest && manifest.tier ? manifest.tier : "quick";
  const args = [
    gatetestBin,
    "--suite", tier,
    "--project", target.codeRoot,
    "--report-only", // never block from the CLI exit code; we read the report
  ];

  const r = await _exec.run("node", args, {
    cwd: target.codeRoot,
    timeoutMs: timeoutMs || (manifest && manifest.budgets && manifest.budgets.maxDurationMs ? manifest.budgets.maxDurationMs + 30_000 : 90_000),
  });

  if (r.killed) {
    return { findings: [], peakMemoryMb: null, error: "scanner-timed-out", durationStdout: r.stdout.slice(0, 1000) };
  }

  // The CLI may write the report regardless of exit code; try to read it.
  const reportPath = findLatestReport(target.codeRoot, _fs);
  if (!reportPath) {
    return {
      findings: [],
      peakMemoryMb: null,
      error: "report-not-found",
      stderr: r.stderr.slice(0, 1000),
    };
  }

  let report;
  try {
    report = JSON.parse(_fs.readFileSync(reportPath, "utf8"));
  } catch (err) {
    return {
      findings: [],
      peakMemoryMb: null,
      error: `report-parse-failed: ${err.message || String(err)}`,
    };
  }

  const findings = reportToFindings(report, target.codeRoot);
  return {
    findings,
    peakMemoryMb: null,
    reportPath,
    exitCode: r.exitCode,
  };
}

/**
 * Build a code-scanner adapter compatible with createScannerAdapter()'s
 * `_codeScanner` slot.
 */
function createCodeScannerAdapter({ gatetestBin, _exec, _fs, timeoutMs } = {}) {
  return {
    scan: ({ manifest, target }) =>
      scanCode({ manifest, target, gatetestBin, _exec, _fs, timeoutMs }),
  };
}

module.exports = {
  scanCode,
  createCodeScannerAdapter,
  findLatestReport,
  reportToFindings,
};
