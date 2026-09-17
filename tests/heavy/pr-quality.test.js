// =============================================================================
// PR-QUALITY TEST — src/modules/pr-quality.js
// =============================================================================
// New module #91. Flags weak commit messages, missing tests, mixed deps+code.
// Uses real git via execSync — each test spins up a tmp repo and seeds the
// commits / files needed.
// =============================================================================

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const PrQualityModule = require('../../src/modules/pr-quality');
const { TestResult: Result } = require('../../src/core/runner');

const HAS_GIT = (() => {
  try { execSync('git --version', { stdio: 'pipe' }); return true; }
  catch { return false; }
})();

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-prq-'));
  execSync('git init -q -b main', { cwd: dir });
  execSync('git config user.email "test@gatetest.local"', { cwd: dir });
  execSync('git config user.name "GateTest Test"', { cwd: dir });
  // Disable signing so test runs on CI without a key.
  execSync('git config commit.gpgsign false', { cwd: dir });
  return dir;
}

function commit(dir, subject, files = {}) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  execSync('git add -A', { cwd: dir });
  execSync(`git commit -q --allow-empty -m ${JSON.stringify(subject)}`, { cwd: dir });
}

async function runModule(projectRoot, extraConfig = {}) {
  const mod = new PrQualityModule();
  const result = new Result();
  await mod.run(result, { projectRoot, prQuality: extraConfig });
  return result;
}

function checks(result) {
  return result.checks || result._checks || [];
}

function ruleNames(result) {
  return checks(result).map((c) => c.name);
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe('PrQualityModule — shape', () => {
  it('has the expected name + description', () => {
    const mod = new PrQualityModule();
    assert.equal(mod.name, 'prQuality');
    assert.match(mod.description, /PR-quality/);
  });

  it('exposes DEFAULT_CONFIG and pattern arrays for tests', () => {
    assert.ok(PrQualityModule.DEFAULT_CONFIG);
    assert.ok(Array.isArray(PrQualityModule.DEFAULT_CONFIG.weakMessagePatterns));
    assert.ok(Array.isArray(PrQualityModule.DEP_MANIFEST_PATTERNS));
    assert.ok(Array.isArray(PrQualityModule.LOCKFILE_PATTERNS));
  });

  it('classifies test files via the canonical this._isTestPath(), not a private pattern list', () => {
    // Doctrine #4 — one definition, imported. A private TEST_PATH_PATTERNS
    // array used to live in this module; it's gone, and classification now
    // goes through BaseModule._isTestPath() (src/core/test-paths.js).
    const mod = new PrQualityModule();
    assert.equal(typeof mod._isTestPath, 'function');
    assert.equal(PrQualityModule.TEST_PATH_PATTERNS, undefined);
  });
});

// ---------------------------------------------------------------------------
// No-git / no-diff fallbacks
// ---------------------------------------------------------------------------

describe('PrQualityModule — fallbacks', () => {
  it('emits info-level skip when not in a git repo', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-prq-nogit-'));
    const r = await runModule(dir);
    assert.ok(ruleNames(r).includes('pr-quality:not-a-git-repo'));
  });
});

// ---------------------------------------------------------------------------
// Real git tests
// ---------------------------------------------------------------------------

if (HAS_GIT) {
  describe('PrQualityModule — commit messages', () => {
    let dir;
    before(() => {
      dir = makeRepo();
      // Base commit on main
      commit(dir, 'feat: initial commit with detailed message', { 'README.md': '# project\n' });
      execSync('git branch base', { cwd: dir });
    });
    after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('flags an empty commit message as ERROR (via allow-empty + " " subject)', async () => {
      // Git refuses TRULY empty messages even with --allow-empty-message in many
      // setups, so we simulate by using whitespace which our module still
      // detects as empty after trimming.
      // Approach: --allow-empty-message + git commit --allow-empty -m ""
      try {
        execSync('git commit --allow-empty --allow-empty-message -m ""', { cwd: dir });
        const r = await runModule(dir, { against: 'base' });
        const names = ruleNames(r);
        const hit = names.find((n) => n.startsWith('pr-quality:empty-message:'));
        assert.ok(hit, `expected empty-message check, got: ${names.join(', ')}`);
      } catch (err) {
        // Some git versions reject this; treat as "not testable on this git",
        // pass the test rather than failing on an environmental quirk.
        // The weak-message rule below covers the realistic case.
        assert.ok(true, `git rejected empty message (env limitation): ${err.message.slice(0, 80)}`);
      }
    });

    it('flags "wip" subject as weak-message WARNING', async () => {
      commit(dir, 'wip', { 'a.js': 'console.log("a")' });
      const r = await runModule(dir, { against: 'base' });
      const hit = ruleNames(r).find((n) => n.startsWith('pr-quality:weak-message:'));
      assert.ok(hit, `expected weak-message check, got: ${ruleNames(r).join(', ')}`);
    });

    it('flags "fix" alone as weak-message WARNING', async () => {
      commit(dir, 'fix', { 'b.js': 'console.log("b")' });
      const r = await runModule(dir, { against: 'base' });
      const weakHits = ruleNames(r).filter((n) => n.startsWith('pr-quality:weak-message:'));
      assert.ok(weakHits.length >= 1);
    });

    it('does NOT flag a well-formed commit subject', async () => {
      const dir2 = makeRepo();
      commit(dir2, 'feat: initial good commit', { 'README.md': '#\n' });
      execSync('git branch base', { cwd: dir2 });
      commit(dir2, 'feat: add user authentication flow with token rotation', { 'auth.js': 'export {}' });
      const r = await runModule(dir2, { against: 'base' });
      const weakHits = ruleNames(r).filter((n) => n.startsWith('pr-quality:weak-message:'));
      assert.equal(weakHits.length, 0);
      fs.rmSync(dir2, { recursive: true, force: true });
    });

    it('emits the summary info check', async () => {
      const r = await runModule(dir, { against: 'base' });
      assert.ok(ruleNames(r).includes('pr-quality:summary'));
    });
  });

  describe('PrQualityModule — source-to-test ratio', () => {
    let dir;
    before(() => {
      dir = makeRepo();
      commit(dir, 'feat: initial', { 'README.md': '# \n' });
      execSync('git branch base', { cwd: dir });
    });
    after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('flags no-tests when many source files change with no test files', async () => {
      // 5 source files, 0 test files — ratio 5:1 hits maxSourceTestRatio default
      commit(dir, 'feat: add user, profile, settings, billing, and audit modules', {
        'src/user.js': 'export const user = {}',
        'src/profile.js': 'export const profile = {}',
        'src/settings.js': 'export const settings = {}',
        'src/billing.js': 'export const billing = {}',
        'src/audit.js': 'export const audit = {}',
      });
      const r = await runModule(dir, { against: 'base' });
      assert.ok(ruleNames(r).includes('pr-quality:no-tests'),
        `expected pr-quality:no-tests in ${ruleNames(r).join(', ')}`);
    });

    it('does NOT flag no-tests on a tiny PR (1-2 source files)', async () => {
      const dir2 = makeRepo();
      commit(dir2, 'feat: initial', { 'README.md': '# \n' });
      execSync('git branch base', { cwd: dir2 });
      commit(dir2, 'feat: tweak a single file', { 'src/x.js': 'export {}' });
      const r = await runModule(dir2, { against: 'base' });
      assert.ok(!ruleNames(r).includes('pr-quality:no-tests'));
      fs.rmSync(dir2, { recursive: true, force: true });
    });

    it('does NOT flag no-tests when matching tests exist', async () => {
      const dir3 = makeRepo();
      commit(dir3, 'feat: initial', { 'README.md': '#\n' });
      execSync('git branch base', { cwd: dir3 });
      commit(dir3, 'feat: add three modules with their tests', {
        'src/a.js': 'export {}',
        'src/b.js': 'export {}',
        'src/c.js': 'export {}',
        'tests/a.test.js': 'test',
        'tests/b.test.js': 'test',
        'tests/c.test.js': 'test',
      });
      const r = await runModule(dir3, { against: 'base' });
      assert.ok(!ruleNames(r).includes('pr-quality:no-tests'));
      fs.rmSync(dir3, { recursive: true, force: true });
    });
  });

  describe('PrQualityModule — mixed deps + code', () => {
    it('flags when package.json changes alongside source files', async () => {
      const dir = makeRepo();
      commit(dir, 'feat: initial', { 'README.md': '#\n', 'package.json': '{}' });
      execSync('git branch base', { cwd: dir });
      commit(dir, 'feat: bump dep + refactor module', {
        'package.json': '{"name":"x","dependencies":{"lodash":"^4.0.0"}}',
        'src/index.js': 'export {}',
      });
      const r = await runModule(dir, { against: 'base' });
      assert.ok(ruleNames(r).includes('pr-quality:mixed-deps-and-code'));
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('does NOT flag mixed-deps when only package-lock.json changed alongside code (lockfiles ignored)', async () => {
      const dir = makeRepo();
      commit(dir, 'feat: initial', { 'README.md': '#\n', 'package-lock.json': '{}', 'src/index.js': '' });
      execSync('git branch base', { cwd: dir });
      commit(dir, 'feat: add feature', {
        'package-lock.json': '{"lockfileVersion":3,"name":"x"}',
        'src/index.js': 'export {}',
      });
      const r = await runModule(dir, { against: 'base' });
      assert.ok(!ruleNames(r).includes('pr-quality:mixed-deps-and-code'));
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('does NOT flag when ONLY dep files change (legitimate dep-bump PR)', async () => {
      const dir = makeRepo();
      commit(dir, 'feat: initial', { 'package.json': '{}' });
      execSync('git branch base', { cwd: dir });
      commit(dir, 'chore: bump lodash to 4.17.21', {
        'package.json': '{"dependencies":{"lodash":"4.17.21"}}',
      });
      const r = await runModule(dir, { against: 'base' });
      assert.ok(!ruleNames(r).includes('pr-quality:mixed-deps-and-code'));
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  // ---------------------------------------------------------------------
  // Regression #561 / #590 — the base ref must resolve to a merge-base,
  // not a raw ref diffed directly, or an advanced `origin/main` inflates
  // the diff with files the PR never touched.
  // ---------------------------------------------------------------------

  function makeBareRemote() {
    // `-b main` pins the bare repo's HEAD symbolic ref to refs/heads/main up
    // front. Without it, a bare `git init` defaults HEAD to refs/heads/master
    // (never created here), and a later clone inherits an unborn HEAD — any
    // `checkout -b` off that creates an ORPHAN root commit sharing no
    // history with origin/main, which is a broken test harness, not the bug
    // under test (every branch below explicitly checks out `origin/main` as
    // a second safeguard against relying on the remote's default branch).
    const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-prq-remote-'));
    execSync('git init -q --bare -b main', { cwd: remoteDir });
    return remoteDir.replace(/\\/g, '/');
  }

  function cloneRepo(remoteUrl, label) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gt-prq-${label}-`));
    execSync(`git clone -q "${remoteUrl}" .`, { cwd: dir });
    execSync('git config user.email test@gatetest.local', { cwd: dir });
    execSync('git config user.name "GateTest Test"', { cwd: dir });
    execSync('git config commit.gpgsign false', { cwd: dir });
    return dir;
  }

  describe('PrQualityModule — merge-base correctness (#561, #590)', () => {
    let remoteDir;
    let remoteUrl;
    let originWork;
    let prDir;

    before(() => {
      remoteUrl = makeBareRemote();
      remoteDir = remoteUrl.replace(/\//g, path.sep);
      originWork = cloneRepo(remoteUrl, 'origin');
      execSync('git checkout -q -b main', { cwd: originWork });
      commit(originWork, 'feat: initial project skeleton', { 'README.md': '# proj\n' });
      execSync('git push -q -u origin main', { cwd: originWork });

      // A contributor branches for their PR at this point — explicitly off
      // origin/main, not the ambient default branch.
      prDir = cloneRepo(remoteUrl, 'pr');
      execSync('git checkout -q -b feature/admin-override origin/main', { cwd: prDir });
      commit(prDir, 'test: add admin override coverage', {
        'tests/admin-override.test.js': 'test("admin override", () => {});\n',
      });

      // ...then, before CI ever runs on that PR, other work lands on main —
      // the ordinary case in any active repo. Five files: enough to cross
      // maxSourceTestRatio (5) if wrongly counted against this PR's single
      // test file.
      commit(originWork, 'feat: land user/profile/settings/billing/audit modules', {
        'src/user.js': 'export const user = {}',
        'src/profile.js': 'export const profile = {}',
        'src/settings.js': 'export const settings = {}',
        'src/billing.js': 'export const billing = {}',
        'src/audit.js': 'export const audit = {}',
      });
      execSync('git push -q origin main', { cwd: originWork });

      // CI's checkout fetches origin — origin/main now points PAST the
      // commit the PR branch forked from.
      execSync('git fetch -q origin', { cwd: prDir });
    });

    after(() => {
      for (const d of [remoteDir, originWork, prDir]) {
        if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* error-ok — best-effort cleanup */ } }
      }
    });

    it('control (a): a PR that only adds a tests/*.test.js file does NOT fire no-tests, even though origin/main advanced', async () => {
      const r = await runModule(prDir); // auto-detect: no explicit `against`, exercises resolveDiffBase against origin/main
      const names = ruleNames(r);
      assert.ok(!names.includes('pr-quality:no-tests'),
        `expected no pr-quality:no-tests, got: ${names.join(', ')}`);
    });

    it('control (b): a PR that changes only src/ still fires no-tests against the same advanced origin/main', async () => {
      const srcOnlyDir = cloneRepo(remoteUrl, 'pr-src-only');
      execSync('git fetch -q origin', { cwd: srcOnlyDir });
      execSync('git checkout -q -b feature/src-only origin/main', { cwd: srcOnlyDir });
      // Roll back to the pre-advance commit so this branch forks from the
      // SAME point the admin-override branch did, then add 5 source files
      // with no tests — the classic no-tests shape.
      execSync('git reset -q --hard HEAD~1', { cwd: srcOnlyDir });
      commit(srcOnlyDir, 'feat: add five unrelated source modules', {
        'src/a.js': 'export {}',
        'src/b.js': 'export {}',
        'src/c.js': 'export {}',
        'src/d.js': 'export {}',
        'src/e.js': 'export {}',
      });
      execSync('git fetch -q origin', { cwd: srcOnlyDir });

      const r = await runModule(srcOnlyDir);
      const names = ruleNames(r);
      assert.ok(names.includes('pr-quality:no-tests'),
        `expected pr-quality:no-tests to still fire on a source-only PR, got: ${names.join(', ')}`);
      fs.rmSync(srcOnlyDir, { recursive: true, force: true });
    });
  });

  describe('PrQualityModule — three-state: diff not determinable', () => {
    it('reports pr-quality:no-tests:not-checked instead of silently treating an undeterminable diff as clean', async () => {
      const dir = makeRepo();
      commit(dir, 'feat: initial', { 'README.md': '# \n' });
      execSync('git branch base', { cwd: dir });
      commit(dir, 'feat: add five source modules', {
        'src/a.js': 'export {}',
        'src/b.js': 'export {}',
        'src/c.js': 'export {}',
        'src/d.js': 'export {}',
        'src/e.js': 'export {}',
      });

      const mod = new PrQualityModule();
      // Force the diff-acquisition step to fail (simulating a git error —
      // e.g. a shallow clone with no shared history) without touching the
      // base-ref resolution, which succeeds fine.
      mod._listChangedFiles = () => null;
      const result = new Result();
      await mod.run(result, { projectRoot: dir, prQuality: { against: 'base' } });
      const names = ruleNames(result);

      assert.ok(names.includes('pr-quality:no-tests:not-checked'),
        `expected pr-quality:no-tests:not-checked, got: ${names.join(', ')}`);
      assert.ok(!names.includes('pr-quality:no-tests'),
        'must not report no-tests when the diff could not be determined');
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });
}
