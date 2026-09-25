'use strict';
/**
 * One resolved-path helper for every on-disk artifact GateTest writes into
 * the SCANNED repo: the JSON/HTML/compliance reports and the two memory
 * stores (`.gatetest/memory.json`, `.gatetest/memory/*.json`).
 *
 * Customer complaint C22 (2026-09-25): every scan wrote ~134 KB into the
 * scanned checkout with no CLI opt-out — a CI runner, a monorepo, or anyone
 * scanning a read-only tree got a dirty `git status` it could not avoid.
 * `--report-dir` / `GATETEST_REPORT_DIR` relocate all of it to one place;
 * `--no-artifacts` / `GATETEST_NO_ARTIFACTS=1` writes none of it. Both are
 * normalized into the env vars below by `bin/gatetest.js` BEFORE the
 * `GateTestConfig` and any memory store is constructed, so this file is the
 * single place that decides precedence (CLI flag > env var > `.gatetest.json`
 * `reporting.outputDir` > hardcoded default) for every consumer — reporters
 * that hold a `config` object and memory writers that only hold a bare
 * `projectRoot` string both resolve through here (doctrine #4: one
 * definition, imported).
 */

const path = require('path');

/** Default reports directory, relative to the project root. */
const DEFAULT_REPORT_DIR = '.gatetest/reports';

/** Default root the memory stores live under, relative to the project root. */
const DEFAULT_ROOT_DIR = '.gatetest';

/** `--report-dir <path>` / `GATETEST_REPORT_DIR` — redirects every reporter. */
const ENV_REPORT_DIR = 'GATETEST_REPORT_DIR';

/** `--no-artifacts` / `GATETEST_NO_ARTIFACTS=1` — suppresses every disk write. */
const ENV_NO_ARTIFACTS = 'GATETEST_NO_ARTIFACTS';

/**
 * Absolute reports directory for this config. Every reporter that writes
 * under `reporting.outputDir` (json/html/compliance) and the CLI's own
 * report reader (`gatetest --report`) call this instead of each re-deriving
 * `config.get('reporting.outputDir') || DEFAULT_REPORT_DIR` + `path.resolve`.
 *
 * @param {{ get(key: string): any, projectRoot: string }} config
 */
function resolveReportDir(config) {
  const configured = config.get('reporting.outputDir') || DEFAULT_REPORT_DIR;
  return path.resolve(config.projectRoot, configured);
}

/**
 * Absolute root the memory stores write under. Mirrors `resolveReportDir`
 * but reads the env var directly rather than through a `config` object,
 * because every memory call site (`src/core/runner.js`, `src/core/noise-
 * model.js`, `src/core/scan-telemetry.js`, `src/modules/spine-health.js`,
 * `src/index.js`) holds only a bare `projectRoot` string.
 *
 * When `--report-dir` / `GATETEST_REPORT_DIR` has redirected reports away
 * from the default, memory relocates to that SAME path (not underneath a
 * second `.gatetest` inside it) — a directory the customer named is the one
 * place they agreed GateTest may write, full stop. Otherwise memory keeps
 * living at the historical `<project>/.gatetest` root.
 *
 * @param {string} projectRoot
 */
function resolveMemoryRoot(projectRoot) {
  const override = process.env[ENV_REPORT_DIR];
  if (override) return path.resolve(projectRoot, override);
  return path.join(projectRoot, DEFAULT_ROOT_DIR);
}

/** Are on-disk artifacts (reports + memory) suppressed for this process? */
function artifactsDisabled() {
  return process.env[ENV_NO_ARTIFACTS] === '1';
}

module.exports = {
  DEFAULT_REPORT_DIR,
  DEFAULT_ROOT_DIR,
  ENV_REPORT_DIR,
  ENV_NO_ARTIFACTS,
  resolveReportDir,
  resolveMemoryRoot,
  artifactsDisabled,
};
