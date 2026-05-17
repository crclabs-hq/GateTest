/**
 * GateTest Sweep — step runners.
 *
 * Each step is a pure function that runs ONE check, captures stdout/stderr,
 * times it, and returns a structured result. The orchestrator in
 * bin/gatetest-sweep.js composes these into the full sweep.
 *
 * Why this exists: the Bible's sweep checklist is currently five separate
 * commands a developer has to run (or skip) before pushing. CI runs them in
 * the pre-merge-sweep job. This module makes the same set runnable locally
 * in one shot, with a clear pass/fail verdict.
 *
 * Each step runner returns:
 *   {
 *     ok: boolean,            // false = blocking failure
 *     summary: string,        // one-line human-readable
 *     durationMs: number,
 *     stdout: string,
 *     stderr: string,
 *     exitCode: number | null,
 *     errorCount?: number,    // when applicable (gate)
 *     warningCount?: number,
 *     skipped?: boolean,      // true if precondition prevented running
 *     skipReason?: string,
 *   }
 *
 * No new dependencies. CommonJS. Node stdlib only.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// The secret-pattern enforced by .github/workflows/ci.yml's pre-merge-sweep
// job. Kept in sync deliberately — if CI tightens, sweep tightens.
const SECRET_PATTERN = /AKIA[0-9A-Z]{16}|AKIB[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|sk_live_[0-9a-zA-Z]{24,}|sk_test_[0-9a-zA-Z]{24,}|ghp_[0-9a-zA-Z]{36,}|github_pat_[0-9a-zA-Z_]{60,}|glpat-[0-9a-zA-Z_-]{20,}|SG\.[0-9a-zA-Z_-]{22,}\.[0-9a-zA-Z_-]{43,}/;

// Paths excluded from the secret sweep (mirrors CI's `grep -Ev` filter).
const SECRET_EXCLUDE_PREFIXES = ['.gitignore', '.env.example', 'tests/', 'docs/'];

function now() {
  return Date.now();
}

/**
 * Spawn a child process synchronously and return a stable result envelope.
 * Catches every error: missing binary, non-zero exit, timeout. Never throws.
 */
function runProcess(cmd, args, opts = {}) {
  const start = now();
  let stdout = '';
  let stderr = '';
  let exitCode = null;
  let spawnError = null;

  try {
    const res = spawnSync(cmd, args, {
      cwd: opts.cwd || process.cwd(),
      env: { ...process.env, ...(opts.env || {}) },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: opts.timeout || 0,
      shell: opts.shell || false,
    });
    stdout = res.stdout || '';
    stderr = res.stderr || '';
    exitCode = res.status;
    if (res.error) spawnError = res.error;
    if (res.signal) {
      spawnError = spawnError || new Error(`process killed by signal ${res.signal}`);
    }
  } catch (err) {
    // spawnSync should never throw with encoding set, but belt-and-braces
    spawnError = err;
  }

  return {
    durationMs: now() - start,
    stdout,
    stderr,
    exitCode,
    spawnError,
  };
}

/**
 * STEP 1 — Tests. `node --test tests/*.test.js`.
 * Pass when exit code is 0. Summary extracts "tests N pass" or "tests N fail".
 */
function runTestsStep({ cwd, runner } = {}) {
  const exec = runner || runProcess;
  // We use shell:true with a glob so we don't have to enumerate tests/*
  // ourselves. The CI workflow runs the same shape.
  const r = exec('sh', ['-c', 'node --test tests/*.test.js'], { cwd, shell: false });

  if (r.spawnError) {
    return {
      ok: false,
      summary: `Could not run tests: ${r.spawnError.message || r.spawnError}`,
      durationMs: r.durationMs,
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode,
    };
  }

  const passMatch = (r.stdout + r.stderr).match(/# pass (\d+)/);
  const failMatch = (r.stdout + r.stderr).match(/# fail (\d+)/);
  const testsMatch = (r.stdout + r.stderr).match(/# tests (\d+)/);

  const passed = passMatch ? Number(passMatch[1]) : null;
  const failed = failMatch ? Number(failMatch[1]) : null;
  const total = testsMatch ? Number(testsMatch[1]) : null;

  let summary;
  if (total != null && passed != null) {
    summary = `${passed} / ${total} passed`;
    if (failed && failed > 0) summary += ` (${failed} failed)`;
  } else if (r.exitCode === 0) {
    summary = 'all passed';
  } else {
    summary = `exit ${r.exitCode}`;
  }

  return {
    ok: r.exitCode === 0,
    summary,
    durationMs: r.durationMs,
    stdout: r.stdout,
    stderr: r.stderr,
    exitCode: r.exitCode,
    testsPassed: passed,
    testsTotal: total,
    testsFailed: failed,
  };
}

/**
 * STEP 2 — Website build. `cd website && npx next build`.
 * Skipped when website/ doesn't exist (not every consumer has one).
 */
function runWebsiteBuildStep({ cwd, runner } = {}) {
  const root = cwd || process.cwd();
  const websiteDir = path.join(root, 'website');
  if (!fs.existsSync(websiteDir) || !fs.statSync(websiteDir).isDirectory()) {
    return {
      ok: true,
      skipped: true,
      skipReason: 'no website/ directory',
      summary: 'skipped (no website/)',
      durationMs: 0,
      stdout: '',
      stderr: '',
      exitCode: null,
    };
  }
  const exec = runner || runProcess;
  const r = exec('npx', ['next', 'build'], { cwd: websiteDir });

  if (r.spawnError) {
    return {
      ok: false,
      summary: `Could not run next build: ${r.spawnError.message || r.spawnError}`,
      durationMs: r.durationMs,
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode,
    };
  }

  const out = r.stdout + r.stderr;
  // Next.js emits "Generating static pages (N/N)" or "Route (app)" tables.
  // Cheap signal: count "Generating static pages (N/N)" then "○" + "ƒ" markers.
  const pageCountMatch = out.match(/Generating static pages \(\d+\/(\d+)\)/);
  const pageCount = pageCountMatch ? Number(pageCountMatch[1]) : null;

  const summary = r.exitCode === 0
    ? (pageCount != null ? `${pageCount} pages, no errors` : 'no errors')
    : `build failed (exit ${r.exitCode})`;

  return {
    ok: r.exitCode === 0,
    summary,
    durationMs: r.durationMs,
    stdout: r.stdout,
    stderr: r.stderr,
    exitCode: r.exitCode,
    pageCount,
  };
}

/**
 * STEP 3 — Module load. `node bin/gatetest.js --list`.
 * Asserts the line count is at least 90 (the Bible's contract). Mirrors CI.
 */
function runModuleLoadStep({ cwd, runner, minModules = 90 } = {}) {
  const root = cwd || process.cwd();
  const exec = runner || runProcess;
  const r = exec('node', ['bin/gatetest.js', '--list'], { cwd: root });

  if (r.spawnError) {
    return {
      ok: false,
      summary: `Could not run --list: ${r.spawnError.message || r.spawnError}`,
      durationMs: r.durationMs,
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode,
    };
  }

  // The --list output is "  <name>    <description>" per module, with a
  // header banner. Count lines that look like module entries: 2-space
  // indent followed by an identifier and whitespace.
  const lines = r.stdout.split(/\n/);
  const moduleLines = lines.filter((l) => /^\s{2}[a-zA-Z][a-zA-Z0-9_-]+\s/.test(l));
  const moduleCount = moduleLines.length;

  const ok = r.exitCode === 0 && moduleCount >= minModules;
  let summary;
  if (r.exitCode !== 0) summary = `exit ${r.exitCode}`;
  else if (moduleCount < minModules) summary = `only ${moduleCount} modules loaded (need ≥ ${minModules})`;
  else summary = `${moduleCount} modules`;

  return {
    ok,
    summary,
    durationMs: r.durationMs,
    stdout: r.stdout,
    stderr: r.stderr,
    exitCode: r.exitCode,
    moduleCount,
  };
}

/**
 * STEP 4 — Gate (quick suite). `node bin/gatetest.js --suite quick`.
 * Pass = exit 0. Extracts error/warning counts from the run output.
 */
function runGateStep({ cwd, runner, suite = 'quick' } = {}) {
  const root = cwd || process.cwd();
  const exec = runner || runProcess;
  const r = exec('node', ['bin/gatetest.js', '--suite', suite], { cwd: root });

  // ConsoleReporter prints lines like "Errors: <ANSI>N<ANSI>" — strip
  // the ANSI escape sequences before parsing so the numbers come through.
  const raw = r.stdout + r.stderr;
  // eslint-disable-next-line no-control-regex
  const out = raw.replace(/\x1b\[[0-9;]*m/g, '');
  const errMatch = out.match(/(?:^|\n)\s*(?:Errors?|ERRORS?)\s*:?\s*(\d+)/);
  const warnMatch = out.match(/(?:^|\n)\s*(?:Warnings?|WARNINGS?)\s*:?\s*(\d+)/);
  const errorCount = errMatch ? Number(errMatch[1]) : null;
  const warningCount = warnMatch ? Number(warnMatch[1]) : null;

  if (r.spawnError) {
    return {
      ok: false,
      summary: `Could not run gate: ${r.spawnError.message || r.spawnError}`,
      durationMs: r.durationMs,
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode,
    };
  }

  let summary;
  if (r.exitCode === 0) {
    if (errorCount != null || warningCount != null) {
      summary = `${errorCount || 0} errors, ${warningCount || 0} warnings`;
    } else {
      summary = 'gate passed';
    }
  } else {
    const e = errorCount != null ? errorCount : '?';
    const w = warningCount != null ? warningCount : '?';
    summary = `${e} errors, ${w} warnings`;
  }

  return {
    ok: r.exitCode === 0,
    summary,
    durationMs: r.durationMs,
    stdout: r.stdout,
    stderr: r.stderr,
    exitCode: r.exitCode,
    errorCount: errorCount || 0,
    warningCount: warningCount || 0,
  };
}

/**
 * STEP 5 — Secrets in tracked files. Same pattern as the CI workflow.
 * Runs `git ls-files` then scans each tracked file for SECRET_PATTERN.
 * Never network-fetches. Pure file IO.
 */
function runSecretsStep({ cwd, runner } = {}) {
  const root = cwd || process.cwd();
  const exec = runner || runProcess;
  const start = now();

  const filesResult = exec('git', ['ls-files'], { cwd: root });
  if (filesResult.spawnError || filesResult.exitCode !== 0) {
    return {
      ok: false,
      summary: 'git ls-files failed',
      durationMs: now() - start,
      stdout: filesResult.stdout || '',
      stderr: filesResult.stderr || (filesResult.spawnError && filesResult.spawnError.message) || '',
      exitCode: filesResult.exitCode,
    };
  }

  const files = filesResult.stdout
    .split(/\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((f) => !SECRET_EXCLUDE_PREFIXES.some((pref) => f === pref || f.startsWith(pref)));

  const hits = [];
  for (const rel of files) {
    const abs = path.join(root, rel);
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (!stat.isFile()) continue;
    if (stat.size > 2 * 1024 * 1024) continue; // skip files > 2MB
    let content;
    try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const lines = content.split(/\n/);
    for (let i = 0; i < lines.length; i++) {
      if (SECRET_PATTERN.test(lines[i])) {
        hits.push(`${rel}:${i + 1}`);
        if (hits.length >= 50) break;
      }
    }
    if (hits.length >= 50) break;
  }

  const durationMs = now() - start;
  const ok = hits.length === 0;
  return {
    ok,
    summary: ok ? 'none found' : `${hits.length} suspected secrets`,
    durationMs,
    stdout: ok ? '' : hits.join('\n'),
    stderr: '',
    exitCode: ok ? 0 : 1,
    hits,
  };
}

/**
 * STEP 6 — TODO/FIXME count. INFORMATIONAL ONLY. Never fails the sweep.
 */
function runTodoCountStep({ cwd, runner } = {}) {
  const root = cwd || process.cwd();
  const exec = runner || runProcess;
  // git grep is the most accurate (respects .gitignore + tracked-only).
  // Mirrors the CI workflow's filter set.
  const r = exec('git', [
    'grep', '-EnI', 'TODO|FIXME', '--',
    'src/**/*.js', 'src/**/*.ts',
    'website/app/**/*.ts', 'website/app/**/*.tsx', 'website/app/**/*.js',
  ], { cwd: root });

  // git grep exits 1 when there are no matches — that's "0 TODOs", not a failure
  const matches = (r.stdout || '').split(/\n/).filter(Boolean);
  const count = matches.length;

  return {
    ok: true, // never fails
    summary: `${count} occurrences (informational)`,
    durationMs: r.durationMs,
    stdout: r.stdout,
    stderr: r.stderr,
    exitCode: r.exitCode,
    todoCount: count,
  };
}

/**
 * STEP 7 — Self-scan dogfood. Same gate as step 4.
 * In the actual orchestrator we typically reuse step 4's result and mark
 * this as cached. This standalone runner is here for --only 7 / tests.
 */
function runSelfScanStep({ cwd, runner, suite = 'quick' } = {}) {
  return runGateStep({ cwd, runner, suite });
}

const ALL_STEPS = [
  { number: 1, key: 'tests', name: 'Tests', run: runTestsStep },
  { number: 2, key: 'build', name: 'Website build', run: runWebsiteBuildStep },
  { number: 3, key: 'modules', name: 'Module load', run: runModuleLoadStep },
  { number: 4, key: 'gate', name: 'Gate (quick suite)', run: runGateStep },
  { number: 5, key: 'secrets', name: 'Secrets in tracked files', run: runSecretsStep },
  { number: 6, key: 'todos', name: 'TODO/FIXME count', run: runTodoCountStep },
  { number: 7, key: 'selfscan', name: 'Self-scan dogfood', run: runSelfScanStep },
];

/**
 * Resolve a `--only` argument (1..7 or step key like "gate" / "tests")
 * to a single step descriptor. Returns null if no match.
 */
function resolveStep(selector) {
  if (selector == null) return null;
  const s = String(selector).trim().toLowerCase();
  // numeric?
  const asNum = Number.parseInt(s, 10);
  if (!Number.isNaN(asNum)) {
    return ALL_STEPS.find((st) => st.number === asNum) || null;
  }
  return ALL_STEPS.find((st) => st.key === s || st.name.toLowerCase() === s) || null;
}

module.exports = {
  ALL_STEPS,
  resolveStep,
  runProcess,
  // individual runners (exposed for testing)
  runTestsStep,
  runWebsiteBuildStep,
  runModuleLoadStep,
  runGateStep,
  runSecretsStep,
  runTodoCountStep,
  runSelfScanStep,
  // constants (exposed for assertion in tests)
  SECRET_PATTERN,
  SECRET_EXCLUDE_PREFIXES,
};
