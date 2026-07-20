'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Test Runner — auto-detects and executes the project's test suite,
// returns structured pass/fail per test with file:line.
// No new npm dependencies — uses only child_process.
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024; // 4 MB

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function readJsonFile(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

function fileExists(filePath) {
  try { return fs.statSync(filePath).isFile(); } catch { return false; }
}

function detectRunner(projectRoot) {
  const pkg = readJsonFile(path.join(projectRoot, 'package.json'));
  if (pkg) {
    const testScript = (pkg.scripts && pkg.scripts.test) || '';
    if (/\bvitest\b/.test(testScript)) return 'vitest';
    if (/\bjest\b/.test(testScript)) return 'jest';
    if (/\bmocha\b/.test(testScript)) return 'mocha';
    if (/\btap\b/.test(testScript)) return 'tap';
    if (/\bjasmine\b/.test(testScript)) return 'jasmine';
    // Has a test script but unknown runner
    if (testScript && testScript !== 'echo "Error: no test specified"') return 'npm';

    // Check devDependencies for clues
    const devDeps = Object.keys(pkg.devDependencies || {});
    const deps = Object.keys(pkg.dependencies || {});
    const all = [...devDeps, ...deps];
    if (all.includes('vitest')) return 'vitest';
    if (all.includes('jest') || all.includes('@jest/core')) return 'jest';
    if (all.includes('mocha')) return 'mocha';
  }

  if (fileExists(path.join(projectRoot, 'Cargo.toml'))) return 'cargo';
  if (fileExists(path.join(projectRoot, 'go.mod'))) return 'go';
  if (
    fileExists(path.join(projectRoot, 'pytest.ini')) ||
    fileExists(path.join(projectRoot, 'setup.cfg')) ||
    fileExists(path.join(projectRoot, 'pyproject.toml'))
  ) return 'pytest';
  if (fileExists(path.join(projectRoot, 'Gemfile'))) return 'rspec';

  // Last resort — if there's a package.json at all, try npm test
  if (pkg) return 'npm';

  return 'unknown';
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

// Splits a shell-like command string into argv, respecting single/double
// quotes (e.g. `node -e "console.log('hi')"` stays 3 args, not 6). A plain
// `.split(/\s+/)` shatters quoted args with spaces — harmless on Windows
// (spawnCapture always shells out there) but wrong on Linux/Mac, where
// spawn() with shell:false passes tokens through literally.
function splitCommand(command) {
  const parts = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) { parts.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function spawnCapture(cmd, args, options, timeoutMs) {
  return new Promise((resolve) => {
    const chunks = { stdout: [], stderr: [] };
    let totalBytes = 0;
    let truncated = false;

    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      // Windows can't exec .cmd/.bat (npm.cmd) without a shell — but Node
      // deprecated args+shell:true in general (DEP0190): with a shell, args
      // are concatenated but NOT re-escaped, so any quoted argument
      // containing spaces (e.g. a custom `-e "console.log('a b')"` command)
      // silently breaks apart. The built-in npm.cmd branch's args never
      // contain spaces, so scoping shell to just the .cmd/.bat case keeps
      // that working while leaving `node`/`cargo`/custom commands unshelled.
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd),
    });

    const absorb = (stream, buf) => {
      if (truncated) return;
      totalBytes += buf.length;
      if (totalBytes > MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      chunks[stream].push(buf);
    };

    child.stdout.on('data', (b) => absorb('stdout', b));
    child.stderr.on('data', (b) => absorb('stderr', b));

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000); // error-ok: best-effort output parse; falls through to the next detection strategy
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(chunks.stdout).toString('utf8'),
        stderr: Buffer.concat(chunks.stderr).toString('utf8'),
        exitCode: code,
        truncated,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout: '', stderr: err.message, exitCode: -1, truncated: false });
    });
  });
}

// ---------------------------------------------------------------------------
// Parsers — one per runner
// ---------------------------------------------------------------------------

function parseJestJson(raw) {
  try {
    const data = JSON.parse(raw);
    const tests = [];
    for (const suite of data.testResults || []) {
      const relFile = suite.testFilePath || '';
      for (const t of suite.testResults || []) {
        const locations = (t.ancestorTitles || []);
        const name = [...locations, t.title].join(' > ');
        const status =
          t.status === 'passed' ? 'passed' :
          t.status === 'pending' || t.status === 'todo' ? 'skipped' : 'failed';
        const error = (t.failureMessages || []).join('\n').slice(0, 2000) || undefined;
        // Jest doesn't always give line numbers in the JSON result — extract from error if present
        let line;
        if (error) {
          const m = error.match(/:(\d+):\d+\)/);
          if (m) line = parseInt(m[1], 10);
        }
        tests.push({ name, status, file: relFile, line, duration: t.duration, error });
      }
    }
    const passed = tests.filter(t => t.status === 'passed').length;
    const failed = tests.filter(t => t.status === 'failed').length;
    const skipped = tests.filter(t => t.status === 'skipped').length;
    return { ok: true, total: tests.length, passed, failed, skipped, tests };
  } catch { return null; }
}

function parseVitestJson(raw) {
  // Vitest --reporter=json emits a similar shape to Jest
  try {
    const data = JSON.parse(raw);
    const tests = [];
    const walk = (suite, file) => {
      for (const t of suite.tests || []) {
        const status = t.result?.state === 'pass' ? 'passed' : t.result?.state === 'skip' ? 'skipped' : 'failed';
        const error = t.result?.errors?.map(e => e.message).join('\n').slice(0, 2000) || undefined;
        tests.push({ name: t.name, status, file: file || t.file, line: undefined, duration: t.result?.duration, error });
      }
      for (const child of suite.suites || []) walk(child, file || suite.file);
    };
    for (const suite of data.testResults || data.suites || []) walk(suite, suite.file);
    const passed = tests.filter(t => t.status === 'passed').length;
    const failed = tests.filter(t => t.status === 'failed').length;
    const skipped = tests.filter(t => t.status === 'skipped').length;
    return { ok: true, total: tests.length, passed, failed, skipped, tests };
  } catch { return null; }
}

function parsePytestStdout(stdout) {
  // Pattern: "FAILED tests/foo.py::test_bar - AssertionError"
  // Pattern: "PASSED tests/foo.py::test_bar"
  // Pattern: "tests/foo.py::test_bar PASSED"
  const tests = [];
  const lines = stdout.split('\n');
  for (const line of lines) {
    // Short test result lines
    let m = line.match(/^(PASSED|FAILED|ERROR|SKIPPED)\s+(.+?)(?:\s+-\s+(.*))?$/);
    if (!m) m = line.match(/^(.+?)\s+(PASSED|FAILED|ERROR|SKIPPED)(?:\s+-\s+(.*))?$/);
    if (!m) continue;

    let status, testId, errorMsg;
    if (['PASSED','FAILED','ERROR','SKIPPED'].includes(m[1])) {
      status = m[1].toLowerCase() === 'passed' ? 'passed' : m[1].toLowerCase() === 'skipped' ? 'skipped' : 'failed';
      testId = m[2];
      errorMsg = m[3];
    } else {
      testId = m[1];
      status = m[2].toLowerCase() === 'passed' ? 'passed' : m[2].toLowerCase() === 'skipped' ? 'skipped' : 'failed';
      errorMsg = m[3];
    }

    // testId = "path/to/test.py::TestClass::test_method"
    const parts = testId.split('::');
    const file = parts[0];
    const name = parts.slice(1).join('::') || testId;
    tests.push({ name, status, file, line: undefined, error: errorMsg || undefined });
  }

  // Also pick up summary line: "5 failed, 3 passed, 1 warning in 0.43s"
  const passed = tests.filter(t => t.status === 'passed').length;
  const failed = tests.filter(t => t.status === 'failed').length;
  const skipped = tests.filter(t => t.status === 'skipped').length;
  return { ok: true, total: tests.length, passed, failed, skipped, tests };
}

function parseCargoStdout(stdout) {
  // cargo test output: "test tests::my_test ... ok" or "test tests::my_test ... FAILED"
  const tests = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^test (.+?) \.\.\. (ok|FAILED|ignored|BENCH)/);
    if (!m) continue;
    const name = m[1];
    const status = m[2] === 'ok' ? 'passed' : m[2] === 'ignored' ? 'skipped' : 'failed';
    tests.push({ name, status, file: undefined, line: undefined });
  }
  const passed = tests.filter(t => t.status === 'passed').length;
  const failed = tests.filter(t => t.status === 'failed').length;
  const skipped = tests.filter(t => t.status === 'skipped').length;
  return { ok: true, total: tests.length, passed, failed, skipped, tests };
}

function parseGoJsonLines(stdout) {
  // go test -json emits NDJSON: {"Action":"pass","Test":"TestFoo","Package":"...","Elapsed":0.01}
  const tests = [];
  const seen = new Set();
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (!ev.Test) continue;
      if (ev.Action === 'pass' || ev.Action === 'fail' || ev.Action === 'skip') {
        const key = `${ev.Package}/${ev.Test}`;
        if (seen.has(key)) continue;
        seen.add(key);
        tests.push({
          name: ev.Test,
          status: ev.Action === 'pass' ? 'passed' : ev.Action === 'skip' ? 'skipped' : 'failed',
          file: ev.Package || undefined,
          line: undefined,
          duration: ev.Elapsed ? Math.round(ev.Elapsed * 1000) : undefined,
        });
      }
    } catch {} // error-ok: best-effort output parse; falls through to the next detection strategy
  }
  const passed = tests.filter(t => t.status === 'passed').length;
  const failed = tests.filter(t => t.status === 'failed').length;
  const skipped = tests.filter(t => t.status === 'skipped').length;
  return { ok: true, total: tests.length, passed, failed, skipped, tests };
}

function parseMochaJson(raw) {
  try {
    const data = JSON.parse(raw);
    const tests = [];
    for (const t of data.passes || []) {
      tests.push({ name: t.fullTitle || t.title, status: 'passed', file: t.file, line: undefined, duration: t.duration });
    }
    for (const t of data.failures || []) {
      const error = t.err ? (t.err.message || String(t.err)).slice(0, 2000) : undefined;
      tests.push({ name: t.fullTitle || t.title, status: 'failed', file: t.file, line: undefined, error });
    }
    for (const t of data.pending || []) {
      tests.push({ name: t.fullTitle || t.title, status: 'skipped', file: t.file, line: undefined });
    }
    return { ok: true, total: tests.length, passed: (data.stats || {}).passes || 0, failed: (data.stats || {}).failures || 0, skipped: (data.stats || {}).pending || 0, tests };
  } catch { return null; }
}

function parseNodeTestStdout(stdout) {
  // Node.js built-in test runner — supports two output formats:
  // 1. TAP (older or --test-reporter=tap): "ok 1 - test name" / "not ok 1 - test name"
  // 2. Spec reporter (default in Node 20+): "✔ test name (duration)" / "✖ test name (duration)"
  //    with summary lines like "ℹ pass 3" / "ℹ fail 1"
  const tests = [];

  for (const line of stdout.split('\n')) {
    // TAP format
    const pass = line.match(/^ok \d+ - (.+?)(?:\s+#.*)?$/);
    if (pass) { tests.push({ name: pass[1].trim(), status: 'passed' }); continue; }
    const fail = line.match(/^not ok \d+ - (.+?)(?:\s+#.*)?$/);
    if (fail) { tests.push({ name: fail[1].trim(), status: 'failed' }); continue; }
    const skip = line.match(/^ok \d+ - (.+?)\s+# SKIP/i);
    if (skip) { if (tests.length) tests[tests.length - 1].status = 'skipped'; continue; }

    // Spec reporter format (✔/✖ with optional ANSI escape codes stripped)
    const cleanLine = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
    const specPass = cleanLine.match(/^[✔✓]\s+(.+?)(?:\s+\([^)]+\))?$/u);
    if (specPass) { tests.push({ name: specPass[1].trim(), status: 'passed' }); continue; }
    const specFail = cleanLine.match(/^[✖✗×]\s+(.+?)(?:\s+\([^)]+\))?$/u);
    if (specFail) { tests.push({ name: specFail[1].trim(), status: 'failed' }); }
  }

  // If spec reporter but no individual test lines captured, fall back to summary
  // "ℹ pass 3" / "ℹ fail 1" / "ℹ skipped 2"
  let passed = tests.filter(t => t.status === 'passed').length;
  let failed = tests.filter(t => t.status === 'failed').length;
  let skipped = tests.filter(t => t.status === 'skipped').length;

  if (tests.length === 0) {
    const passM = stdout.match(/[ℹi]\s+pass\s+(\d+)/u);
    const failM = stdout.match(/[ℹi]\s+fail\s+(\d+)/u);
    const skipM = stdout.match(/[ℹi]\s+(?:skipped|cancelled)\s+(\d+)/u);
    if (passM || failM) {
      passed = passM ? parseInt(passM[1], 10) : 0;
      failed = failM ? parseInt(failM[1], 10) : 0;
      skipped = skipM ? parseInt(skipM[1], 10) : 0;
      return { ok: true, total: passed + failed + skipped, passed, failed, skipped, tests };
    }
    return null; // Not node:test output at all
  }

  return { ok: true, total: tests.length, passed, failed, skipped, tests };
}

function parseGenericStdout(stdout, stderr) {
  // Heuristic fallback — look for common pass/fail signals
  const combined = stdout + '\n' + stderr;
  const tests = [];

  // Broad patterns
  const passMatch = combined.match(/(\d+)\s+(?:test(?:s)?\s+)?(?:passed|passing)/i);
  const failMatch = combined.match(/(\d+)\s+(?:test(?:s)?\s+)?(?:failed|failing)/i);
  const skipMatch = combined.match(/(\d+)\s+(?:test(?:s)?\s+)?(?:skipped|pending)/i);

  const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
  const failed = failMatch ? parseInt(failMatch[1], 10) : 0;
  const skipped = skipMatch ? parseInt(skipMatch[1], 10) : 0;
  const total = passed + failed + skipped;

  return { ok: true, total, passed, failed, skipped, tests };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * runTests(projectRoot, opts) → Promise<RunResult>
 *
 * RunResult: { runner, total, passed, failed, skipped, duration, tests, stdout, stderr, exitCode }
 */
async function runTests(projectRoot, opts = {}) {
  const start = Date.now();
  // Accept timeoutMs (ms) or timeout (seconds); timeoutMs takes precedence
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : (opts.timeout || DEFAULT_TIMEOUT_MS / 1000) * 1000;
  const runner = opts.runner || detectRunner(projectRoot);

  // Build command + args based on runner
  let cmd, args, env = {};

  switch (runner) {
    case 'jest':
      cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
      args = ['jest', '--json', '--passWithNoTests', '--forceExit'];
      if (opts.testPattern) args.push('--testPathPattern', opts.testPattern);
      env.CI = '1'; // Suppress watch mode
      break;

    case 'vitest':
      cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
      args = ['vitest', 'run', '--reporter=json'];
      if (opts.testPattern) args.push(opts.testPattern);
      break;

    case 'mocha':
      cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
      args = ['mocha', '--reporter', 'json'];
      if (opts.testPattern) args.push('--grep', opts.testPattern);
      break;

    case 'pytest':
      cmd = 'python';
      args = ['-m', 'pytest', '-v', '--tb=short', '-q'];
      if (opts.testPattern) args.push('-k', opts.testPattern);
      break;

    case 'cargo':
      cmd = 'cargo';
      args = ['test'];
      if (opts.testPattern) args.push(opts.testPattern);
      break;

    case 'go':
      cmd = 'go';
      args = ['test', './...', '-json', '-v'];
      if (opts.testPattern) args.push('-run', opts.testPattern);
      break;

    case 'rspec':
      cmd = 'bundle';
      args = ['exec', 'rspec', '--format', 'json'];
      break;

    case 'npm':
    default:
      cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      args = ['test', '--', '--passWithNoTests'];
      env.CI = '1';
      break;
  }

  // Override with explicit command if provided
  if (opts.command) {
    const parts = splitCommand(opts.command);
    cmd = parts[0];
    args = parts.slice(1);
  }

  const result = await spawnCapture(cmd, args, { cwd: projectRoot, env }, timeoutMs);
  const duration = Date.now() - start;

  // Parse structured output
  let parsed = null;
  const effectiveRunner = opts.runner || runner;

  if (!opts.command) {
    switch (effectiveRunner) {
      case 'jest':      parsed = parseJestJson(result.stdout) || parseNodeTestStdout(result.stdout); break;
      case 'vitest':    parsed = parseVitestJson(result.stdout); break;
      case 'mocha':     parsed = parseMochaJson(result.stdout); break;
      case 'pytest':    parsed = parsePytestStdout(result.stdout + result.stderr); break;
      case 'cargo':     parsed = parseCargoStdout(result.stdout + result.stderr); break;
      case 'go':        parsed = parseGoJsonLines(result.stdout); break;
      default:          parsed = parseNodeTestStdout(result.stdout) || parseGenericStdout(result.stdout, result.stderr); break;
    }
  } else {
    // Explicit command — try parsers in order: TAP (node:test), Jest JSON, generic
    parsed =
      parseNodeTestStdout(result.stdout) ||
      parseJestJson(result.stdout) ||
      parseVitestJson(result.stdout) ||
      parsePytestStdout(result.stdout + result.stderr) ||
      parseCargoStdout(result.stdout + result.stderr) ||
      parseGoJsonLines(result.stdout) ||
      parseMochaJson(result.stdout) ||
      parseGenericStdout(result.stdout, result.stderr);
  }

  if (!parsed) {
    parsed = parseGenericStdout(result.stdout, result.stderr);
  }

  // Apply testPattern filter to tests list if needed (post-filter for runners that don't support it natively)
  let tests = parsed.tests || [];
  if (opts.testPattern && tests.length > 0) {
    try {
      const re = new RegExp(opts.testPattern, 'i');
      tests = tests.filter(t => re.test(t.name));
    } catch {} // error-ok: best-effort output parse; falls through to the next detection strategy
  }

  return {
    runner: effectiveRunner,
    total: tests.length || parsed.total,
    passed: tests.filter(t => t.status === 'passed').length || parsed.passed,
    failed: tests.filter(t => t.status === 'failed').length || parsed.failed,
    skipped: tests.filter(t => t.status === 'skipped').length || parsed.skipped,
    duration,
    tests,
    exitCode: result.exitCode,
    truncated: result.truncated,
    stdout: result.stdout.slice(0, 10_000),
    stderr: result.stderr.slice(0, 5_000),
  };
}

module.exports = { runTests, detectRunner };
