#!/usr/bin/env node

/**
 * GateTest Sweep — the Bible's pre-merge sweep checklist as a single
 * local command. CI-equivalent verdict (PASSED / BLOCKED), exit 0 or 1.
 *
 * Why: the sweep is currently five separate commands (and a CI workflow).
 * Locally, developers skip it and discover failures in CI. This unifies
 * the loop into one `gatetest sweep` invocation so the pre-push moment
 * is "run sweep, push if green."
 *
 *   $ node bin/gatetest-sweep.js           # full sweep
 *   $ node bin/gatetest-sweep.js --fast    # skip tests + build (~3s)
 *   $ node bin/gatetest-sweep.js --only gate
 *   $ node bin/gatetest-sweep.js --json    # JSON output
 *
 * Exit code: 0 if SWEEP: PASSED, 1 if SWEEP: BLOCKED.
 */

const path = require('path');
const { ALL_STEPS, resolveStep } = require('../lib/sweep-steps');

const HELP = `
  GateTest Sweep — the Bible's pre-merge sweep checklist in one command.

  USAGE
    gatetest sweep [options]
    node bin/gatetest-sweep.js [options]
    npm run sweep -- [options]

  WHAT IT RUNS
    1. Tests                       node --test tests/*.test.js
    2. Website build               cd website && npx next build
    3. Module load                 node bin/gatetest.js --list (≥ 90 modules)
    4. Gate (quick suite)          node bin/gatetest.js --suite quick
    5. Secrets in tracked files    same pattern set as CI's pre-merge-sweep
    6. TODO/FIXME count            informational, never fails
    7. Self-scan dogfood           reuses step 4 when both run
    8. Lint                        npx eslint src bin lib integrations

  OPTIONS
    --fast                  Skip steps 1 (tests) and 2 (website build).
                            Gate-only path, typically ~3-5s.
    --no-build              Skip step 2 only.
    --no-tests              Skip step 1 only.
    --only <step>           Run only one step. Selector is the step number
                            (1-8) or its key (tests, build, modules, gate,
                            secrets, todos, selfscan, lint).
    --json                  Emit JSON to stdout instead of human output.
    --quiet                 Suppress per-step progress; show only summary.
    --verbose               Include full stdout/stderr of each step.
    --working-dir <path>    Run against a different repo (default: cwd).
    --min-modules <n>       Override the >= 90 module-count assertion.
    --suite <name>          Override the gate suite (default: quick).
    --help, -h              Show this help.

  EXAMPLES
    npm run sweep                       Full sweep, human output
    npm run sweep -- --fast             Skip tests + build (gate-only)
    npm run sweep -- --only gate        Run only the quick-gate step
    npm run sweep -- --json | jq        Machine-readable verdict + stats
    npm run sweep -- --working-dir ~/other-repo

  WHY THIS IS DIFFERENT FROM CI
    CI runs the same checks on every PR — but only after you push. The
    sweep command runs them LOCALLY in ~30-60s so the broken state never
    reaches a CI minute. The exit code matches: green here = green there.

  THE BIBLE
    This command implements the sweep checklist defined in CLAUDE.md under
    "ALWAYS-ON MODE → The loop." It is the operational floor: every turn
    should end with a green sweep, otherwise the broken-then-fixed state
    must be captured in a commit before stopping.

  EXIT CODE CONTRACT
    0   SWEEP: PASSED     — green across every blocking step
    1   SWEEP: BLOCKED    — at least one blocking step failed
    2   Bad arguments
`;

function parseArgs(argv) {
  const args = {
    help: false,
    fast: false,
    noBuild: false,
    noTests: false,
    only: null,
    json: false,
    quiet: false,
    verbose: false,
    workingDir: null,
    minModules: null,
    suite: 'quick',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--fast') args.fast = true;
    else if (a === '--no-build') args.noBuild = true;
    else if (a === '--no-tests') args.noTests = true;
    else if (a === '--only' && argv[i + 1]) args.only = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '--working-dir' && argv[i + 1]) args.workingDir = argv[++i];
    else if (a === '--min-modules' && argv[i + 1]) args.minModules = parseInt(argv[++i], 10);
    else if (a === '--suite' && argv[i + 1]) args.suite = argv[++i];
    else if (a.startsWith('--')) {
      // Unknown flag — collect for an error response.
      args._unknown = args._unknown || [];
      args._unknown.push(a);
    }
  }
  return args;
}

function formatDuration(ms) {
  if (ms == null) return 'cached';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = (s - m * 60).toFixed(1);
  return `${m}m${rem}s`;
}

function padRight(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

/**
 * Render one step's status line.
 *
 *   [1/7] Tests                       ✓ 3690 / 3690 passed              (24.3s)
 */
function renderStepLine(step, idx, total, result) {
  const marker = result.skipped ? '-' : (result.ok ? '✓' : '✗');
  const num = `[${idx + 1}/${total}]`;
  const name = padRight(step.name, 28);
  const summary = padRight(result.summary || '', 36);
  const dur = formatDuration(result.durationMs);
  return `  ${num} ${name} ${marker} ${summary} (${dur})`;
}

/**
 * Decide which steps to run given the parsed flags.
 */
function selectSteps(args) {
  if (args.only != null) {
    const step = resolveStep(args.only);
    if (!step) return { error: `Unknown --only target: ${args.only}` };
    return { steps: [step] };
  }
  const out = [];
  for (const step of ALL_STEPS) {
    if (args.fast && (step.key === 'tests' || step.key === 'build')) continue;
    if (args.noTests && step.key === 'tests') continue;
    if (args.noBuild && step.key === 'build') continue;
    out.push(step);
  }
  return { steps: out };
}

/**
 * Build a short failure-detail block for human output.
 */
function renderFailureDetail(step, result) {
  const lines = [];
  lines.push(`    Step ${step.number} — ${step.name}: ${result.summary || `exit ${result.exitCode}`}`);
  if (step.key === 'gate' && Array.isArray(result.errors)) {
    for (const e of result.errors.slice(0, 5)) {
      lines.push(`      - ${e}`);
    }
  } else if (step.key === 'secrets' && Array.isArray(result.hits)) {
    for (const h of result.hits.slice(0, 5)) lines.push(`      - ${h}`);
  } else if (result.stderr) {
    const tail = result.stderr.trim().split(/\n/).slice(-5);
    for (const line of tail) lines.push(`      ${line}`);
  }
  return lines.join('\n');
}

/**
 * Render the closing block (verdict + remedy hints).
 */
function renderSummary(steps, results, totalMs) {
  const failures = steps
    .map((s, i) => ({ step: s, result: results[i] }))
    .filter(({ result }) => !result.ok && !result.skipped);

  const ok = failures.length === 0;
  const lines = [];
  lines.push('');
  lines.push('----------------------------------------');
  lines.push(
    ok
      ? `  SWEEP: PASSED   total time ${formatDuration(totalMs)}`
      : `  SWEEP: BLOCKED   total time ${formatDuration(totalMs)}`,
  );

  if (!ok) {
    lines.push('');
    lines.push(`  Failed checks:`);
    for (const f of failures) lines.push(renderFailureDetail(f.step, f.result));
    lines.push('');
    lines.push('  Fix the failures above before pushing. The CI pre-merge-sweep');
    lines.push('  workflow will refuse to let this through.');
    lines.push('');
    lines.push('  $ node bin/gatetest.js --module <name>            # focus on one module');
    lines.push('  $ node bin/gatetest.js --suite quick --auto-pr    # try the AI fix flywheel');
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Build the JSON envelope.
 */
function buildJson(steps, results, totalMs, verbose) {
  const failures = results
    .map((r, i) => ({ step: steps[i], result: r }))
    .filter(({ result }) => !result.ok && !result.skipped);
  const ok = failures.length === 0;
  const stepEntries = steps.map((s, i) => {
    const r = results[i];
    const entry = {
      number: s.number,
      key: s.key,
      name: s.name,
      ok: !!r.ok,
      skipped: !!r.skipped,
      durationMs: r.durationMs || 0,
      summary: r.summary || '',
      exitCode: r.exitCode != null ? r.exitCode : null,
    };
    if (r.skipReason) entry.skipReason = r.skipReason;
    if (r.errorCount != null) entry.errorCount = r.errorCount;
    if (r.warningCount != null) entry.warningCount = r.warningCount;
    if (r.testsTotal != null) entry.testsTotal = r.testsTotal;
    if (r.testsPassed != null) entry.testsPassed = r.testsPassed;
    if (r.testsFailed != null) entry.testsFailed = r.testsFailed;
    if (r.moduleCount != null) entry.moduleCount = r.moduleCount;
    if (r.pageCount != null) entry.pageCount = r.pageCount;
    if (r.todoCount != null) entry.todoCount = r.todoCount;
    if (r.hits != null) entry.hits = r.hits;
    if (verbose) {
      entry.stdout = r.stdout || '';
      entry.stderr = r.stderr || '';
    }
    return entry;
  });
  const errorStep = failures[0] ? failures[0].step.number : null;
  const errorCount = results.reduce((acc, r) => acc + (r.errorCount || 0), 0);
  const warningCount = results.reduce((acc, r) => acc + (r.warningCount || 0), 0);
  return {
    ok,
    verdict: ok ? 'PASSED' : 'BLOCKED',
    totalDurationMs: totalMs,
    steps: stepEntries,
    summary: { errorCount, warningCount, firstFailingStep: errorStep },
  };
}

/**
 * Main entry point. Returns an exit code (does NOT call process.exit
 * directly so unit tests can drive this with arbitrary argv).
 */
async function runSweep(argv, { stdout, runner } = {}) {
  const out = stdout || process.stdout;
  const args = parseArgs(argv);

  if (args.help) {
    out.write(HELP);
    return 0;
  }
  if (args._unknown && args._unknown.length) {
    out.write(`gatetest sweep: unknown flag(s): ${args._unknown.join(' ')}\n`);
    out.write(`Run with --help for usage.\n`);
    return 2;
  }

  const cwd = args.workingDir ? path.resolve(args.workingDir) : process.cwd();
  const selection = selectSteps(args);
  if (selection.error) {
    out.write(`gatetest sweep: ${selection.error}\n`);
    out.write(`Available steps: ${ALL_STEPS.map((s) => `${s.number}=${s.key}`).join(', ')}\n`);
    return 2;
  }
  const steps = selection.steps;

  if (!args.json && !args.quiet) {
    out.write(`GateTest Sweep — running ${steps.length} check${steps.length === 1 ? '' : 's'} against ${cwd}\n\n`);
  }

  const results = [];
  const start = Date.now();
  // STEP 7 (selfscan) can reuse step 4 (gate) when both run. Track this.
  let gateResult = null;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    let result;
    if (step.key === 'selfscan' && gateResult) {
      result = { ...gateResult, durationMs: null, summary: gateResult.ok ? 'green (same as step 4)' : 'red (same as step 4)' };
    } else {
      const opts = { cwd, runner };
      if (args.minModules != null && step.key === 'modules') opts.minModules = args.minModules;
      if (step.key === 'gate' || step.key === 'selfscan') opts.suite = args.suite;
      result = step.run(opts);
    }
    if (step.key === 'gate') gateResult = result;
    results.push(result);
    if (!args.json && !args.quiet) out.write(renderStepLine(step, i, steps.length, result) + '\n');
    if (args.verbose && !args.json) {
      if (result.stdout) out.write(`        --- stdout ---\n${indent(result.stdout, '        ')}\n`);
      if (result.stderr) out.write(`        --- stderr ---\n${indent(result.stderr, '        ')}\n`);
    }
  }

  const totalMs = Date.now() - start;

  if (args.json) {
    out.write(JSON.stringify(buildJson(steps, results, totalMs, args.verbose), null, 2) + '\n');
  } else {
    out.write(renderSummary(steps, results, totalMs));
  }

  const ok = results.every((r) => r.ok || r.skipped);
  return ok ? 0 : 1;
}

function indent(text, prefix) {
  return String(text).split(/\n/).map((l) => prefix + l).join('\n');
}

// CLI entry — only when invoked directly.
if (require.main === module) {
  runSweep(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      // Top-level safety net; should not happen in practice.
      process.stderr.write(`gatetest sweep crashed: ${err && err.stack || err}\n`);
      process.exit(2);
    });
}

module.exports = { runSweep, parseArgs, selectSteps, buildJson, renderStepLine, renderSummary };
