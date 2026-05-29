#!/usr/bin/env node
/**
 * gatetest-doctor — CLI entry for the CI Doctor (v0.4c).
 *
 * Thin shim over `website/app/lib/ci-doctor/diagnose.js`. Parses args
 * via `cli-args.js`, calls diagnose(), prints the report.
 *
 * Painkiller philosophy (Bible Forbidden #25): NEVER exits non-zero
 * on diagnose findings. The diagnose() call is informational; CI is
 * the enforcement layer. Only exits non-zero on outright crashes /
 * bad usage.
 *
 * Examples:
 *   gatetest-doctor --owner crclabs-hq --repo GateTest --pr 42
 *   gatetest-doctor --owner x --repo y --run 12345 --apply
 *
 * The script reads from `website/app/lib/ci-doctor/` — relative path
 * is anchored at this file's parent directory.
 */

"use strict";

const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { parseDoctorArgs, USAGE } = require(path.join(ROOT, "website/app/lib/ci-doctor/cli-args.js"));
const { diagnose, renderReport } = require(path.join(ROOT, "website/app/lib/ci-doctor/diagnose.js"));

async function main() {
  const args = parseDoctorArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }

  if (args.errors.length > 0) {
    process.stderr.write(`\n[gatetest-doctor] argument errors:\n`);
    for (const e of args.errors) process.stderr.write(`  - ${e}\n`);
    process.stderr.write(`\n${USAGE}\n`);
    return 2;
  }

  const workspaceRoot = args.workspaceRoot || process.cwd();
  const recipeContext = {
    workflowPaths: args.workflowPaths,
  };

  let report;
  try {
    report = await diagnose({
      owner: args.owner,
      repo: args.repo,
      runId: args.runId,
      prNumber: args.prNumber,
      workspaceRoot,
      recipeContext,
      apply: args.apply,
      autoApplyReviewRequired: args.autoApplyReviewRequired,
      token: args.token,
    });
  } catch (err) {
    process.stderr.write(`[gatetest-doctor] diagnose failed: ${err.message || String(err)}\n`);
    return 2;
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(renderReport(report) + "\n");
  }

  // Painkiller philosophy: never exit non-zero on diagnose findings.
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`[gatetest-doctor] fatal: ${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(2);
  });
