#!/usr/bin/env node

/**
 * gatetest baseline --init — the onboarding wizard (LAUNCH_BOARD row 15 /
 * the Fifty, move 15).
 *
 * `gatetest --baseline` (src/core/baseline.js) already snapshots every
 * current finding into `.gatetest/baseline.json` so later runs only fail on
 * NEW findings — the mechanism a mature repo needs on day one to avoid
 * eating years of backlog. This command is the SAME capture, run through
 * one guided flow: it scans, captures, and then tells the operator exactly
 * what to do next — instead of leaving them to piece together the snippet
 * and CI wiring from `gatetest --help`.
 *
 * Nothing here duplicates the capture logic (doctrine #4 — one definition):
 * this is a thin wrapper around the same GateTest/GateTestRunner path
 * `bin/gatetest.js`'s default scan uses, with `captureBaseline: true`, the
 * console reporter silenced, and its own recap built from the summary the
 * run already produces (`summary.baseline`, `src/core/runner.js`).
 *
 * Writes nothing outside `.gatetest/` — `src/core/baseline.js` resolves its
 * path through `src/core/report-paths.js` `resolveMemoryRoot` (move 17), so
 * `--report-dir` / `GATETEST_REPORT_DIR` relocate this exactly like every
 * other on-disk artifact.
 */

'use strict';

const path = require('path');

const GRACE_PERIOD_DAYS = 14;

const HELP = `
  gatetest baseline --init [options]

  Onboarding wizard: scans the project, captures every current finding into
  .gatetest/baseline.json ("clean as you code" — see \`gatetest --help\` for
  the plain --baseline flag this wraps), and prints:
    - how many findings were grandfathered, per module
    - the exact .gatetest.json snippet for a time-boxed report-only grace
      period (--report-only-until, move 15), set ${GRACE_PERIOD_DAYS} days out
    - the CI command line that enforces on NEW findings only

  USAGE
    gatetest baseline --init
    gatetest baseline --init --suite full --project ./my-repo

  OPTIONS
    --project <path>   Project root (default: cwd)
    --suite <name>     Suite to scan for the snapshot (default: standard,
                        matching the plain --baseline flag)
    --json             Print the recap as JSON instead of text
    --help             Show this help
`;

/** UTC ISO date (`YYYY-MM-DD`) `days` days after `now`. Injectable for tests. */
function isoDatePlusDays(days, now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function buildRecap({ baseline, suite, projectRoot, untilDate }) {
  const ciLine = `node bin/gatetest.js --suite ${suite} --sarif --junit --parallel --project ${projectRoot === process.cwd() ? '.' : projectRoot}`;
  return {
    captured: baseline.captured || 0,
    byModule: baseline.byModule || {},
    path: baseline.path,
    reportOnlyUntil: untilDate,
    configSnippet: { reportOnlyUntil: untilDate },
    ciLine,
  };
}

function printRecap(recap) {
  console.log('');
  console.log(`[GateTest] Baseline captured: ${recap.captured} finding(s) grandfathered.`);
  console.log(`[GateTest] Written to: ${recap.path}`);

  const modules = Object.keys(recap.byModule).sort((a, b) => recap.byModule[b] - recap.byModule[a]);
  if (modules.length > 0) {
    console.log('');
    console.log('  Per module:');
    for (const m of modules) {
      console.log(`    ${String(recap.byModule[m]).padStart(4)}  ${m}`);
    }
  }

  console.log('');
  console.log('[GateTest] Commit .gatetest/baseline.json — later runs only fail on NEW findings.');
  console.log('');
  console.log(`[GateTest] Optional: a ${GRACE_PERIOD_DAYS}-day report-only grace period while your team triages the rest.`);
  console.log('[GateTest] Add to .gatetest.json:');
  console.log('');
  console.log(JSON.stringify(recap.configSnippet, null, 2).split('\n').map((l) => `  ${l}`).join('\n'));
  console.log('');
  console.log(`[GateTest] Or pass it directly on the CLI: --report-only-until ${recap.reportOnlyUntil}`);
  console.log('');
  console.log('[GateTest] CI enforces on NEW findings only once the baseline file is committed — no flag needed:');
  console.log(`  ${recap.ciLine}`);
  console.log('');
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return 0;
  }
  if (!argv.includes('--init')) {
    console.error('gatetest baseline: nothing to do without --init. Run `gatetest baseline --init`, or `gatetest --baseline` for a single capture with no recap.');
    console.log(HELP);
    return 2;
  }

  const { projectPathProblem } = require('../src/core/cli-args');
  const pidx = argv.indexOf('--project');
  const projectRoot = pidx !== -1 ? path.resolve(argv[pidx + 1]) : process.cwd();
  const problem = projectPathProblem(projectRoot);
  if (problem) {
    console.error(`gatetest baseline: ${problem}`);
    console.error('[GateTest] Nothing was scanned.');
    return 2;
  }

  const sidx = argv.indexOf('--suite');
  const suite = sidx !== -1 ? argv[sidx + 1] : 'standard';
  const jsonMode = argv.includes('--json');

  const { GateTest } = require('../src/index');
  const gatetest = new GateTest(projectRoot, {
    captureBaseline: true,
    // This wizard prints its own recap — the console reporter's per-module
    // stream would just be noise ahead of it.
    silent: true,
  });
  gatetest.init();
  const summary = await gatetest.runSuite(suite);

  const baseline = summary.baseline || {};
  if (baseline.error) {
    console.error(`gatetest baseline: capture failed — ${baseline.error}`);
    return 1;
  }

  const untilDate = isoDatePlusDays(GRACE_PERIOD_DAYS);
  const recap = buildRecap({ baseline, suite, projectRoot, untilDate });

  if (jsonMode) {
    console.log(JSON.stringify(recap, null, 2));
    return 0;
  }

  printRecap(recap);
  return 0;
}

module.exports = { main, isoDatePlusDays, buildRecap, GRACE_PERIOD_DAYS };
