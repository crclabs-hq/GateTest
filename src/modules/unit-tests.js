/**
 * Unit Tests Module - Validates that the project's test suite passes.
 * Detects test framework and runs the appropriate test command.
 */

const BaseModule = require('./base-module');
const fs = require('fs');
const path = require('path');
const { looksLikeMissingToolchain } = require('../core/toolchain-signals');

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
    // from the scanner flipped one of this repo's own tests red).
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^GATETEST_/.test(k)) delete env[k];
    const { exitCode, stdout, stderr, timedOut } = this._exec(testCommand.command, {
      cwd: projectRoot,
      timeout: this._testTimeoutMs, // 5 minutes
      env,
    });

    const out = stdout + stderr;
    if (exitCode === 0) {
      result.addCheck('unit-tests:run', true, { message: 'All unit tests passed' });
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
      result.addCheck('unit-tests:run', false, {
        message: 'Unit tests failed',
        details: out.split(/\r?\n/).slice(-20),
        suggestion: 'Fix failing tests before committing',
      });
    }

    // Check for test coverage
    this._checkCoverage(projectRoot, config, result);
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
        return { name: 'Node.js test runner', command: 'node --test 2>&1' };
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
