/**
 * Reliability — CLI runner.
 *
 * Pure-logic entry point used by `bin/gatetest-reliability.js`. Loads
 * the corpus, builds the scanner adapter, runs the suite, formats the
 * report. Separated from the thin shim so the orchestration is
 * unit-testable without spawning a process.
 *
 * Painkiller philosophy (Bible Forbidden #25): the CLI NEVER exits
 * non-zero on test-case failures. The reliability run is informational;
 * it produces a report that the nightly workflow opens as a PR when
 * regressions are detected. Hard non-zero exit only on outright bugs
 * (invalid args, corpus not found, etc.).
 */

"use strict";

const path = require("path");
const { loadCorpus, renderCorpusSummary } = require("./corpus-loader.js");
const { runSuite } = require("./runner.js");
const { createScannerAdapter } = require("./scanner-adapter.js");
const { createCodeScannerAdapter } = require("./code-scanner-adapter.js");

/**
 * Run the reliability sweep.
 *
 * @param {object} args
 * @param {string} args.corpusRoot
 * @param {string} args.gatetestBin           path to the gatetest CLI
 * @param {string[]} [args.includeCategories] only run these categories
 * @param {boolean} [args.repeatForDeterminism]
 * @param {string} [args.urlOnly]             only run url-* cases
 * @param {string} [args.codeOnly]            only run code-target cases
 * @param {boolean} [args.json]               emit JSON (else markdown)
 * @param {function} [args._fetch]
 * @param {object}   [args._fs]
 * @param {object}   [args._exec]
 * @returns {Promise<{ exitCode: number, output: string, summary: object }>}
 */
async function runReliabilityCli({
  corpusRoot,
  gatetestBin,
  includeCategories,
  repeatForDeterminism = false,
  urlOnly = false,
  codeOnly = false,
  json = false,
  _fetch,
  _fs,
  _exec,
} = {}) {
  if (!corpusRoot) {
    return { exitCode: 2, output: "corpusRoot is required", summary: null };
  }

  const loaded = loadCorpus(corpusRoot, _fs);
  if (loaded.cases.length === 0) {
    return {
      exitCode: 2,
      output: `No valid cases in ${corpusRoot}\n${renderCorpusSummary(loaded)}`,
      summary: null,
    };
  }

  // Filter cases by flags
  let filtered = loaded.cases;
  if (Array.isArray(includeCategories) && includeCategories.length > 0) {
    const set = new Set(includeCategories);
    filtered = filtered.filter((c) => set.has(c.manifest.category));
  }
  if (urlOnly) filtered = filtered.filter((c) => c.manifest.category.startsWith("url-"));
  if (codeOnly) filtered = filtered.filter((c) => !c.manifest.category.startsWith("url-"));

  if (filtered.length === 0) {
    return { exitCode: 0, output: "No cases match the supplied filters", summary: { total: 0 } };
  }

  // Build the scanner adapter. The code scanner is optional — if the
  // caller didn't supply a gatetest bin, code cases skip with an
  // explicit error rather than dying.
  const codeScanner = gatetestBin
    ? createCodeScannerAdapter({ gatetestBin, _fs, _exec })
    : null;
  const adapter = createScannerAdapter({ _fetch, _codeScanner: codeScanner });

  // codeRoots map (case name → codeRoot)
  const codeRoots = {};
  for (const c of filtered) codeRoots[c.manifest.name] = c.codeRoot;

  const suite = await runSuite({
    cases: filtered.map((c) => c.manifest),
    scanner: adapter,
    codeRoots,
    repeatForDeterminism,
  });

  const output = json ? JSON.stringify(suite, null, 2) : renderSuiteMarkdown(suite, loaded);
  return {
    exitCode: 0, // never exit non-zero on case failures — painkiller philosophy
    output,
    summary: {
      total: suite.total,
      passed: suite.passed,
      failed: suite.failed,
      passRate: suite.passRate,
      durationMs: suite.durationMs,
      invalidManifests: loaded.invalid.length,
    },
  };
}

function renderSuiteMarkdown(suite, loaded) {
  const lines = [];
  lines.push("# Reliability suite — run report");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Cases | ${suite.total} |`);
  lines.push(`| Passed | ${suite.passed} |`);
  lines.push(`| Failed | ${suite.failed} |`);
  lines.push(`| Pass rate | ${(suite.passRate * 100).toFixed(1)}% |`);
  lines.push(`| Duration | ${suite.durationMs}ms |`);
  if (loaded && loaded.invalid.length > 0) {
    lines.push(`| Invalid manifests | ${loaded.invalid.length} |`);
  }
  lines.push("");

  const failing = suite.results.filter((r) => !r.passed);
  if (failing.length > 0) {
    lines.push(`## Failing cases (${failing.length})`);
    lines.push("");
    for (const r of failing) {
      lines.push(`### \`${r.name}\` — ${r.category} / ${r.target}`);
      lines.push("");
      for (const issue of r.issues) lines.push(`- ${issue}`);
      if (r.totals) {
        lines.push(`- totals: errors=${r.totals.errors}, warnings=${r.totals.warnings}`);
      }
      lines.push(`- duration: ${r.durationMs}ms`);
      lines.push("");
    }
  } else {
    lines.push("✅ All cases passed.");
  }
  return lines.join("\n");
}

module.exports = {
  runReliabilityCli,
  renderSuiteMarkdown,
};
