'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../../bin/gatetest-sweep');
const steps = require('../../lib/sweep-steps');

const BIN = path.join(__dirname, '../..', 'bin', 'gatetest-sweep.js');
const GATETEST_BIN = path.join(__dirname, '../..', 'bin', 'gatetest.js');

/**
 * Collect every step the CLI tries to run, by handing it a runner that
 * never actually shells out — it records the (cmd, args) pair and returns
 * a canned ok result.
 *
 * Each step also writes a marker file so the orchestrator's filesystem
 * pre-conditions (e.g. step 2 skipping when website/ is absent) are
 * exercised directly.
 */
function makeStubRunner(behaviour = {}) {
  const seen = [];
  const runner = (cmd, args /*, opts */) => {
    seen.push(`${cmd} ${(args || []).join(' ')}`);
    const key = (cmd + ' ' + (args || []).join(' ')).trim();
    if (behaviour[key]) return behaviour[key];
    // Sensible default: success.
    return { durationMs: 5, stdout: '', stderr: '', exitCode: 0, spawnError: null };
  };
  return { runner, seen };
}

function captureStdout() {
  const chunks = [];
  return {
    write(chunk) { chunks.push(String(chunk)); return true; },
    text() { return chunks.join(''); },
  };
}

// ============================================================
// Help / flag parsing
// ============================================================

test('gatetest-sweep --help exits 0 and prints usage', () => {
  const out = execFileSync('node', [BIN, '--help'], { encoding: 'utf8' });
  assert.match(out, /GateTest Sweep/);
  assert.match(out, /USAGE/);
  assert.match(out, /WHAT IT RUNS/);
  assert.match(out, /1\. Tests/);
  assert.match(out, /4\. Gate \(quick suite\)/);
  assert.match(out, /EXIT CODE/i);
});

test('parseArgs handles every documented flag', () => {
  const args = cli.parseArgs(['--fast', '--no-build', '--no-tests', '--only', 'gate', '--json', '--quiet', '--verbose', '--working-dir', '/tmp', '--min-modules', '50', '--suite', 'full']);
  assert.equal(args.fast, true);
  assert.equal(args.noBuild, true);
  assert.equal(args.noTests, true);
  assert.equal(args.only, 'gate');
  assert.equal(args.json, true);
  assert.equal(args.quiet, true);
  assert.equal(args.verbose, true);
  assert.equal(args.workingDir, '/tmp');
  assert.equal(args.minModules, 50);
  assert.equal(args.suite, 'full');
});

test('parseArgs records unknown flags so the CLI can complain', () => {
  const args = cli.parseArgs(['--made-up']);
  assert.deepEqual(args._unknown, ['--made-up']);
});

// ============================================================
// selectSteps
// ============================================================

test('selectSteps default returns all 7 steps in order', () => {
  const sel = cli.selectSteps(cli.parseArgs([]));
  assert.equal(sel.steps.length, 7);
  assert.deepEqual(sel.steps.map((s) => s.key), ['tests', 'build', 'modules', 'gate', 'secrets', 'todos', 'selfscan']);
});

test('--fast skips tests AND build (steps 1 + 2)', () => {
  const sel = cli.selectSteps(cli.parseArgs(['--fast']));
  const keys = sel.steps.map((s) => s.key);
  assert.equal(keys.includes('tests'), false);
  assert.equal(keys.includes('build'), false);
  assert.equal(keys.includes('gate'), true);
  assert.equal(keys.includes('selfscan'), true);
});

test('--no-build skips only step 2', () => {
  const sel = cli.selectSteps(cli.parseArgs(['--no-build']));
  const keys = sel.steps.map((s) => s.key);
  assert.equal(keys.includes('tests'), true);
  assert.equal(keys.includes('build'), false);
  assert.equal(sel.steps.length, 6);
});

test('--no-tests skips only step 1', () => {
  const sel = cli.selectSteps(cli.parseArgs(['--no-tests']));
  const keys = sel.steps.map((s) => s.key);
  assert.equal(keys.includes('tests'), false);
  assert.equal(keys.includes('build'), true);
});

test('--only gate runs only step 4', () => {
  const sel = cli.selectSteps(cli.parseArgs(['--only', 'gate']));
  assert.equal(sel.steps.length, 1);
  assert.equal(sel.steps[0].key, 'gate');
});

test('--only 4 (numeric) also resolves to the gate step', () => {
  const sel = cli.selectSteps(cli.parseArgs(['--only', '4']));
  assert.equal(sel.steps.length, 1);
  assert.equal(sel.steps[0].number, 4);
});

test('--only with an unknown selector surfaces an error', () => {
  const sel = cli.selectSteps(cli.parseArgs(['--only', 'banana']));
  assert.match(sel.error || '', /banana/);
});

// ============================================================
// runSweep — orchestration
// ============================================================

test('runSweep returns exit 0 when every blocking step is green', async () => {
  // Drive against a tmpdir without website/ so build skips cleanly.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-cli-'));
  try {
    fs.writeFileSync(path.join(tmp, 'README.md'), '# hi\n');
    const stub = makeStubRunner({
      'sh -c node --test tests/*.test.js': { durationMs: 10, stdout: '# tests 5\n# pass 5\n# fail 0\n', stderr: '', exitCode: 0 },
      'node bin/gatetest.js --list': { durationMs: 5, stdout: Array.from({ length: 92 }, (_, i) => `  module${i}        d`).join('\n'), stderr: '', exitCode: 0 },
      'node bin/gatetest.js --suite quick': { durationMs: 8, stdout: 'Errors: 0\nWarnings: 0\n', stderr: '', exitCode: 0 },
      'git ls-files': { durationMs: 1, stdout: 'README.md\n', stderr: '', exitCode: 0 },
      'git grep -EnI TODO|FIXME -- src/**/*.js src/**/*.ts website/app/**/*.ts website/app/**/*.tsx website/app/**/*.js': { durationMs: 1, stdout: '', stderr: '', exitCode: 1 },
    });
    const stdout = captureStdout();
    const code = await cli.runSweep(['--working-dir', tmp, '--quiet'], { stdout, runner: stub.runner });
    assert.equal(code, 0, stdout.text());
    assert.match(stdout.text(), /SWEEP: PASSED/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runSweep returns exit 1 when any blocking step is red', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-cli-'));
  try {
    fs.writeFileSync(path.join(tmp, 'README.md'), '# hi\n');
    const stub = makeStubRunner({
      'sh -c node --test tests/*.test.js': { durationMs: 10, stdout: '# tests 5\n# pass 4\n# fail 1\n', stderr: '', exitCode: 1 },
      'node bin/gatetest.js --list': { durationMs: 5, stdout: Array.from({ length: 92 }, (_, i) => `  module${i}        d`).join('\n'), stderr: '', exitCode: 0 },
      'node bin/gatetest.js --suite quick': { durationMs: 8, stdout: 'Errors: 0\nWarnings: 0\n', stderr: '', exitCode: 0 },
      'git ls-files': { durationMs: 1, stdout: 'README.md\n', stderr: '', exitCode: 0 },
    });
    const stdout = captureStdout();
    const code = await cli.runSweep(['--working-dir', tmp, '--quiet'], { stdout, runner: stub.runner });
    assert.equal(code, 1);
    assert.match(stdout.text(), /SWEEP: BLOCKED/);
    assert.match(stdout.text(), /Step 1 — Tests/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('--json emits a parseable JSON envelope', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-cli-'));
  try {
    fs.writeFileSync(path.join(tmp, 'README.md'), '# hi\n');
    const stub = makeStubRunner({
      'node bin/gatetest.js --suite quick': { durationMs: 5, stdout: 'Errors: 0\nWarnings: 3\n', stderr: '', exitCode: 0 },
    });
    const stdout = captureStdout();
    const code = await cli.runSweep(['--working-dir', tmp, '--only', 'gate', '--json'], { stdout, runner: stub.runner });
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout.text());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.verdict, 'PASSED');
    assert.equal(Array.isArray(parsed.steps), true);
    assert.equal(parsed.steps.length, 1);
    assert.equal(parsed.steps[0].key, 'gate');
    assert.equal(parsed.steps[0].errorCount, 0);
    assert.equal(parsed.steps[0].warningCount, 3);
    assert.equal(parsed.summary.firstFailingStep, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('--quiet suppresses per-step progress lines', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-cli-'));
  try {
    fs.writeFileSync(path.join(tmp, 'README.md'), '# hi\n');
    const stub = makeStubRunner({
      'node bin/gatetest.js --suite quick': { durationMs: 5, stdout: 'Errors: 0\nWarnings: 0\n', stderr: '', exitCode: 0 },
    });
    const stdout = captureStdout();
    await cli.runSweep(['--working-dir', tmp, '--only', 'gate', '--quiet'], { stdout, runner: stub.runner });
    const text = stdout.text();
    // No "[1/1] Gate ..." line; just the summary block.
    assert.equal(/\[1\/1\]/.test(text), false);
    assert.match(text, /SWEEP: PASSED/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('--working-dir switches the working directory', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-cli-'));
  try {
    fs.writeFileSync(path.join(tmp, 'README.md'), '# hi\n');
    let observedCwd = null;
    const runner = (cmd, args, opts) => {
      observedCwd = opts && opts.cwd;
      if (cmd === 'git' && args[0] === 'ls-files') return { durationMs: 1, stdout: 'README.md\n', stderr: '', exitCode: 0 };
      return { durationMs: 1, stdout: '', stderr: '', exitCode: 0 };
    };
    const stdout = captureStdout();
    await cli.runSweep(['--working-dir', tmp, '--only', 'secrets', '--json'], { stdout, runner });
    assert.equal(observedCwd, tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('selfscan reuses the gate result when both run', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-cli-'));
  try {
    fs.writeFileSync(path.join(tmp, 'README.md'), '# hi\n');
    let gateInvokes = 0;
    const runner = (cmd, args) => {
      const key = (cmd + ' ' + (args || []).join(' ')).trim();
      if (key === 'node bin/gatetest.js --suite quick') {
        gateInvokes += 1;
        return { durationMs: 5, stdout: 'Errors: 0\nWarnings: 0\n', stderr: '', exitCode: 0 };
      }
      if (key === 'node bin/gatetest.js --list') {
        const lines = Array.from({ length: 92 }, (_, i) => `  m${i}        d`).join('\n');
        return { durationMs: 1, stdout: lines, stderr: '', exitCode: 0 };
      }
      if (key.startsWith('git')) return { durationMs: 1, stdout: 'README.md\n', stderr: '', exitCode: 0 };
      if (key.startsWith('sh -c node --test')) return { durationMs: 5, stdout: '# pass 1\n# tests 1\n', stderr: '', exitCode: 0 };
      return { durationMs: 1, stdout: '', stderr: '', exitCode: 0 };
    };
    const stdout = captureStdout();
    await cli.runSweep(['--working-dir', tmp, '--json'], { stdout, runner });
    // Step 4 runs the gate exactly once; step 7 reuses that cached result.
    assert.equal(gateInvokes, 1);
    const parsed = JSON.parse(stdout.text());
    const selfscan = parsed.steps.find((s) => s.key === 'selfscan');
    assert.ok(selfscan, 'selfscan step present');
    assert.equal(selfscan.ok, true);
    assert.match(selfscan.summary, /same as step 4/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('unknown flag triggers exit code 2', async () => {
  const stdout = captureStdout();
  const code = await cli.runSweep(['--banana'], { stdout, runner: () => ({ durationMs: 0, stdout: '', stderr: '', exitCode: 0 }) });
  assert.equal(code, 2);
  assert.match(stdout.text(), /unknown flag/);
});

test('--only with bad selector triggers exit code 2', async () => {
  const stdout = captureStdout();
  const code = await cli.runSweep(['--only', 'doesnotexist'], { stdout, runner: () => ({ durationMs: 0, stdout: '', stderr: '', exitCode: 0 }) });
  assert.equal(code, 2);
  assert.match(stdout.text(), /doesnotexist/);
});

// ============================================================
// Integration with bin/gatetest.js subcommand routing
// ============================================================

test('gatetest sweep --help is reachable via the gatetest entry point', () => {
  // Just --help — does not actually run a sweep, just prints usage.
  const out = execFileSync('node', [GATETEST_BIN, 'sweep', '--help'], { encoding: 'utf8' });
  assert.match(out, /GateTest Sweep/);
});

test('gatetest scan is treated as the default scan flow (alias) and not as sweep', () => {
  // Don't actually run a scan — just hit --help on the alias.
  const out = execFileSync('node', [GATETEST_BIN, 'scan', '--help'], { encoding: 'utf8' });
  // The default --help is the GateTest CLI help, not the sweep help.
  assert.match(out, /GateTest - Advanced QA Gate System/);
  assert.equal(/GateTest Sweep/.test(out), false);
});

test('npm script "sweep" is wired and points at bin/gatetest-sweep.js', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../..', 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.sweep, 'node bin/gatetest-sweep.js');
});

test('renderStepLine includes name, marker, summary, and duration', () => {
  const step = steps.ALL_STEPS[3]; // gate
  const line = cli.renderStepLine(step, 3, 7, { ok: true, summary: '0 errors, 0 warnings', durationMs: 1500 });
  assert.match(line, /\[4\/7\]/);
  assert.match(line, /Gate \(quick suite\)/);
  assert.match(line, /0 errors, 0 warnings/);
  assert.match(line, /1\.5s/);
});
