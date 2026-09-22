const { describe, it } = require('node:test');
const assert = require('node:assert');

const FakeFixDetector = require('../src/modules/fake-fix-detector');
const { TestResult } = require('../src/core/runner');
const { GateTestConfig } = require('../src/core/config');

/**
 * Build a minimal GateTestConfig and inject a diff via _runnerOptions so the
 * module never has to shell out to git.
 */
function makeConfig(diff, extraModuleConfig = {}) {
  const config = new GateTestConfig(process.cwd());
  // Force-disable AI engine for pattern tests — we don't want network calls.
  config.config.modules.fakeFixDetector = {
    patternEngine: true,
    aiEngine: false,
    ...extraModuleConfig,
  };
  config._runnerOptions = { diff };
  return config;
}

function failedCheckNames(result) {
  return result.checks.filter(c => !c.passed).map(c => c.name);
}

function findFailure(result, ruleIdFragment) {
  return result.checks.find(c => !c.passed && c.name.includes(ruleIdFragment));
}

describe('FakeFixDetectorModule', () => {
  it('flags it.skip added to a test file', async () => {
    const diff = [
      'diff --git a/tests/auth.test.js b/tests/auth.test.js',
      'index abc..def 100644',
      '--- a/tests/auth.test.js',
      '+++ b/tests/auth.test.js',
      '@@ -10,3 +10,3 @@',
      "-  it('rejects invalid tokens', () => {",
      "+  it.skip('rejects invalid tokens', () => {",
      '     expect(verify(BAD_TOKEN)).toBe(false);',
    ].join('\n');

    const mod = new FakeFixDetector();
    const result = new TestResult('fakeFixDetector');
    result.start();

    await mod.run(result, makeConfig(diff));

    const failure = findFailure(result, 'test-skip-added');
    assert.ok(failure, 'expected a test-skip-added failure');
    assert.strictEqual(failure.severity, 'error');
  });

  it('flags empty catch blocks', async () => {
    const diff = [
      'diff --git a/src/api.js b/src/api.js',
      '--- a/src/api.js',
      '+++ b/src/api.js',
      '@@ -5,5 +5,7 @@',
      '   try {',
      '     await fetchUser();',
      '-  } catch (err) { throw err; }',
      '+  } catch (err) { }',
    ].join('\n');

    const mod = new FakeFixDetector();
    const result = new TestResult('fakeFixDetector');
    result.start();

    await mod.run(result, makeConfig(diff));

    const failure = findFailure(result, 'empty-catch');
    assert.ok(failure, 'expected empty-catch failure');
    assert.strictEqual(failure.severity, 'error');
  });

  it('flags @ts-ignore suppressions', async () => {
    const diff = [
      'diff --git a/src/index.ts b/src/index.ts',
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
      '@@ -3,3 +3,4 @@',
      ' function parse(input) {',
      '+  // @ts-ignore',
      '   return JSON.parse(input)',
      ' }',
    ].join('\n');

    const mod = new FakeFixDetector();
    const result = new TestResult('fakeFixDetector');
    result.start();

    await mod.run(result, makeConfig(diff));

    const failure = findFailure(result, 'ts-ignore-added');
    assert.ok(failure, 'expected ts-ignore-added failure');
    assert.strictEqual(failure.severity, 'error');
  });

  // #666: _parseDiff reported the hunk's FIRST line for every match inside
  // it. Customer example: a finding at hunk-start line 2106 (a `return`)
  // where the real `@ts-ignore` sits at 2116 — ten lines into the hunk.
  // This reproduces that shape with a synthetic diff.
  it('#666: reports the line of the matching `+` line, not the hunk start, 10 lines into the hunk', async () => {
    const diff = [
      'diff --git a/src/big-file.ts b/src/big-file.ts',
      '--- a/src/big-file.ts',
      '+++ b/src/big-file.ts',
      '@@ -2106,12 +2106,13 @@',
      '   return foo();',
      '   const a = 1;',
      '   const b = 2;',
      '   const c = 3;',
      '   const d = 4;',
      '   const e = 5;',
      '   const f = 6;',
      '   const g = 7;',
      '   const h = 8;',
      '   const i = 9;',
      '+  // @ts-ignore',
      '   const j = 10;',
    ].join('\n');

    const mod = new FakeFixDetector();
    const result = new TestResult('fakeFixDetector');
    result.start();

    await mod.run(result, makeConfig(diff));

    const failure = findFailure(result, 'ts-ignore-added');
    assert.ok(failure, 'expected ts-ignore-added failure');
    assert.strictEqual(failure.line, 2116, `expected the @ts-ignore line (2116), not the hunk start (2106); got ${failure.line}`);
  });

  // #666: `@ts-expect-error` directly above the `expect(...)` it enables is
  // the sanctioned use inside a test file — downgrade to info instead of
  // reporting it as a suppressed type error.
  it('#666: downgrades @ts-expect-error to info in a test file when the next line is an expect(...)', async () => {
    const diff = [
      'diff --git a/tests/add.test.ts b/tests/add.test.ts',
      '--- a/tests/add.test.ts',
      '+++ b/tests/add.test.ts',
      '@@ -630,2 +630,4 @@',
      "   it('rejects a string where a number is required', () => {",
      '+    // @ts-expect-error',
      "+    expect(() => add('1', 2)).toThrow();",
      '   });',
    ].join('\n');

    const mod = new FakeFixDetector();
    const result = new TestResult('fakeFixDetector');
    result.start();

    await mod.run(result, makeConfig(diff));

    const failure = findFailure(result, 'ts-ignore-added');
    assert.ok(failure, 'expected a ts-ignore-added check to still be recorded');
    assert.strictEqual(failure.severity, 'info', 'sanctioned @ts-expect-error use must be downgraded to info');
  });

  // Control: the same shape OUTSIDE a test file must stay at error severity —
  // proves the downgrade is scoped to test files, not to any expect()-like text.
  it('#666: @ts-expect-error followed by expect(...) in a non-test file stays error', async () => {
    const diff = [
      'diff --git a/src/add.ts b/src/add.ts',
      '--- a/src/add.ts',
      '+++ b/src/add.ts',
      '@@ -3,2 +3,4 @@',
      '   function add(a, b) {',
      '+    // @ts-expect-error',
      '+    expect(a).toBeDefined();',
      '   }',
    ].join('\n');

    const mod = new FakeFixDetector();
    const result = new TestResult('fakeFixDetector');
    result.start();

    await mod.run(result, makeConfig(diff));

    const failure = findFailure(result, 'ts-ignore-added');
    assert.ok(failure, 'expected ts-ignore-added failure');
    assert.strictEqual(failure.severity, 'error');
  });

  it('flags if (false) dead-code guards', async () => {
    const diff = [
      'diff --git a/src/validator.js b/src/validator.js',
      '--- a/src/validator.js',
      '+++ b/src/validator.js',
      '@@ -8,3 +8,3 @@',
      '-  if (!isValid(payload)) throw new Error("invalid");',
      '+  if (false) throw new Error("invalid");',
    ].join('\n');

    const mod = new FakeFixDetector();
    const result = new TestResult('fakeFixDetector');
    result.start();

    await mod.run(result, makeConfig(diff));

    const failure = findFailure(result, 'always-pass');
    assert.ok(failure, 'expected always-pass failure');
    assert.strictEqual(failure.severity, 'error');
  });

  it('flags as any casts', async () => {
    const diff = [
      'diff --git a/src/thing.ts b/src/thing.ts',
      '--- a/src/thing.ts',
      '+++ b/src/thing.ts',
      '@@ -1,3 +1,3 @@',
      '-const x: User = getUser();',
      '+const x = getUser() as any;',
    ].join('\n');

    const mod = new FakeFixDetector();
    const result = new TestResult('fakeFixDetector');
    result.start();

    await mod.run(result, makeConfig(diff));

    const failure = findFailure(result, 'any-cast-added');
    assert.ok(failure, 'expected any-cast-added failure');
    assert.strictEqual(failure.severity, 'warning');
  });

  it('flags eslint-disable inline suppressions', async () => {
    const diff = [
      'diff --git a/src/file.js b/src/file.js',
      '--- a/src/file.js',
      '+++ b/src/file.js',
      '@@ -1,3 +1,4 @@',
      ' const x = 1;',
      '+// eslint-disable-next-line no-unused-vars',
      ' const y = 2;',
    ].join('\n');

    const mod = new FakeFixDetector();
    const result = new TestResult('fakeFixDetector');
    result.start();

    await mod.run(result, makeConfig(diff));

    const failure = findFailure(result, 'eslint-disable-added');
    assert.ok(failure, 'expected eslint-disable-added failure');
  });

  it('passes clean on a real fix (logic change with no anti-patterns)', async () => {
    const diff = [
      'diff --git a/src/math.js b/src/math.js',
      '--- a/src/math.js',
      '+++ b/src/math.js',
      '@@ -1,3 +1,3 @@',
      ' function average(nums) {',
      '-  return nums.reduce((a, b) => a + b) / nums.length;',
      '+  if (nums.length === 0) return 0;',
      '+  return nums.reduce((a, b) => a + b, 0) / nums.length;',
      ' }',
    ].join('\n');

    const mod = new FakeFixDetector();
    const result = new TestResult('fakeFixDetector');
    result.start();

    await mod.run(result, makeConfig(diff));

    const failures = failedCheckNames(result);
    assert.strictEqual(failures.length, 0, `expected no failures, got: ${failures.join(', ')}`);

    const cleanCheck = result.checks.find(c => c.name === 'fake-fix:clean');
    assert.ok(cleanCheck, 'expected fake-fix:clean check when no issues found');
  });

  it('reports a no-diff info check when diff is empty', async () => {
    const mod = new FakeFixDetector();
    const result = new TestResult('fakeFixDetector');
    result.start();

    await mod.run(result, makeConfig(''));

    const noDiff = result.checks.find(c => c.name === 'fake-fix:no-diff');
    assert.ok(noDiff, 'expected fake-fix:no-diff check');
    assert.strictEqual(noDiff.severity, 'info');
  });

  it('can detect multiple anti-patterns in a single diff', async () => {
    const diff = [
      'diff --git a/src/handler.js b/src/handler.js',
      '--- a/src/handler.js',
      '+++ b/src/handler.js',
      '@@ -1,5 +1,6 @@',
      ' async function handle(req) {',
      '-  const user = await db.getUser(req.id);',
      '+  try { const user = await db.getUser(req.id); } catch (err) { }',
      '+  // @ts-ignore',
      '   return { ok: true };',
      ' }',
    ].join('\n');

    const mod = new FakeFixDetector();
    const result = new TestResult('fakeFixDetector');
    result.start();

    await mod.run(result, makeConfig(diff));

    assert.ok(findFailure(result, 'empty-catch'), 'expected empty-catch');
    assert.ok(findFailure(result, 'ts-ignore-added'), 'expected ts-ignore-added');
  });

  it('respects patternEngine: false config', async () => {
    const diff = [
      'diff --git a/a.js b/a.js',
      '--- a/a.js',
      '+++ b/a.js',
      '@@ -1,1 +1,1 @@',
      '+it.skip("x", () => {})',
    ].join('\n');

    const mod = new FakeFixDetector();
    const result = new TestResult('fakeFixDetector');
    result.start();

    await mod.run(result, makeConfig(diff, { patternEngine: false, aiEngine: false }));

    const failures = failedCheckNames(result);
    assert.strictEqual(failures.length, 0, 'pattern engine disabled should produce no failures');
  });

  it('exposes PATTERN_RULES for inspection', () => {
    assert.ok(Array.isArray(FakeFixDetector.PATTERN_RULES));
    assert.ok(FakeFixDetector.PATTERN_RULES.length >= 10);
    for (const rule of FakeFixDetector.PATTERN_RULES) {
      assert.ok(rule.id, 'rule must have id');
      assert.ok(['error', 'warning', 'info'].includes(rule.severity), 'valid severity');
      assert.ok(rule.title, 'rule must have title');
    }
  });
});

// strict-to-loose: `/==[^=]/` matched INSIDE `=== 'x'` (the last two `=`
// plus the space), so a hunk that merely moved a strict comparison
// reported it as relaxed (2026-09-05, a file-walk replacement in
// typescript-strictness.js). Control pair: the real relaxation must still
// fire; a moved `===` must not.
describe('FakeFixDetectorModule — strict-to-loose is a token, not a substring', () => {
  async function run(diff) {
    const mod = new FakeFixDetector();
    const result = new TestResult('fakeFixDetector');
    result.start();
    await mod.run(result, makeConfig(diff));
    return result;
  }
  const hunk = (lines) => [
    'diff --git a/src/a.js b/src/a.js', '--- a/src/a.js', '+++ b/src/a.js', '@@ -1,4 +1,4 @@', ...lines,
  ].join('\n');

  it('fires when === becomes ==', async () => {
    const result = await run(hunk([
      ' function isTs(name) {',
      "-  return name === 'tsconfig.json';",
      "+  return name == 'tsconfig.json';",
      ' }',
    ]));
    assert.ok(findFailure(result, 'strict-to-loose'), 'a real relaxation must be reported');
  });

  it('stays quiet when a === line only moves', async () => {
    const result = await run(hunk([
      ' function isTs(name) {',
      "-  if (name === 'tsconfig.json') return true;",
      '+  const base = path.basename(name);',
      "+  if (base === 'tsconfig.json') return true;",
      ' }',
    ]));
    assert.ok(!findFailure(result, 'strict-to-loose'), `moved strict comparison reported as relaxed: ${failedCheckNames(result).join(', ')}`);
  });

  it('stays quiet when == is added beside a === that stays', async () => {
    const result = await run(hunk([
      ' function f(a, b) {',
      '-  if (a === b) return 1;',
      '+  if (a === b) return 1;',
      '+  if (a == null) return 0;',
      ' }',
    ]));
    assert.ok(!findFailure(result, 'strict-to-loose'));
  });
});

// A fix lives in source: documentation hunks are not scanned by the pattern
// engine. A docs table naming `@ts-ignore` / `as any` lit up five rules on
// 2026-09-05 when a CRLF→LF rewrite made docs/ARCHITECTURE.md one big hunk.
describe('FakeFixDetectorModule — documentation is not source', () => {
  async function run(diff) {
    const mod = new FakeFixDetector();
    const result = new TestResult('fakeFixDetector');
    result.start();
    await mod.run(result, makeConfig(diff));
    return result;
  }
  const PROSE = [
    ' | module | what it flags |',
    '-| ts | flags `@ts-ignore` and `as any` |',
    '+| ts | flags `@ts-ignore`, `as any`, and `if (false)` dead-code guards; unreasoned `@ts-ignore` is a warning |',
    '+Also: `catch (err) {}` and `test.skip(` are symptom patches, and `!==` becoming `==` is a relaxed check.',
  ];
  it('ignores a Markdown hunk that names every pattern', async () => {
    const r = await run(['diff --git a/docs/ARCH.md b/docs/ARCH.md', '--- a/docs/ARCH.md', '+++ b/docs/ARCH.md', '@@ -1,3 +1,4 @@', ...PROSE].join('\n'));
    assert.deepStrictEqual(failedCheckNames(r), [], 'prose in docs must not read as a fake fix');
  });
  it('still fires on the same text inside a source file', async () => {
    const r = await run(['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,2 @@', ' const x = 1;', '-const y: number = load();', '+// @ts-ignore', '+const y = load() as any;'].join('\n'));
    assert.ok(failedCheckNames(r).length > 0, 'positive control');
  });
});

// #669: adminOps.ts:2116 was a JSDoc line describing the directive in prose
// ("Use // @ts-expect-error when …"), not the directive itself, and the old
// `.*@ts-...` pattern matched it anywhere on the line. The directive must
// now be the first non-space token of the added line.
describe('FakeFixDetectorModule — ts-ignore-added fires only on the real directive (#669)', () => {
  async function run(diff) {
    const mod = new FakeFixDetector();
    const result = new TestResult('fakeFixDetector');
    result.start();
    await mod.run(result, makeConfig(diff));
    return result;
  }

  it('does not fire on a JSDoc line that mentions @ts-expect-error in prose', async () => {
    const diff = [
      'diff --git a/src/adminOps.ts b/src/adminOps.ts',
      '--- a/src/adminOps.ts',
      '+++ b/src/adminOps.ts',
      '@@ -10,2 +10,3 @@',
      ' /**',
      '+ * Use // @ts-expect-error when bypassing a known-bad third-party type.',
      '  */',
    ].join('\n');
    const r = await run(diff);
    assert.ok(!findFailure(r, 'ts-ignore-added'), 'a doc comment describing the directive must not fire');
  });

  it('fires when // @ts-ignore is the first token of the added line', async () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,3 @@',
      ' function parse(input) {',
      '+  // @ts-ignore',
      '   return JSON.parse(input)',
      ' }',
    ].join('\n');
    const r = await run(diff);
    const failure = findFailure(r, 'ts-ignore-added');
    assert.ok(failure, 'a real directive line must fire');
    assert.strictEqual(failure.severity, 'error');
  });

  it('does not fire when // @ts-ignore trails real code instead of leading the line', async () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,2 @@',
      ' function f() {',
      '+  const x = 1; // @ts-ignore',
      ' }',
    ].join('\n');
    const r = await run(diff);
    assert.ok(!findFailure(r, 'ts-ignore-added'), 'a trailing comment is not a functioning TS directive and must not fire');
  });
});

// `temp` matched `// template expression` — a comment about template
// literals was "a TODO/FIXME/HACK comment added". Found by the determinism
// gate on our own diff (2026-09-05). Token, not prefix (doctrine §5).
describe('FakeFixDetectorModule — commented-out-code is a token, not a prefix', () => {
  async function run(diff) {
    const mod = new FakeFixDetector();
    const result = new TestResult('fakeFixDetector');
    result.start();
    await mod.run(result, makeConfig(diff));
    return result;
  }
  const hunk = (lines) => [
    'diff --git a/src/a.js b/src/a.js', '--- a/src/a.js', '+++ b/src/a.js', '@@ -1,3 +1,4 @@', ...lines,
  ].join('\n');

  it('fires on `// TEMP disable` and `// HACK:`', async () => {
    const result = await run(hunk([' const a = 1;', '+  // TEMP disable the check', '+  // HACK: skip validation', ' return a;']));
    assert.ok(findFailure(result, 'commented-out-code'), failedCheckNames(result).join(', '));
  });

  it('stays quiet on `// template expression` and `// disabled-by-default option`', async () => {
    const result = await run(hunk([' const a = 1;', '+  // template expressions are code', '+  // disabled-by-default option', ' return a;']));
    assert.ok(!findFailure(result, 'commented-out-code'), failedCheckNames(result).join(', '));
  });
});

// ─── a PR is judged against its base, not its last commit (the Fifty, move 30) ──

describe('fakeFixDetector — diff base on a multi-commit pull request', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');

  function repo(skipSubject = 'fix: skip the failing test') {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ffd-'));
    const git = (...a) => execFileSync('git', a, { cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const commit = (file, content, msg) => {
      fs.mkdirSync(path.dirname(path.join(tmp, file)), { recursive: true });
      fs.writeFileSync(path.join(tmp, file), content);
      git('add', file); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', msg);
    };
    git('init', '-q', '-b', 'main');
    commit('tests/add.test.js', "test('adds negatives', () => { assert.equal(add(-1, -2), -3); });\n", 'base');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('checkout', '-q', '-b', 'fix/negatives');
    commit('tests/add.test.js', "test.skip('adds negatives', () => { assert.equal(add(-1, -2), -3); });\n", skipSubject);
    commit('src/add.js', 'module.exports = { add: (a, b) => a + b };\n', 'fix: tidy');   // the LAST commit is innocent
    return tmp;
  }

  async function run(tmp, runnerOptions, env = {}) {
    const saved = process.env.GITHUB_BASE_REF;
    if ('GITHUB_BASE_REF' in env) process.env.GITHUB_BASE_REF = env.GITHUB_BASE_REF; else delete process.env.GITHUB_BASE_REF;
    try {
      const config = new GateTestConfig(tmp);
      config._runnerOptions = runnerOptions;
      const result = new TestResult('fakeFixDetector');
      await new FakeFixDetector().run(result, config);
      const names = result.checks.map((c) => c.name);
      names.failed = failedCheckNames(result);
      names.skip = result.checks.find((c) => !c.passed && c.name.includes('test-skip-added')) || null;
      return names;
    } finally {
      if (saved === undefined) delete process.env.GITHUB_BASE_REF; else process.env.GITHUB_BASE_REF = saved;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  const skipped = (names) => names.failed.some((n) => n.includes('test-skip-added'));

  it('POSITIVE: with --pr / --since (incrementalSince) the .skip from the first commit is found', async () => {
    assert.equal(skipped(await run(repo(), { incrementalSince: 'origin/main' })), true);
  });

  it('POSITIVE: on GitHub Actions GITHUB_BASE_REF names the base', async () => {
    assert.equal(skipped(await run(repo(), {}, { GITHUB_BASE_REF: 'main' })), true);
  });

  it('with no --pr at all, origin/main still decides (src/core/diff-base.js) — the .skip is found', async () => {
    assert.equal(skipped(await run(repo(), {})), true);
  });

  it('CONTROL: with NO base anywhere the module can only read the last commit — the hole the resolver closes', async () => {
    const tmp = repo();
    const git = (...a) => execFileSync('git', a, { cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    git('update-ref', '-d', 'refs/remotes/origin/main');
    git('branch', '-D', 'main');
    assert.equal(skipped(await run(tmp, {})), false);
  });

  it('CONTROL: an unfetched base ref falls through to origin/main instead of reporting nothing', async () => {
    const names = await run(repo(), { incrementalSince: 'origin/no-such-branch' });
    assert.ok(names.includes('fake-fix:scanning'), names.join(', '));
    assert.ok(!names.includes('fake-fix:no-diff'), names.join(', '));
    assert.equal(skipped(names), true);
  });
});

describe('fakeFixDetector — a skipped test blocks only when the commit calls itself a fix (the Fifty, move 30)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');

  function repo(skipSubject, { commitSkip = true } = {}) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ffd2-'));
    const git = (...a) => execFileSync('git', a, { cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const write = (file, content) => { fs.mkdirSync(path.dirname(path.join(tmp, file)), { recursive: true }); fs.writeFileSync(path.join(tmp, file), content); };
    const commit = (file, content, msg) => { write(file, content); git('add', file); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', msg); };
    git('init', '-q', '-b', 'main');
    commit('tests/add.test.js', "test('adds negatives', () => { assert.equal(add(-1, -2), -3); });\n", 'base');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('checkout', '-q', '-b', 'topic');
    const skipped = "test.skip('adds negatives', () => { assert.equal(add(-1, -2), -3); });\n";
    if (commitSkip) commit('tests/add.test.js', skipped, skipSubject); else write('tests/add.test.js', skipped);
    return tmp;
  }
  async function run(tmp, runnerOptions) {
    try {
      const config = new GateTestConfig(tmp);
      config._runnerOptions = runnerOptions;
      const result = new TestResult('fakeFixDetector');
      await new FakeFixDetector().run(result, config);
      return result.checks.find((c) => !c.passed && c.name.includes('test-skip-added')) || null;
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  it('POSITIVE: "fix: negatives test" that skips the test is an ERROR and names the commit', async () => {
    const hit = await run(repo('fix: negatives test'), { incrementalSince: 'origin/main' });
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
    assert.match(hit.explanation, /Added by "fix: negatives test"/);
  });

  for (const subject of ['Skip a test for now', 'test: migrate to vitest', 'Tweaks']) {
    it(`NEGATIVE: "${subject}" (got, nest, got — real history) is reported as a WARNING, not blocked`, async () => {
      const hit = await run(repo(subject), { incrementalSince: 'origin/main' });
      assert.ok(hit, 'still reported');
      assert.strictEqual(hit.severity, 'warning');
      assert.match(hit.explanation, /no commit touching this file in the range calls itself a fix/);
    });
  }

  it('NEGATIVE: an uncommitted .skip is a warning — there is no commit to judge yet', async () => {
    const hit = await run(repo('unused', { commitSkip: false }), {});
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
    assert.match(hit.explanation, /Not yet committed/);
  });

  it('CONTROL: "resolved flaky kafka test" and "hotfix" count as fix-shaped', async () => {
    for (const subject of ['Resolved the flaky kafka test', 'hotfix: skip until the broker is back']) {
      const hit = await run(repo(subject), { incrementalSince: 'origin/main' });
      assert.strictEqual(hit && hit.severity, 'error', subject);
    }
  });

  it('CONTROL: an injected diff keeps the declared severity — no git to ask', async () => {
    const result = new TestResult('fakeFixDetector');
    await new FakeFixDetector().run(result, makeConfig('diff --git a/tests/a.test.js b/tests/a.test.js\n--- a/tests/a.test.js\n+++ b/tests/a.test.js\n@@ -1,1 +1,1 @@\n-test(\'x\', () => {});\n+test.skip(\'x\', () => {});\n'));
    const hit = findFailure(result, 'test-skip-added');
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });
});

// ─── the gate policy is reviewed as policy (the Fifty, move 26) ─────────────

describe('fakeFixDetector — a PR that changes the gate policy says so', () => {
  const hunk = (file, added) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,1 +1,${1 + added.length} @@\n line\n${added.map((l) => `+${l}`).join('\n')}\n`;
  const runOn = async (diff) => { const result = new TestResult('fakeFixDetector'); await new FakeFixDetector().run(result, makeConfig(diff)); return result; };

  it('POSITIVE: a suppression line added to .gatetestignore is a warning, once per line', async () => {
    const result = await runOn(hunk('.gatetestignore', ['# why: fixtures', 'secrets@tests/fixtures/**', 'hardcodedUrl:localhost']));
    const hits = result.checks.filter((c) => !c.passed && c.name.includes('policy-ignore-line-added'));
    assert.strictEqual(hits.length, 2, failedCheckNames(result).join(', '));
    assert.strictEqual(hits[0].severity, 'warning');
  });

  it('NEGATIVE: a comment or blank line in .gatetestignore is not a policy change', async () => {
    const result = await runOn(hunk('.gatetestignore', ['# reliability-corpus is the known-bad corpus', '']));
    assert.ok(!findFailure(result, 'policy-ignore-line-added'), failedCheckNames(result).join(', '));
  });

  it('POSITIVE: report-only, a disabled module, a raised threshold or strict:false in .gatetest.json', async () => {
    for (const line of ['  "reportOnly": true,', '    "enabled": false', '  "confidenceThreshold": 0.9,', '  "strict": false']) {
      const result = await runOn(hunk('.gatetest.json', [line]));
      assert.ok(findFailure(result, 'policy-gate-softened'), `expected on ${line}: ${failedCheckNames(result).join(', ')}`);
    }
  });

  it('NEGATIVE: tightening the gate, or an ordinary key, is not flagged', async () => {
    for (const line of ['  "confidenceThreshold": 0.6,', '    "enabled": true', '  "owner": "crclabs-hq",', '  "reportOnly": false,']) {
      const result = await runOn(hunk('.gatetest.json', [line]));
      assert.ok(!findFailure(result, 'policy-gate-softened'), `unexpected on ${line}: ${failedCheckNames(result).join(', ')}`);
    }
  });

  it('CONTROL: a policy file never trips a CODE rule, and a code file never trips a policy rule', async () => {
    const a = await runOn(hunk('.gatetestignore', ['moneyFloat:cents-display@src/**   # return true']));
    assert.ok(!a.checks.some((c) => !c.passed && !c.name.includes('policy-')), failedCheckNames(a).join(', '));
    const b = await runOn(hunk('src/config.js', ['  "reportOnly": true,']));
    assert.ok(!findFailure(b, 'policy-gate-softened'), failedCheckNames(b).join(', '));
  });
});

describe('fakeFixDetector — the policy finding survives --pr scoping', () => {
  it('.gatetestignore counts as a changed source file in incremental mode', () => {
    const { GateTestConfig } = require('../src/core/config');
    const exts = new GateTestConfig(require('node:os').tmpdir()).get('incremental.sourceExtensions');
    assert.ok(exts.includes('.gatetestignore'), 'a suppression-only PR must not read as "nothing changed"');
    assert.ok(exts.includes('.json'), '.gatetest.json is matched by extension');
  });
});

describe('fakeFixDetector — a threshold in a TEST file is fixture data (PR #433 bot finding)', () => {
  const hunk = (file, line) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,1 +1,2 @@\n line\n+${line}\n`;
  it('NEGATIVE: confidenceThreshold: 0.7 inside tests/x.test.js is not a policy change', async () => {
    const result = new TestResult('fakeFixDetector');
    await new FakeFixDetector().run(result, makeConfig(hunk('tests/compliance-evidence.test.js', '  confidenceThreshold: 0.7,')));
    assert.ok(!findFailure(result, 'threshold-lowered'), failedCheckNames(result).join(', '));
  });
  it('POSITIVE: the same line in jest.config.js still fires', async () => {
    const result = new TestResult('fakeFixDetector');
    await new FakeFixDetector().run(result, makeConfig(hunk('jest.config.js', '  coverageThreshold: 50,')));
    assert.ok(findFailure(result, 'threshold-lowered'));
  });
});

// Self-scan of PR #488 (2026-09-14): three "Empty catch block added" findings
// on tests/error-swallow-in-body-marker.test.js — the fixture STRINGS of the
// errorSwallow control pair, which necessarily contain `catch {}`. A test
// file that adds that shape is a fixture or the test's own handling, never a
// symptom patch on the code being fixed; src/ is where the rule earns its keep.
describe('FakeFixDetector — catch shapes added under a test tree are fixtures', () => {
  const hunk = (file) => [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1,3 +1,4 @@',
    ' const x = 1;',
    "+  '  try { doIt(); } catch {}',",
    '+  try { run(); } catch (err) { /* noted */ }',
    ' module.exports = x;',
  ].join('\n');

  it('stays quiet under tests/ (fixture strings and test-side handling)', async () => {
    const mod = new FakeFixDetector();
    const result = new TestResult('fakeFixDetector');
    result.start();
    await mod.run(result, makeConfig(hunk('tests/error-swallow-in-body-marker.test.js')));
    assert.ok(!findFailure(result, 'empty-catch'), 'empty-catch must not fire on a test file');
    assert.ok(!findFailure(result, 'catch-noop'), 'catch-noop must not fire on a test file');
  });

  it('POSITIVE: the same lines under src/ still fire', async () => {
    const mod = new FakeFixDetector();
    const result = new TestResult('fakeFixDetector');
    result.start();
    await mod.run(result, makeConfig(hunk('src/core/thing.js')));
    assert.ok(findFailure(result, 'empty-catch'), 'empty-catch must fire on product code');
    assert.ok(findFailure(result, 'catch-noop'), 'catch-noop must fire on product code');
  });
});
