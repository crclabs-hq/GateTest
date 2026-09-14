/**
 * Mutation Testing Module - Verifies tests actually catch bugs.
 *
 * Applies real code mutations (operator swaps, boundary changes, return value flips)
 * and verifies that at least one test fails for each mutation. If all tests still pass
 * after a mutation, the test suite has a gap.
 *
 * This is the most aggressive testing technique available — it tests the tests themselves.
 */

const BaseModule = require('./base-module');
const { splitLines, joinLines } = require('../core/text-lines');
const { JS_SOURCE_EXTS_NO_JSX } = require('../core/source-extensions');
const fs = require('fs');
const path = require('path');
const { repoRelative } = require('../core/repo-path');
// Mutation operators extracted to a testable engine module so they can
// be unit-tested independently of the test-runner orchestration.
const { MUTATIONS, shouldSkipLine } = require('../core/mutation-engine');

// ─────────────────────────────────────────────────────────────────────────────
// Never write to the user's tree (the Fifty, move 20).
//
// This module used to write each mutant into the user's REAL source file,
// run their tests, and restore the original — with signal handlers to
// replay the restore on SIGINT/SIGTERM. Observed three times in one session
// before those handlers existed: `a - b` left as `a + b`, a `+` flipped
// inside a string literal, a mutant left in a config file. Handlers cannot
// cover SIGKILL or a power cut, and a scanner that can leave your working
// tree corrupt under any circumstance is worse than one that misses a bug.
//
// So mutants are now written into a SANDBOX COPY of the tree
// (src/core/tree-copy.js: every file except the walk-excluded dirs,
// node_modules symlinked) and the suite runs there. The user's files are
// never opened for writing. What survives a kill is a temp directory,
// removed on every exit path Node can observe and harmless if not.
// ─────────────────────────────────────────────────────────────────────────────
const { copyTreeForSandbox, removeTree } = require('../core/tree-copy');
const SANDBOXES = new Set();
let cleanupInstalled = false;
function removeAllSandboxes() {
  for (const d of SANDBOXES) removeTree(d);
  SANDBOXES.clear();
}
function installSandboxCleanup() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  process.on('exit', removeAllSandboxes);
  // A signal does not emit 'exit' unless something handles it: without
  // these, a SIGTERMed scan (a CI step past its limit, a Ctrl-C) leaves the
  // copy behind. Harmless to the user's tree either way — this is tidiness,
  // not safety — but tidiness is cheap.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try {
      process.on(sig, () => {
        removeAllSandboxes();
        process.exit(sig === 'SIGINT' ? 130 : 143);
      });
    } catch { /* error-ok: platform does not have this signal */ }
  }
}

class MutationModule extends BaseModule {
  constructor() {
    super('mutation', 'Mutation Testing — Tests the Tests');
    // Opt out of incremental: mutation testing needs to mutate source
    // and re-run the FULL test suite per mutation. Restricting to the
    // changed file's source mutations is fine, but most projects need
    // the full corpus to get a meaningful score, and CI already runs
    // mutation nightly (not on every PR) so the speedup isn't needed.
    this._respectsIncremental = false;
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const mutationConfig = config.getModuleConfig ? config.getModuleConfig('mutation') : {};
    const threshold = (mutationConfig && mutationConfig.threshold) || 80;
    const maxMutants = (mutationConfig && mutationConfig.maxMutants) || 50;

    // Detect test command
    const testCmd = this._detectTestCommand(projectRoot);
    if (!testCmd) {
      result.addCheck('mutation:detect', true, {
        message: 'No test framework detected — skipping mutation testing',
        severity: 'info',
      });
      return;
    }

    // Find source files (non-test files)
    const sourceFiles = this._findSourceFiles(projectRoot);
    if (sourceFiles.length === 0) {
      result.addCheck('mutation:sources', true, {
        message: 'No source files found for mutation testing',
        severity: 'info',
      });
      return;
    }

    // Mutation testing needs an INSTALLED, GREEN suite to be meaningful. A
    // repo whose deps are not installed here (fresh clone, no node_modules)
    // cannot be mutated — that is our environment, not the customer's
    // defect. Reported as an info skip; unitTests owns "your tests fail".
    // (2026-08-18 audit: this was a blocking error on express, NodeGoat and
    // this repo, and on a Python repo it mutated docs JS with `node --test`.)
    const pkgPath = path.join(projectRoot, 'package.json');
    if (fs.existsSync(pkgPath) && !fs.existsSync(path.join(projectRoot, 'node_modules'))) {
      result.addCheck('mutation:baseline', true, {
        severity: 'info',
        message: 'Skipped — dependencies are not installed, so the suite cannot run as a mutation baseline',
        suggestion: 'Run "npm ci" before scanning, or run mutation testing in CI',
      });
      return;
    }
    if (!fs.existsSync(pkgPath)) {
      result.addCheck('mutation:baseline', true, {
        severity: 'info',
        message: 'Skipped — mutation testing supports Node.js projects (package.json) only',
      });
      return;
    }

    // Verify tests pass before mutating.
    //
    // The baseline is also the MEASUREMENT that makes the rest of this module
    // honest. A mutant run used to get a hardcoded 30s; on any project whose
    // suite takes longer than that, every mutant timed out, every timeout was
    // read as a non-zero exit, and a non-zero exit was counted as "killed" —
    // so the module reported a perfect score without a single test ever
    // having finished. Measured on a fixture whose suite takes 35s:
    // "Mutation score: 100% (3/3 killed, 0 survived)", all three from
    // timeouts. That is the most dangerous number this engine can print: a
    // team reads it as "our tests are bulletproof".
    // The sandbox: mutants and every test run live in a copy; the user's
    // tree is never opened for writing. A copy that cannot be made is
    // reported as NOT RUN — never a silent fall back to mutating in place.
    const sandbox = copyTreeForSandbox(projectRoot, { prefix: 'gt-mutate-' });
    if (sandbox.error) {
      result.addCheck('mutation:sandbox', true, {
        severity: 'info',
        message: `Not run — could not copy the tree into a sandbox (${sandbox.error}). Your working tree was not touched.`,
        suggestion: 'Exclude build output from the tree, or run mutation testing in CI where the checkout is smaller',
      });
      return;
    }
    installSandboxCleanup();
    SANDBOXES.add(sandbox.dir);
    try {
      await this._runInSandbox(result, { projectRoot, sandbox, testCmd, sourceFiles, mutationConfig, threshold, maxMutants });
    } finally {
      removeTree(sandbox.dir);
      SANDBOXES.delete(sandbox.dir);
    }
  }

  async _runInSandbox(result, { projectRoot, sandbox, testCmd, sourceFiles, mutationConfig, threshold, maxMutants }) {
    const cwd = sandbox.dir;
    result.addCheck('mutation:sandbox', true, {
      severity: 'info',
      message: `Mutants are applied to a sandbox copy (${sandbox.files} files; node_modules linked), never to your working tree`,
    });

    const baselineStart = Date.now();
    const baseline = this._exec(testCmd, { cwd, timeout: 120000 });
    const baselineMs = Date.now() - baselineStart;
    if (baseline.exitCode !== 0) {
      result.addCheck('mutation:baseline', true, {
        message: 'Skipped — the suite does not pass in the sandbox copy, so mutants cannot be measured (see unitTests for the failure)',
        severity: 'info',
        suggestion: 'Fix failing tests first, then re-run mutation testing',
      });
      return;
    }

    result.addCheck('mutation:baseline', true, {
      message: `Baseline tests pass. Generating mutants from ${sourceFiles.length} source files...`,
      severity: 'info',
    });

    // A mutant gets three times what the clean suite needed, floored at the
    // old 30s and capped so one pathological run cannot eat the budget.
    const mutantTimeout = Math.min(Math.max(baselineMs * 2, 30000), 90000);

    // Wall-clock budget for the whole module. maxMutants alone bounds the
    // COUNT, not the TIME: 50 mutants against a 30s suite is 25 minutes, and
    // a full self-scan of this repo hit `timeout 1200` (exit 124) still
    // inside this module, against the 60s bar in CLAUDE.md section 9.
    // Sampling fewer mutants and saying so beats a scan that never returns.
    const timeBudgetMs = (mutationConfig && mutationConfig.timeBudgetMs) || 120000;
    const deadline = Date.now() + timeBudgetMs;

    // Generate and test mutants
    let killed = 0;
    let survived = 0;
    let inconclusive = 0;
    let budgetExhausted = false;
    let totalMutants = 0;
    const survivors = [];

    for (const file of sourceFiles) {
      if (totalMutants >= maxMutants || budgetExhausted) break;
      if (Date.now() > deadline) { budgetExhausted = true; break; }

      const relPath = repoRelative(projectRoot, file);
      const original = fs.readFileSync(file, 'utf-8');
      const lines = splitLines(original);

      for (const mutation of MUTATIONS) {
        if (totalMutants >= maxMutants || budgetExhausted) break;

        // Find lines where this mutation can apply
        for (let i = 0; i < lines.length; i++) {
          if (totalMutants >= maxMutants || budgetExhausted) break;

          const line = lines[i];
          // Skip comments, imports, requires — delegated to mutation-engine
          // helper so the rule lives in one place (tested in isolation).
          if (shouldSkipLine(line)) continue;

          mutation.pattern.lastIndex = 0;
          if (!mutation.pattern.test(line)) continue;

          // Apply mutation
          mutation.pattern.lastIndex = 0;
          const mutatedLine = line.replace(mutation.pattern, mutation.replace);
          if (mutatedLine === line) continue;

          const mutated = [...lines];
          mutated[i] = mutatedLine;
          const mutatedSource = joinLines(mutated, original);

          totalMutants++;

          // Write mutant, run tests, restore original
          // The bound has to sit where the cost is. Every other check above
          // is a convenience; this is the one that stops a single file from
          // running a full set of mutants past the deadline.
          if (Date.now() > deadline) { budgetExhausted = true; break; }

          const target = path.join(cwd, relPath);
          try {
            fs.writeFileSync(target, mutatedSource);
            const testResult = this._exec(testCmd, { cwd, timeout: mutantTimeout });

            if (testResult.timedOut) {
              // We learned nothing. The suite did not finish, so it neither
              // caught the mutant nor missed it. Counting this as a kill is
              // how a 100% score gets manufactured out of slow tests.
              inconclusive++;
            } else if (testResult.exitCode !== 0) {
              killed++;
            } else {
              survived++;
              survivors.push({
                file: relPath,
                line: i + 1,
                mutation: mutation.name,
                description: mutation.desc,
                original: line.trim(),
                mutated: mutatedLine.trim(),
              });
            }
          } finally {
            // Put the sandbox copy back so the next mutant starts clean.
            fs.writeFileSync(target, original);
          }

          // Only test first match per mutation per file to keep runtime reasonable
          break;
        }
      }
    }

    if (totalMutants === 0) {
      result.addCheck('mutation:none', true, {
        message: 'No applicable mutations found in source files',
        severity: 'info',
      });
      return;
    }

    // Score over mutants we actually learned something from. An inconclusive
    // mutant is excluded from both halves of the fraction rather than
    // silently improving it.
    const conclusive = killed + survived;

    if (conclusive === 0) {
      result.addCheck('mutation:score', true, {
        message:
          `Mutation score: not measured — all ${totalMutants} mutant run(s) exceeded ` +
          `${Math.round(mutantTimeout / 1000)}s and were inconclusive. The suite takes ` +
          `~${Math.round(baselineMs / 1000)}s clean; raise modules.mutation.timeBudgetMs ` +
          'or speed the suite up.',
        severity: 'info',
      });
      return;
    }

    const score = Math.round((killed / conclusive) * 100);
    const caveats = [];
    if (inconclusive > 0) caveats.push(`${inconclusive} inconclusive (timed out, not counted)`);
    if (budgetExhausted) caveats.push(`stopped at the ${Math.round(timeBudgetMs / 1000)}s budget`);
    const caveat = caveats.length ? ` — ${caveats.join('; ')}` : '';

    // A truncated run is a SAMPLE, not a measurement. On this repo the budget
    // stops it after 4 mutants, and failing a build on "0% of 4" is the kind
    // of unreliable verdict that teaches people to ignore the gate — the
    // number is real but it cannot carry a build decision. Blocking is
    // reserved for a run that finished; a truncated one reports the same
    // number as a warning, says it is a sample, and says why it stopped.
    const truncated = budgetExhausted || totalMutants >= maxMutants;
    const failing = score < threshold;
    const blocks = failing && !truncated;

    result.addCheck('mutation:score', !failing || truncated, {
      message:
        `Mutation score: ${score}% (${killed}/${conclusive} killed, ${survived} survived)` +
        `${caveat}${truncated ? ' — SAMPLE, not a full measurement' : ''}`,
      expected: `>= ${threshold}%`,
      actual: `${score}%`,
      severity: !failing ? 'info' : (blocks ? 'error' : 'warning'),
      suggestion: failing
        ? (truncated
          ? 'Add tests for the survivors below. This sample did not cover the whole repo — ' +
            'raise modules.mutation.timeBudgetMs / maxMutants for a verdict that can block.'
          : 'Add tests that detect the surviving mutations listed below')
        : undefined,
    });

    // Report survivors as individual warnings
    for (const s of survivors.slice(0, 20)) {
      result.addCheck(`mutation:survivor:${s.file}:${s.line}:${s.mutation}`, false, {
        file: s.file,
        line: s.line,
        severity: 'warning',
        message: `${s.description} at line ${s.line} — tests did not catch this`,
        suggestion: `Add a test that would fail when "${s.original}" becomes "${s.mutated}"`,
      });
    }

    if (survivors.length > 20) {
      result.addCheck('mutation:survivors-truncated', true, {
        severity: 'info',
        message: `${survivors.length - 20} more surviving mutants not shown. Run with --verbose for full list.`,
      });
    }

    // Write mutation report
    this._writeReport(projectRoot, { score, killed, survived, totalMutants, threshold, survivors });
  }

  _detectTestCommand(projectRoot) {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.scripts?.test && !pkg.scripts.test.includes('no test specified')) {
          return 'npm test 2>&1';
        }
      } catch { /* error-ok: unreadable or malformed package.json — fall through to the next detection strategy; the syntax module reports the file itself */ }
    }

    const testDirs = ['tests', 'test', '__tests__'];
    for (const dir of testDirs) {
      if (fs.existsSync(path.join(projectRoot, dir))) {
        return 'node --test 2>&1';
      }
    }

    return null;
  }

  _findSourceFiles(projectRoot) {
    // _collectFiles already skips every walk-exclude (src/core/walk-excludes.js);
    // only the module's own extras are named here.
    const sourceFiles = this._collectFiles(projectRoot, JS_SOURCE_EXTS_NO_JSX, [
      'website', 'test', 'tests', '__tests__', 'spec',
    ]);

    // Exclude test files and config files
    return sourceFiles.filter(f => {
      const base = path.basename(f);
      return !base.includes('.test.') && !base.includes('.spec.') &&
             !base.includes('.config.') && base !== 'jest.config.js' &&
             !base.startsWith('.');
    });
  }

  _writeReport(projectRoot, data) {
    const reportDir = path.join(projectRoot, '.gatetest', 'reports');
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }

    const report = {
      type: 'mutation-testing',
      timestamp: new Date().toISOString(),
      score: data.score,
      threshold: data.threshold,
      mutants: {
        total: data.totalMutants,
        killed: data.killed,
        survived: data.survived,
      },
      survivors: data.survivors,
    };

    fs.writeFileSync(
      path.join(reportDir, 'mutation-report.json'),
      JSON.stringify(report, null, 2)
    );
  }
}

module.exports = MutationModule;
