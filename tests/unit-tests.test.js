const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const UnitTestsModule = require('../src/modules/unit-tests');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) { this.checks.push({ name, passed, ...details }); },
  };
}

describe('UnitTestsModule — baseline shape', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-unit-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('exposes the expected BaseModule shape', () => {
    const mod = new UnitTestsModule();
    assert.strictEqual(typeof mod.name, 'string');
    assert.ok(mod.name.length > 0);
    assert.strictEqual(typeof mod.description, 'string');
    assert.ok(mod.description.length > 0);
    assert.strictEqual(typeof mod.run, 'function');
  });

  it('runs without throwing on an empty project root', async () => {
    const mod = new UnitTestsModule();
    const result = makeResult();
    await assert.doesNotReject(mod.run(result, { projectRoot: tmp }));
  });
});

// ── environment honesty (2026-08-18 audit) ─────────────────────────────────
describe('UnitTestsModule — toolchain detection beyond Node', () => {
  const fs2 = require('node:fs');
  const os2 = require('node:os');
  const path2 = require('node:path');
  const withRepo = (files, fn) => {
    const root = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'gt-ut-'));
    try {
      for (const [rel, c] of Object.entries(files)) {
        fs2.mkdirSync(path2.dirname(path2.join(root, rel)), { recursive: true });
        fs2.writeFileSync(path2.join(root, rel), c);
      }
      return fn(root);
    } finally { fs2.rmSync(root, { recursive: true, force: true }); }
  };

  it('detects go / cargo / maven / gradle / rspec projects instead of "No test framework detected"', () => {
    const mod = new UnitTestsModule();
    assert.strictEqual(withRepo({ 'go.mod': 'module x', 'a_test.go': '' }, (r) => mod._detectTestCommand(r)).name, 'go test');
    assert.strictEqual(withRepo({ 'Cargo.toml': '[package]' }, (r) => mod._detectTestCommand(r)).name, 'cargo test');
    assert.strictEqual(withRepo({ 'pom.xml': '<project/>' }, (r) => mod._detectTestCommand(r)).name, 'Maven');
    assert.strictEqual(withRepo({ 'build.gradle': '' }, (r) => mod._detectTestCommand(r)).name, 'Gradle');
    assert.strictEqual(withRepo({ 'Gemfile': '' }, (r) => mod._detectTestCommand(r)).name, 'RSpec');
  });

  it('"No test framework detected" is a warning, not a gate-blocking error', async () => {
    await withRepo({ 'README.md': '# x' }, async (r) => {
      const checks = [];
      await new UnitTestsModule().run({ addCheck: (id, passed, meta) => checks.push({ id, passed, meta: meta || {} }) }, { projectRoot: r, getModuleConfig() { return {}; } });
      const d = checks.find((c) => c.id === 'unit-tests:detect');
      assert.ok(d && !d.passed && d.meta.severity === 'warning', JSON.stringify(checks));
    });
  });

  it('a runner that could not START (ModuleNotFoundError / command not found) is an info skip, not "Unit tests failed"', () => {
    const mod = new UnitTestsModule();
    assert.strictEqual(mod._looksLikeMissingToolchain("ModuleNotFoundError: No module named 'flask'"), true);
    assert.strictEqual(mod._looksLikeMissingToolchain('bash: go: command not found'), true);
    assert.strictEqual(mod._looksLikeMissingToolchain('FAIL tests/foo.test.js\n  expected 1 to equal 2'), false);
  });

  it('runs the customer suite with GATETEST_* scrubbed from the environment', () => {
    const src = fs2.readFileSync(path2.join(__dirname, '..', 'src', 'modules', 'unit-tests.js'), 'utf8');
    assert.match(src, /if \(\/\^GATETEST_\/\.test\(k\)\) delete env\[k\]/);
  });
});

// 2026-09-05: laravel (`/bin/sh: 1: vendor/bin/phpunit: not found`), ktor (a
// Gradle compile failure under a toolchain this box lacks) and
// CleanArchitecture (`node --test` running an Angular `test.ts`) all reported
// "Unit tests failed" for what was our environment.
describe('UnitTestsModule — an environment that cannot run the suite is not a failing suite', () => {
  const mod = new UnitTestsModule();
  for (const out of [
    '/bin/sh: 1: vendor/bin/phpunit: not found',
    "Execution failed for task ':build-settings-logic:compileKotlin'.\n> Compilation error. See log for more details\nBUILD FAILED in 1m 38s",
    'SDK location not found. Define a valid SDK location',
  ]) {
    it(`treats "${out.split('\n')[0].slice(0, 50)}" as a missing toolchain`, () => {
      assert.strictEqual(mod._looksLikeMissingToolchain(out), true);
    });
  }
  it('a real assertion failure is still a failure', () => {
    assert.strictEqual(mod._looksLikeMissingToolchain('AssertionError: expected 1 to equal 2\n  at test.js:12'), false);
  });
  it('node --test is only chosen when the test dir holds JavaScript', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ut-js-'));
    try {
      fs.mkdirSync(path.join(tmp, 'test'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'test', 'test.ts'), 'import "zone.js/testing";\n');
      assert.strictEqual(mod._hasRunnableJsTests(path.join(tmp, 'test')), false);
      fs.writeFileSync(path.join(tmp, 'test', 'a.test.js'), 'const t = require("node:test"); t("x", () => {});\n');
      assert.strictEqual(mod._hasRunnableJsTests(path.join(tmp, 'test')), true);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

// GT-14b (issue #771): AlecRae.com's esbuild pinned an ES2024 target this
// scan box's Node did not support — the suite never got the chance to run a
// single test, and unit-tests.js reported "Unit tests failed" for it anyway.
// Control pair: a "Transform failed" toolchain error before any test ran is
// a warning ("not checked"), never `unit-tests:run` blocking; a genuine TAP
// `not ok` failure still blocks exactly as before.
describe('UnitTestsModule — GT-14b (#771): a toolchain/build failure is "not checked", not a test failure', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ut-toolchain-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('NEGATIVE: esbuild-shaped "Transform failed" before any test ran is a warning, not "tests failed"', async () => {
    fs.writeFileSync(path.join(tmp, 'toolchain-fail.js'),
      "throw new Error('Transform failed with 1 error: ES2024 not supported');\n");
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
      name: 'x', scripts: { test: 'node toolchain-fail.js' },
    }));

    const mod = new UnitTestsModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp, getModuleConfig() { return {}; } });

    const run = result.checks.find((c) => c.name === 'unit-tests:run');
    assert.strictEqual(run, undefined, `must not report unit-tests:run blocking, got: ${JSON.stringify(result.checks)}`);
    const nc = result.checks.find((c) => c.name === 'unit-tests:toolchain-not-checked');
    assert.ok(nc, `expected unit-tests:toolchain-not-checked, got: ${JSON.stringify(result.checks.map((c) => c.name))}`);
    assert.strictEqual(nc.passed, false);
    assert.strictEqual(nc.severity, 'warning');
    assert.match(nc.message, /^tests could not run: .*Transform failed.*; not checked$/);
  });

  it('POSITIVE: a genuine TAP failure ("not ok") still blocks exactly as today', async () => {
    fs.writeFileSync(path.join(tmp, 'tap-fail.js'),
      "console.log('TAP version 13');\nconsole.log('not ok 1 - adds');\nprocess.exit(1);\n");
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
      name: 'x', scripts: { test: 'node tap-fail.js' },
    }));

    const mod = new UnitTestsModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp, getModuleConfig() { return {}; } });

    const run = result.checks.find((c) => c.name === 'unit-tests:run');
    assert.ok(run, `expected unit-tests:run, got: ${JSON.stringify(result.checks.map((c) => c.name))}`);
    assert.strictEqual(run.passed, false);
    assert.strictEqual(run.severity, 'error');
    const nc = result.checks.find((c) => c.name === 'unit-tests:toolchain-not-checked');
    assert.strictEqual(nc, undefined, 'a genuine failure must never be reclassified as not-checked');
  });
});

// A Gradle daemon outlives the module's timeout kill and keeps writing into
// the checkout (ktor on CI, 2026-09-05). The build must run in the child.
describe('UnitTestsModule — Gradle runs without a daemon', () => {
  it('the Gradle command carries --no-daemon', () => {
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'modules', 'unit-tests.js'), 'utf8');
    assert.match(src, /name: 'Gradle', command: 'gradle test --no-daemon/);
  });
});
