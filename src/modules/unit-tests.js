/**
 * Unit Tests Module - Validates that the project's test suite passes.
 * Detects test framework and runs the appropriate test command.
 */

const BaseModule = require('./base-module');
const fs = require('fs');
const path = require('path');
const { looksLikeMissingToolchain, looksLikeToolchainBuildFailure, firstToolchainErrorLine } = require('../core/toolchain-signals');
const { repoRelative } = require('../core/repo-path');
const flakyLedger = require('../core/flaky-ledger');
const { parseTestOutcomes } = require('../core/test-outcomes');

class UnitTestsModule extends BaseModule {
  constructor() {
    super('unitTests', 'Unit Test Execution');
    this._testTimeoutMs = 300000; // overridable for tests
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;

    // Detect test framework and run tests
    const testCommand = this._detectTestCommand(projectRoot);

    if (!testCommand) {
      // Not having a runner GateTest recognises is not a defect in the
      // customer's code — it is a limit of our detection. Warn, never block
      // (2026-08-18 audit: this was a blocking error on 6/6 non-Node repos).
      result.addCheck('unit-tests:detect', false, {
        severity: 'warning',
        message: 'No test framework detected',
        suggestion: 'Add a test script to package.json or install a test framework (jest, vitest, mocha, pytest, go test, cargo test, mvn/gradle, rspec)',
      });
      return;
    }

    this._runnerName = testCommand.name;
    result.addCheck('unit-tests:framework', true, { message: `Detected: ${testCommand.name}` });

    // The runner binary itself must exist before its exit code means
    // anything about the customer's tests: `python -m pytest` on a box with
    // no deps, `go`/`cargo`/`mvn` missing from PATH — every one of those is
    // "GateTest could not run your suite here", reported honestly as such.
    if (testCommand.needsBinary && !this._binaryAvailable(testCommand.needsBinary)) {
      result.addCheck('unit-tests:run', true, {
        severity: 'info',
        message: `Skipped — ${testCommand.name} runner (${testCommand.needsBinary}) is not available in this scan environment`,
        suggestion: 'Run the scan where the toolchain is installed (CI) to include test results',
      });
      this._checkCoverage(projectRoot, config, result);
      return;
    }

    // Dependencies not installed? Then a non-zero exit says nothing about the
    // customer's tests — the runner itself is missing. Reporting that as
    // "Unit tests failed" blames the customer for our scan environment.
    //
    // Why (neutral-repo audit 2026-08-12): a fresh clone of expressjs/express
    // failed here in 523ms because mocha wasn't installed, and it was one of
    // the 5 findings that BLOCKED the gate on a repo whose suite is green
    // upstream. Skip honestly instead of failing dishonestly.
    if (this._dependenciesMissing(projectRoot)) {
      result.addCheck('unit-tests:run', true, {
        severity: 'info',
        message: 'Skipped — dependencies are not installed, so the test runner cannot start',
        suggestion: 'Run "npm ci" (or your package manager\'s install) before scanning to include test results',
      });
      this._checkCoverage(projectRoot, config, result);
      return;
    }

    // Run with a SCRUBBED environment: the scanner's own GATETEST_* variables
    // must not leak into the customer's suite (measured: GATETEST_NO_TELEMETRY
    // from the scanner flipped one of this repo's own tests red). NODE_TEST_CONTEXT
    // must go too — when this module's own test runs GateTest under `node --test`
    // (tests/fix-engine-failing-tests.test.js does exactly this), a customer suite
    // that also happens to run on `node --test` inherits it and reports itself as
    // a subtest of the OUTER runner instead of a standalone process, which exits
    // 0 regardless of its own failures (same fix already applied to the fix
    // engine's own test runner in cli-fix-orchestrator.js's _runTests).
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^GATETEST_/.test(k)) delete env[k];
    delete env.NODE_TEST_CONTEXT;
    const { exitCode, stdout, stderr, timedOut } = this._exec(testCommand.command, {
      cwd: projectRoot,
      timeout: this._testTimeoutMs, // 5 minutes
      env,
    });

    const out = stdout + stderr;
    if (exitCode === 0) {
      // Green runs are recorded too: a flip is a pass next to a fail, and the
      // pass is the half only a green run can supply.
      const ledger = this._flakyLedger(projectRoot, config, out);
      result.addCheck('unit-tests:run', true, { message: 'All unit tests passed' });
      this._reportFlakyLedger(result, ledger, []);
    } else if (timedOut) {
      // Never derive a verdict from a timeout (doctrine, move 18): ktor's
      // Gradle build ran for the full five minutes on CI and was reported
      // as "Unit tests failed" — a fact about the runner's clock, not the
      // suite (2026-09-05).
      result.addCheck('unit-tests:run', true, {
        severity: 'info',
        message: `Not executed — the test command did not finish within ${Math.round(this._testTimeoutMs / 1000)}s here`,
        suggestion: 'Run the scan where the suite normally runs (CI) to include test results',
      });
    } else if (this._looksLikeMissingToolchain(out)) {
      // ModuleNotFoundError / "command not found" / "no such file" — the
      // environment, not the tests, failed.
      result.addCheck('unit-tests:run', true, {
        severity: 'info',
        message: `Skipped — the test runner could not start in this environment (${this._firstLine(out)})`,
        suggestion: 'Install the project dependencies before scanning to include test results',
      });
    } else {
      // Per-test failures (move 8, THE-FIFTY): a plain "Unit tests failed"
      // check carries no file, so extractFileFromCheck (bin/gatetest.js)
      // could never route it to the fix engine — the one thing the public
      // arena demo injects was unfixable. Parsing node:test's TAP `location:`
      // key (and, as a fallback, jest/mocha `at file:line:col` stack frames)
      // gives the check a real file/line, and details.failures[] gives the
      // fix pipeline the test name, assertion message and expected/actual.
      const failures = this._parseTestFailures(out, projectRoot);

      // GT-14b (#771): a build/transform tool (esbuild/tsc/babel/node
      // itself) that broke BEFORE any test ran is not the product's test
      // failure — three-state honesty says "not checked", not "failed".
      // A genuine parsed failure (TAP `not ok`, jest/mocha stack frame)
      // always wins: `failures.length` is checked first so a real failure
      // that happens to also print an unrelated toolchain warning stays
      // blocking exactly as today (control pair: `not ok 1 - adds` blocks;
      // `throw new Error('Transform failed with 1 error...')` does not).
      if (failures.length === 0 && looksLikeToolchainBuildFailure(out)) {
        result.addCheck('unit-tests:toolchain-not-checked', false, {
          severity: 'warning',
          message: `tests could not run: ${firstToolchainErrorLine(out)}; not checked`,
          suggestion: 'Fix the toolchain/build error (esbuild/tsc/babel/Node version mismatch) so the suite can actually execute, then re-scan.',
        });
        this._checkCoverage(projectRoot, config, result);
        return;
      }

      // Flaky-test ledger (launch move 6): record this run, then decide which
      // of its failures are measured flakes under an unexpired quarantine.
      // Everything not provably a quarantined flake stays exactly as it was.
      const ledger = this._flakyLedger(projectRoot, config, out);
      const split = this._splitQuarantined(ledger, failures, projectRoot);

      if (split.allQuarantined) {
        result.addCheck('unit-tests:run', true, {
          message: `Unit tests passed apart from ${split.quarantined.length} quarantined flaky test${split.quarantined.length === 1 ? '' : 's'} — their failures are warnings, not blocking`,
        });
      } else {
        const remaining = split.blockingFailures;
        const primary = remaining[0] || null;
        const expiredNote = primary && split.expiredNames.has(primary.name)
          ? ' (flaky, quarantine expired — fix the flake)'
          : '';
        result.addCheck('unit-tests:run', false, {
          severity: 'error',
          message: primary ? `Unit test failed: ${primary.name}${expiredNote}` : 'Unit tests failed',
          file: primary ? primary.file : null,
          line: primary ? primary.line : null,
          details: {
            message: 'Unit tests failed',
            raw: out.split(/\r?\n/).slice(-20),
            failures: remaining,
          },
          suggestion: 'Fix failing tests before committing',
        });
      }
      this._reportFlakyLedger(result, ledger, split.entries);
    }

    // Check for test coverage
    this._checkCoverage(projectRoot, config, result);
  }

  /** Wall clock, overridable so a test can prove the quarantine expires. */
  _flakyNow() { return typeof this._nowMs === 'number' ? this._nowMs : Date.now(); }

  /**
   * Record this run in the flaky-test ledger (src/core/flaky-ledger.js).
   * Never throws: a ledger fault must not change a verdict, it just leaves the
   * run unrecorded — and says so.
   *
   * @returns {{ state: 'recorded'|'off'|'unreadable'|'error', reason: string|null,
   *             cfg: object, parsed?: object, verdicts?: Map, ambiguous?: Set, flake?: object }}
   */
  _flakyLedger(projectRoot, config, out) {
    const cfg = flakyLedger.resolveFlakyConfig(config);
    try {
      const gate = flakyLedger.ledgerGate(projectRoot);
      if (!gate.enabled) return { state: 'off', reason: gate.reason, cfg };
      const parsed = parseTestOutcomes(out);
      if (!parsed.format) {
        return { state: 'unreadable', reason: `${this._runnerName || 'this runner'}'s output is not per-test readable (node:test only), so flakes are not measured`, cfg };
      }
      const rec = flakyLedger.recordRun(projectRoot, parsed, { cfg, now: this._flakyNow(), commit: this._commitOverride });
      return { state: 'recorded', reason: null, cfg, parsed, verdicts: rec.verdicts, ambiguous: rec.ambiguous, flake: rec.flake };
    } catch (err) {
      return { state: 'error', reason: `the ledger could not be updated (${String(err && err.message).slice(0, 80)})`, cfg };
    }
  }

  /**
   * Which of this run's failures are quarantined flakes, and what still blocks.
   * A failure is downgraded only when EVERY condition holds: the ledger judged
   * that test flaky, its quarantine has not expired, quarantine is on, the
   * runner's output accounted for every failure it counted, and the failure is
   * a test failing (not a hook or a crash). Anything else blocks as before.
   */
  _splitQuarantined(ledger, failures, projectRoot) {
    const none = { allQuarantined: false, quarantined: [], blockingFailures: failures, expiredNames: new Set(), entries: [] };
    if (!ledger || ledger.state !== 'recorded') return none;
    const { parsed, verdicts, ambiguous, cfg } = ledger;
    const now = this._flakyNow();
    const failingLeaves = parsed.outcomes.filter((o) => !o.ok && !o.container);
    const quarantinedKeys = new Set();
    const entries = [];
    const expiredNames = new Set();
    const byName = new Map(failures.map((f) => [f.name, f]));
    for (const o of failingLeaves) {
      const key = flakyLedger.testKey(o.path);
      const v = verdicts.get(key);
      if (!v || !v.flaky || ambiguous.has(key)) continue;
      let state;
      if (v.expired) state = 'expired';
      else if (!cfg.quarantine) state = 'off';
      else if (!parsed.complete || !o.testFailure) state = 'unaccounted';
      else state = 'quarantined';
      if (state === 'quarantined') quarantinedKeys.add(key);
      if (state === 'expired') expiredNames.add(o.name);
      const known = byName.get(o.name);
      entries.push({
        name: o.path.join(' > '),
        module: this.name,
        file: (known && known.file) || (o.file && projectRoot ? this._toRepoRelative(o.file, projectRoot) : null),
        line: (known && known.line) || o.line || null,
        state,
        flips: v.flips,
        runs: v.runs,
        sameCommit: v.sameCommit,
        since: v.since ? new Date(v.since).toISOString() : null,
        expiresAt: v.expiresAt ? new Date(v.expiresAt).toISOString() : null,
        daysLeft: v.expiresAt ? Math.max(0, Math.ceil((v.expiresAt - now) / 86400_000)) : null,
      });
    }
    const isQuarantined = (o) => quarantinedKeys.has(flakyLedger.testKey(o.path));
    const blockingLeaves = failingLeaves.filter((o) => !isQuarantined(o));
    const allQuarantined = quarantinedKeys.size > 0 && blockingLeaves.length === 0 && parsed.complete === true;

    // A failing container (a describe, a test with subtests) goes when every
    // failing test inside it is quarantined — it failed only because they did.
    const dropped = new Set(failingLeaves.filter(isQuarantined).map((o) => o.name));
    for (const c of parsed.outcomes.filter((o) => !o.ok && o.container)) {
      const inside = failingLeaves.filter((o) => o.path.length > c.path.length && c.path.every((seg, i) => o.path[i] === seg));
      if (inside.length > 0 && inside.every(isQuarantined)) dropped.add(c.name);
    }
    const quarantined = entries.filter((e) => e.state === 'quarantined');
    return {
      allQuarantined,
      quarantined,
      blockingFailures: allQuarantined ? [] : failures.filter((f) => !dropped.has(f.name)),
      expiredNames,
      entries,
    };
  }

  /**
   * One warning per quarantined test, and ONE ledger check carrying the flake
   * rate and the `flaky[]` list the reporters read. The ledger check is how
   * "not measured" gets said out loud when nothing could be recorded.
   */
  _reportFlakyLedger(result, ledger, entries) {
    for (const e of entries.filter((x) => x.state === 'quarantined')) {
      result.addCheck('unit-tests:quarantined-flaky', false, {
        severity: 'warning',
        message: `quarantined flaky test (flipped ${e.flips} of last ${e.runs} runs${e.sameCommit ? ', passed and failed on one commit' : ''}): ${e.name}`,
        file: e.file,
        line: e.line,
        quarantine: e,
        suggestion: `Fix the flake — quarantine ends ${e.expiresAt ? e.expiresAt.slice(0, 10) : 'in 14 days'} (${e.daysLeft} day${e.daysLeft === 1 ? '' : 's'} left) and the failure blocks again after that. --no-quarantine turns quarantine off.`,
      });
    }
    let flake;
    let message;
    if (ledger.state === 'recorded') {
      flake = { ...ledger.flake, state: 'recorded', reason: null };
      const f = ledger.flake;
      message = f.measured
        ? `Flake rate ${f.rate}% — ${f.flakyTests} flaky of ${f.tests} tests over ${f.runs} recorded run${f.runs === 1 ? '' : 's'}${f.quarantined ? `, ${f.quarantined} quarantined` : ''}${f.expired ? `, ${f.expired} past quarantine` : ''}`
        : 'Flake rate not measured — the run reported no tests';
    } else {
      flake = { measured: false, rate: null, flakyTests: 0, quarantined: 0, expired: 0, tests: 0, runs: 0, state: ledger.state, reason: ledger.reason };
      message = `Flake rate not measured — ${ledger.reason}`;
    }
    result.addCheck('unit-tests:flake-ledger', true, {
      severity: 'info',
      message,
      flake,
      flaky: entries,
    });
  }

  /**
   * True when the project declares dependencies but has no installed tree to
   * run them from. Only meaningful for the Node ecosystem — a Python or Go
   * project has no node_modules and must not be treated as uninstalled.
   *
   * @param {string} projectRoot
   * @returns {boolean}
   */
  _dependenciesMissing(projectRoot) {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (!fs.existsSync(pkgPath)) return false;
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    } catch {
      return false; // unparseable package.json is a different module's finding
    }
    const declares = Object.keys(pkg.dependencies || {}).length > 0
      || Object.keys(pkg.devDependencies || {}).length > 0;
    if (!declares) return false;
    return !fs.existsSync(path.join(projectRoot, 'node_modules'));
  }

  _detectTestCommand(projectRoot) {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
          return { name: 'npm test', command: 'npm test 2>&1' };
        }
      } catch { /* error-ok — unreadable package.json — the syntax module reports it; this check has nothing to read */ }
    }

    // Check for common test configs — Node first, then the other toolchains
    // (2026-08-18 audit: gin has 21 _test.go files and petclinic has JUnit,
    // both were told "No test framework detected" and blocked).
    const frameworks = [
      { files: ['jest.config.js', 'jest.config.ts', 'jest.config.cjs'], name: 'Jest', command: 'npx --no-install jest 2>&1' },
      { files: ['vitest.config.js', 'vitest.config.ts'], name: 'Vitest', command: 'npx --no-install vitest run 2>&1' },
      { files: ['.mocharc.yml', '.mocharc.json', '.mocharc.js'], name: 'Mocha', command: 'npx --no-install mocha 2>&1' },
      { files: ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini'], name: 'pytest', command: 'python -m pytest -x -q 2>&1', needsBinary: 'python' },
      { files: ['go.mod'], name: 'go test', command: 'go test ./... 2>&1', needsBinary: 'go' },
      { files: ['Cargo.toml'], name: 'cargo test', command: 'cargo test 2>&1', needsBinary: 'cargo' },
      { files: ['pom.xml'], name: 'Maven', command: 'mvn -q test 2>&1', needsBinary: 'mvn' },
      // --no-daemon: the build runs in the child process this module can
      // kill on timeout. With the daemon, Gradle spawns a detached JVM that
      // outlives the timeout, keeps writing into the checkout, and on CI
      // made the corpus script's temp-dir cleanup throw ENOTEMPTY after a
      // gate that had already PASSED (ktor, 2026-09-05).
      { files: ['build.gradle', 'build.gradle.kts'], name: 'Gradle', command: 'gradle test --no-daemon --console=plain 2>&1', needsBinary: 'gradle' },
      { files: ['Gemfile'], name: 'RSpec', command: 'bundle exec rspec 2>&1', needsBinary: 'bundle' },
      { files: ['composer.json'], name: 'PHPUnit', command: 'vendor/bin/phpunit 2>&1', needsBinary: 'php' },
    ];

    for (const fw of frameworks) {
      if (fw.files.some(f => fs.existsSync(path.join(projectRoot, f)))) {
        return { name: fw.name, command: fw.command, needsBinary: fw.needsBinary };
      }
    }

    // Check for test directories
    const testDirs = ['tests', 'test', '__tests__', 'spec'];
    for (const dir of testDirs) {
      // Only when the directory holds JavaScript node can run. Node 22
      // strips types by default, so a bare `node --test` on a repo whose
      // only `test.ts` is an Angular/Karma harness "ran" it and reported
      // "Unit tests failed" (CleanArchitecture, 2026-09-05).
      if (fs.existsSync(path.join(projectRoot, dir)) && this._hasRunnableJsTests(path.join(projectRoot, dir))) {
        // TAP output (`location:` YAML key per failing test) is what lets
        // unit-tests:run attach a per-failure file/line — the default spec
        // reporter has no machine-readable location at all.
        return { name: 'Node.js test runner', command: 'node --test --test-reporter=tap 2>&1' };
      }
    }

    return null;
  }

  _binaryAvailable(bin) {
    try {
      const { execSync } = require('child_process');
      const probe = process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`;
      execSync(probe, { stdio: 'ignore', timeout: 5000, shell: true });
      return true;
    } catch {
      return false;
    }
  }

  _looksLikeMissingToolchain(out) {
    // One definition, shared with integrationTests: src/core/toolchain-signals.js.
    return looksLikeMissingToolchain(out);
  }

  /**
   * Per-test failure details from raw runner output. Tries node:test's TAP
   * reporter first (structured `location:`/`error:` YAML), then falls back
   * to jest/mocha-style `at ... (file:line:col)` stack frames. Never throws —
   * an unparseable format just yields an empty array (three-state honesty:
   * the caller still has the raw tail, it just has no per-test location).
   *
   * @returns {Array<{name:string, file:string|null, line:number|null, message:string, expected:string|null, actual:string|null}>}
   */
  _parseTestFailures(out, projectRoot) {
    try {
      if (/^\s*not ok \d+/m.test(out) || /^TAP version/m.test(out)) {
        const tap = this._parseTapFailures(out, projectRoot);
        if (tap.length) return tap;
      }
      return this._parseStackFailures(out, projectRoot);
    } catch {
      return []; // error-ok — a parse failure is "not checked", never a crash
    }
  }

  /** node:test TAP reporter (`node --test --test-reporter=tap`). */
  _parseTapFailures(out, projectRoot) {
    const lines = out.split(/\r?\n/);
    const failures = [];
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*not ok \d+(?:\s*-\s*(.+))?\s*$/.exec(lines[i]);
      if (!m) continue;
      const name = (m[1] || `test ${failures.length + 1}`).trim();

      // The diagnostic YAML block runs until the next test marker (capped —
      // a runaway stack trace should not swallow the rest of the output).
      const block = [];
      for (let j = i + 1; j < lines.length && j < i + 60; j++) {
        if (/^\s*(not )?ok \d+\b/.test(lines[j])) break;
        block.push(lines[j]);
      }
      const blockText = block.join('\n');

      let file = null;
      let line = null;
      const locMatch = /location:\s*'([^']+)'/.exec(blockText);
      if (locMatch) {
        const parts = /^(.*):(\d+):(\d+)$/.exec(locMatch[1]);
        if (parts) { file = parts[1]; line = parseInt(parts[2], 10); }
        else file = locMatch[1];
      }

      // `error:` is either a YAML block scalar (`error: |-`, indented body)
      // or a single quoted line — TAP allows both depending on message length.
      let message = null;
      const scalarIdx = block.findIndex((l) => /^\s*error:\s*\|-?\s*$/.test(l));
      if (scalarIdx !== -1) {
        const baseIndent = (block[scalarIdx].match(/^\s*/) || [''])[0].length;
        const body = [];
        for (let k = scalarIdx + 1; k < block.length; k++) {
          const l = block[k];
          if (l.trim() === '') { body.push(''); continue; }
          const indent = (l.match(/^\s*/) || [''])[0].length;
          if (indent <= baseIndent) break;
          body.push(l.trim());
        }
        message = body.join('\n').trim();
      } else {
        const single = /error:\s*'([^']*)'/.exec(blockText) || /error:\s*"([^"]*)"/.exec(blockText);
        if (single) message = single[1];
      }

      // Best-effort expected/actual out of node:assert's "actual !== expected"
      // style comparison line — not present for every assertion shape.
      let expected = null;
      let actual = null;
      if (message) {
        const cmpLine = message.split(/\r?\n/).find((l) => /\s(?:!==|===|!=|==)\s/.test(l));
        const cmp = cmpLine ? /^(.*?)\s(?:!==|===|!=|==)\s(.*)$/.exec(cmpLine) : null;
        if (cmp) { actual = cmp[1].trim(); expected = cmp[2].trim(); }
      }

      if (file) file = this._toRepoRelative(file, projectRoot);
      failures.push({ name, file, line, message: message || 'assertion failed', expected, actual });
    }
    return failures;
  }

  /** jest/mocha fallback — no structured output, only printed stack frames. */
  _parseStackFailures(out, projectRoot) {
    const failures = [];
    const nameRe = /^\s*(?:✕|✗|×|\d+\))\s*(.+)$/;
    const stackRe = /at\s+(?:[\w.$<>]+\s+)?\(?([^\s()]+\.(?:m?[jt]sx?)):(\d+):(\d+)\)?/;
    let currentName = null;
    for (const raw of out.split(/\r?\n/)) {
      const nameMatch = nameRe.exec(raw);
      if (nameMatch) { currentName = nameMatch[1].trim(); continue; }
      const m = stackRe.exec(raw);
      if (m && currentName) {
        failures.push({
          name: currentName,
          file: this._toRepoRelative(m[1], projectRoot),
          line: parseInt(m[2], 10),
          message: currentName,
          expected: null,
          actual: null,
        });
        currentName = null; // one location per failure name — the first frame
      }
    }
    return failures;
  }

  /** One definition of repo-relative paths (doctrine §4): src/core/repo-path.js. */
  _toRepoRelative(rawPath, projectRoot) {
    const abs = path.isAbsolute(rawPath) ? rawPath : path.join(projectRoot, rawPath);
    return repoRelative(projectRoot, abs);
  }

  /** Does a test directory contain anything `node --test` can actually run? */
  _hasRunnableJsTests(dir, depth = 0) {
    if (depth > 3) return false;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; } // error-ok — unreadable dir has no runnable tests
    for (const e of entries) {
      if (e.isFile() && /\.(?:js|mjs|cjs)$/.test(e.name)) return true;
      if (e.isDirectory() && e.name !== 'node_modules' && this._hasRunnableJsTests(path.join(dir, e.name), depth + 1)) return true;
    }
    return false;
  }

  _firstLine(out) {
    const line = (out || '').split(/\r?\n/).map((l) => l.trim()).find((l) => /ModuleNotFoundError|No module named|command not found|not recognized|ENOENT|Cannot find module|not found/i.test(l));
    return (line || 'runner unavailable').slice(0, 160);
  }

  _checkCoverage(projectRoot, config, result) {
    const coveragePaths = ['coverage/coverage-summary.json', 'coverage/lcov.info'];
    let coveragePath = null;

    for (const cp of coveragePaths) {
      const full = path.join(projectRoot, cp);
      if (fs.existsSync(full)) {
        coveragePath = full;
        break;
      }
    }

    if (!coveragePath) {
      result.addCheck('unit-tests:coverage', true, {
        message: 'No coverage report found — run tests with --coverage for coverage checks',
      });
      return;
    }

    if (coveragePath.endsWith('.json')) {
      try {
        const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf-8'));
        const total = coverage.total;
        const threshold = config.getThreshold('unitTestCoverage');

        if (total?.lines?.pct < threshold) {
          result.addCheck('unit-tests:coverage', false, {
            expected: `>= ${threshold}%`,
            actual: `${total.lines.pct}%`,
            message: `Line coverage ${total.lines.pct}% is below threshold ${threshold}%`,
            suggestion: 'Add tests to improve coverage',
          });
        } else {
          result.addCheck('unit-tests:coverage', true, {
            message: `Line coverage: ${total?.lines?.pct || 'N/A'}%`,
          });
        }
      } catch {
        result.addCheck('unit-tests:coverage', true, { message: 'Could not parse coverage report' });
      }
    }
  }
}

module.exports = UnitTestsModule;
