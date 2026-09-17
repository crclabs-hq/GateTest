#!/usr/bin/env node
'use strict';
/**
 * Self-scan green-count — ONE definition of "how many modules are green"
 * for the nightly dogfood self-scan (Doctrine #4/#7: generated from the
 * report, not hand-typed inline in a workflow).
 *
 * A module's own `errors` field (src/core/runner.js, ScanResult.errorChecks:
 * `checks.filter(c => !c.passed && !c.suppressed && c.severity === 'error')`)
 * is ALREADY suppression-aware — a finding silenced by .gatetestignore
 * (benchmarks/bench-target/**, corpus/broken-sites/**, reliability-corpus/**
 * — deliberately-bad fixture corpora, not defects in GateTest) is still
 * recorded on the check (visible, auditable) but excluded from `errors`.
 *
 * dogfood-nightly.yml used to recompute "green" inline with
 * `checks.every(c => c.passed || c.severity !== 'error')`, which has no
 * concept of `suppressed` at all — so a module the actual GATE (and
 * `gatetest --module <name>`) reported PASSED with 0 blocking errors still
 * counted as "not green" in the "N/85 green" number the nightly writes to
 * the website. Measured 2026-09-16: codeQuality and security both showed
 * `errors: 0, suppressedChecks: 5` / `8` and GATE: PASSED while the inline
 * computation counted them red — the exclusions were correct, the COUNTING
 * was the defendant.
 */

const fs = require('fs');

/**
 * @param {{results?: Array<{errors?: number}>}} report
 * @returns {{ green: number, scanned: number }}
 */
function computeGreenCount(report) {
  const mods = (report && report.results) || [];
  const scanned = mods.length;
  const green = mods.filter((m) => (m.errors || 0) === 0).length;
  return { green, scanned };
}

function main(argv) {
  const reportPath = argv[0] || '.gatetest/reports/gatetest-report-latest.json';
  const envPath = argv[1] || '.dogfood/self-green.env';
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
  const { green, scanned } = computeGreenCount(report);
  fs.writeFileSync(envPath, `GREEN=${green}\nSCANNED=${scanned}\n`);
  process.stdout.write(`self-scan: ${green}/${scanned} modules green\n`);
  return { green, scanned };
}

module.exports = { computeGreenCount, main };

if (require.main === module) {
  main(process.argv.slice(2));
}
