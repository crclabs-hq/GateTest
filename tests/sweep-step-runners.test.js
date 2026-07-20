'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const steps = require('../lib/sweep-steps');

/**
 * Build a stub runProcess that returns a stable canned envelope based on
 * which command was invoked. Lets us test the per-step parsers without
 * shelling out for real.
 */
function makeRunner(scripts) {
  return function runner(cmd, args /*, opts*/) {
    const key = `${cmd} ${(args || []).join(' ')}`;
    for (const re of Object.keys(scripts)) {
      // crude prefix match
      if (key.startsWith(re) || key === re) {
        const res = scripts[re];
        if (typeof res === 'function') return res({ cmd, args });
        return Object.assign({ durationMs: 5, stdout: '', stderr: '', exitCode: 0, spawnError: null }, res);
      }
    }
    return { durationMs: 1, stdout: '', stderr: '', exitCode: 0, spawnError: null };
  };
}

// ============================================================
// Tests step
// ============================================================

test('runTestsStep parses pass/fail/total from node --test output', () => {
  const runner = makeRunner({
    'sh -c node --test tests/*.test.js': {
      stdout: '# tests 1234\n# pass 1234\n# fail 0\n',
      exitCode: 0,
    },
  });
  const r = steps.runTestsStep({ runner });
  assert.equal(r.ok, true);
  assert.equal(r.testsTotal, 1234);
  assert.equal(r.testsPassed, 1234);
  assert.equal(r.testsFailed, 0);
  assert.match(r.summary, /1234 \/ 1234 passed/);
});

test('runTestsStep marks failure when exit != 0', () => {
  const runner = makeRunner({
    'sh -c node --test tests/*.test.js': {
      stdout: '# tests 10\n# pass 7\n# fail 3\n',
      exitCode: 1,
    },
  });
  const r = steps.runTestsStep({ runner });
  assert.equal(r.ok, false);
  assert.equal(r.testsFailed, 3);
  assert.match(r.summary, /7 \/ 10 passed.*3 failed/);
});

test('runTestsStep surfaces spawn errors gracefully', () => {
  const runner = () => ({
    durationMs: 0, stdout: '', stderr: '', exitCode: null,
    spawnError: new Error('node binary missing'),
  });
  const r = steps.runTestsStep({ runner });
  assert.equal(r.ok, false);
  assert.match(r.summary, /Could not run tests/);
  assert.match(r.summary, /node binary missing/);
});

// ============================================================
// Website build step
// ============================================================

test('runWebsiteBuildStep skips cleanly when website/ is absent', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-build-'));
  try {
    const r = steps.runWebsiteBuildStep({ cwd: tmp });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
    assert.match(r.summary, /skipped/);
    assert.match(r.skipReason, /no website/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runWebsiteBuildStep extracts page count from next output', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-build-'));
  fs.mkdirSync(path.join(tmp, 'website'));
  try {
    const runner = makeRunner({
      'npx next build': {
        stdout: 'Generating static pages (63/63)\nCompiled successfully\n',
        exitCode: 0,
      },
    });
    const r = steps.runWebsiteBuildStep({ cwd: tmp, runner });
    assert.equal(r.ok, true);
    assert.equal(r.pageCount, 63);
    assert.match(r.summary, /63 pages/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runWebsiteBuildStep marks failure when next exits non-zero', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-build-'));
  fs.mkdirSync(path.join(tmp, 'website'));
  try {
    const runner = makeRunner({
      'npx next build': { stdout: '', stderr: 'Error', exitCode: 1 },
    });
    const r = steps.runWebsiteBuildStep({ cwd: tmp, runner });
    assert.equal(r.ok, false);
    assert.match(r.summary, /build failed/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ============================================================
// Module load step
// ============================================================

test('runModuleLoadStep parses module lines and passes at >= 90', () => {
  // 92 module-shaped lines (2-space indent, identifier, whitespace).
  const lines = [];
  for (let i = 0; i < 92; i++) lines.push(`  module${i}        description ${i}`);
  const stdout = ['', 'Available GateTest Modules:', '', ...lines, ''].join('\n');
  const runner = makeRunner({ 'node bin/gatetest.js --list': { stdout, exitCode: 0 } });
  const r = steps.runModuleLoadStep({ runner });
  assert.equal(r.ok, true);
  assert.equal(r.moduleCount, 92);
  assert.match(r.summary, /92 modules/);
});

test('runModuleLoadStep fails when below the threshold', () => {
  const lines = [];
  for (let i = 0; i < 5; i++) lines.push(`  module${i}        d ${i}`);
  const stdout = lines.join('\n') + '\n';
  const runner = makeRunner({ 'node bin/gatetest.js --list': { stdout, exitCode: 0 } });
  const r = steps.runModuleLoadStep({ runner, minModules: 90 });
  assert.equal(r.ok, false);
  assert.match(r.summary, /only 5/);
});

// ============================================================
// Gate step
// ============================================================

test('runGateStep parses Errors / Warnings counts and passes on exit 0', () => {
  const runner = makeRunner({
    'node bin/gatetest.js --suite quick': {
      stdout: 'Errors: 0\nWarnings: 12\n',
      exitCode: 0,
    },
  });
  const r = steps.runGateStep({ runner });
  assert.equal(r.ok, true);
  assert.equal(r.errorCount, 0);
  assert.equal(r.warningCount, 12);
  assert.match(r.summary, /0 errors, 12 warnings/);
});

test('runGateStep marks failure on non-zero exit', () => {
  const runner = makeRunner({
    'node bin/gatetest.js --suite quick': {
      stdout: 'Errors: 2\nWarnings: 5\n',
      exitCode: 1,
    },
  });
  const r = steps.runGateStep({ runner });
  assert.equal(r.ok, false);
  assert.equal(r.errorCount, 2);
});

test('runGateStep accepts a custom suite name', () => {
  let seenArgs = null;
  const runner = (cmd, args) => {
    seenArgs = args;
    return { durationMs: 1, stdout: 'Errors: 0\nWarnings: 0\n', stderr: '', exitCode: 0 };
  };
  steps.runGateStep({ runner, suite: 'full' });
  assert.deepEqual(seenArgs, ['bin/gatetest.js', '--suite', 'full']);
});

// ============================================================
// Secrets step
// ============================================================

test('runSecretsStep returns ok with empty hits for a clean tree', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-secrets-'));
  try {
    // No git ls-files invoke necessary — provide a fake one that returns
    // a single tracked file with no secret in it.
    fs.writeFileSync(path.join(tmp, 'README.md'), '# hello\n');
    const runner = (cmd) => {
      if (cmd === 'git') {
        return { durationMs: 1, stdout: 'README.md\n', stderr: '', exitCode: 0 };
      }
      return { durationMs: 1, stdout: '', stderr: '', exitCode: 0 };
    };
    const r = steps.runSecretsStep({ cwd: tmp, runner });
    assert.equal(r.ok, true);
    assert.equal(r.hits.length, 0);
    assert.match(r.summary, /none found/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runSecretsStep flags a file containing an AWS-shaped key', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-secrets-'));
  try {
    const evil = 'AKIA' + 'A'.repeat(16); // matches AKIA[0-9A-Z]{16}
    fs.writeFileSync(path.join(tmp, 'oops.txt'), `const k = "${evil}";\n`);
    const runner = (cmd) => {
      if (cmd === 'git') return { durationMs: 1, stdout: 'oops.txt\n', stderr: '', exitCode: 0 };
      return { durationMs: 1, stdout: '', stderr: '', exitCode: 0 };
    };
    const r = steps.runSecretsStep({ cwd: tmp, runner });
    assert.equal(r.ok, false);
    assert.equal(r.hits.length, 1);
    assert.match(r.hits[0], /oops\.txt:1/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runSecretsStep excludes docs/, tests/, .env.example, .gitignore', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-secrets-'));
  try {
    fs.mkdirSync(path.join(tmp, 'docs'));
    fs.mkdirSync(path.join(tmp, 'tests'));
    const evil = 'AKIA' + 'A'.repeat(16);
    fs.writeFileSync(path.join(tmp, 'docs/example.md'), evil);
    fs.writeFileSync(path.join(tmp, 'tests/sample.test.js'), evil);
    fs.writeFileSync(path.join(tmp, '.env.example'), evil);
    fs.writeFileSync(path.join(tmp, '.gitignore'), evil);
    const runner = (cmd) => {
      if (cmd === 'git') return { durationMs: 1, stdout: 'docs/example.md\ntests/sample.test.js\n.env.example\n.gitignore\n', stderr: '', exitCode: 0 };
      return { durationMs: 1, stdout: '', stderr: '', exitCode: 0 };
    };
    const r = steps.runSecretsStep({ cwd: tmp, runner });
    assert.equal(r.ok, true);
    assert.equal(r.hits.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ============================================================
// TODO/FIXME step (informational)
// ============================================================

test('runTodoCountStep counts matches but never fails', () => {
  const runner = makeRunner({
    'git grep': {
      stdout: 'src/a.js:12:// TODO fix me\nsrc/b.js:5:// FIXME later\n',
      exitCode: 0,
    },
  });
  const r = steps.runTodoCountStep({ runner });
  assert.equal(r.ok, true);
  assert.equal(r.todoCount, 2);
});

test('runTodoCountStep returns ok=true even when git-grep finds nothing (exit 1)', () => {
  const runner = makeRunner({
    'git grep': { stdout: '', exitCode: 1 },
  });
  const r = steps.runTodoCountStep({ runner });
  assert.equal(r.ok, true);
  assert.equal(r.todoCount, 0);
});

// ============================================================
// resolveStep
// ============================================================

test('resolveStep resolves numeric and key selectors', () => {
  assert.equal(steps.resolveStep('1').key, 'tests');
  assert.equal(steps.resolveStep('gate').number, 4);
  assert.equal(steps.resolveStep('GATE').number, 4);
  assert.equal(steps.resolveStep('selfscan').number, 7);
  assert.equal(steps.resolveStep('nope'), null);
  assert.equal(steps.resolveStep(null), null);
});

test('ALL_STEPS is the full ordered list of 8 sweep steps', () => {
  assert.equal(steps.ALL_STEPS.length, 8);
  const numbers = steps.ALL_STEPS.map((s) => s.number);
  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(
    steps.ALL_STEPS.map((s) => s.key),
    ['tests', 'build', 'modules', 'gate', 'secrets', 'todos', 'selfscan', 'lint'],
  );
});

// ============================================================
// Lint step
// ============================================================

test('runLintStep passes cleanly on exit 0 with no problems', () => {
  const runner = makeRunner({
    'npx eslint src bin lib integrations': { stdout: '', exitCode: 0 },
  });
  const r = steps.runLintStep({ runner });
  assert.equal(r.ok, true);
  assert.equal(r.summary, 'clean');
});

test('runLintStep parses error/warning counts and fails on non-zero exit', () => {
  const runner = makeRunner({
    'npx eslint src bin lib integrations': {
      stdout: '✖ 3 problems (2 errors, 1 warning)\n',
      exitCode: 1,
    },
  });
  const r = steps.runLintStep({ runner });
  assert.equal(r.ok, false);
  assert.equal(r.errorCount, 2);
  assert.equal(r.warningCount, 1);
  assert.match(r.summary, /2 error/);
});

test('runLintStep surfaces spawn errors gracefully', () => {
  const runner = () => ({
    durationMs: 0, stdout: '', stderr: '', exitCode: null,
    spawnError: new Error('npx not found'),
  });
  const r = steps.runLintStep({ runner });
  assert.equal(r.ok, false);
  assert.match(r.summary, /Could not run lint/);
});

test('SECRET_PATTERN matches each known credential shape', () => {
  const samples = [
    'AKIA' + 'A'.repeat(16),
    'ASIA' + 'B'.repeat(16),
    'sk_live_' + 'a'.repeat(24),
    'sk_test_' + 'a'.repeat(24),
    'ghp_' + 'a'.repeat(36),
  ];
  for (const s of samples) assert.ok(steps.SECRET_PATTERN.test(s), `expected match for ${s.slice(0, 8)}…`);
});
