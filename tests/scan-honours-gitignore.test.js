// =============================================================================
// SCAN HONOURS GITIGNORE — issue #767
// =============================================================================
// Control pair for the AlecRae monorepo defect: a full scan put 300 of 600
// blocking findings inside gitignored build output (`apps/web/.next-build`,
// `.design`) because nothing in the default file-collection path
// (BaseModule._collectFiles) ever consulted the repo's .gitignore.
//
// Fixture repo (real `git init`, so "tracked" vs "untracked" means something):
//   .gitignore              — ".next-build/", "keep.js" then "!keep.js"
//   apps/web/.gitignore     — ".design/"           (nested — own scope only)
//   apps/web/.next-build/chunk.js   — gitignored (root pattern)
//   apps/web/.design/tokens.js      — gitignored (nested pattern)
//   src/config.js           — TRACKED, not ignored
//   src/new.js              — UNTRACKED, not ignored (a pre-commit target)
//   keep.js                 — matched-then-negated — must still be scanned
//
// Every planted file carries the published AWS-docs example key
// (AKIAIOSFODNN7EXAMPLE) — the same fixture value tests/secrets.test.js uses
// for "a real hardcoded-shaped key still fires despite the word 'example'".
// =============================================================================

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const SecretsModule = require('../src/modules/secrets');
const { GateTestRunner } = require('../src/core/runner');
const { setIncludeIgnored, clearScanIgnoreMatcherCache } = require('../src/core/gitignore');

const SECRET = 'AKIAIOSFODNN7EXAMPLE';

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, meta = {}) {
      this.checks.push({ name, passed, ...meta });
    },
  };
}

function write(root, rel, body) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}

let REPO;

before(() => {
  REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-scan-gitignore-'));
  const run = (cmd) => execSync(cmd, {
    cwd: REPO,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  run('git init -q');
  run('git config user.email "test@example.com"');
  run('git config user.name  "Test"');
  run('git config commit.gpgsign false');
  run('git config tag.gpgsign false');

  write(REPO, '.gitignore', [
    '.next-build/',
    'keep.js',
    '!keep.js',
  ].join('\n'));
  write(REPO, 'apps/web/.gitignore', ['.design/'].join('\n'));

  write(REPO, 'apps/web/.next-build/chunk.js', `const AWS_KEY = "${SECRET}";\n`);
  write(REPO, 'apps/web/.design/tokens.js', `const AWS_KEY = "${SECRET}";\n`);
  write(REPO, 'src/config.js', `const AWS_KEY = "${SECRET}";\n`);
  write(REPO, 'keep.js', `const AWS_KEY = "${SECRET}";\n`);

  // Tracked: everything committed EXCEPT src/new.js. The two build-output
  // files are deliberately force-added — a CI's own checkout tracks its
  // gitignored build output plenty of the time (a customer's dist/ can be
  // committed even though it is gitignored elsewhere), and the scanner must
  // key off .gitignore matching, never off git's tracked/untracked state.
  run('git add .gitignore apps/web/.gitignore src/config.js keep.js');
  run('git add -f apps/web/.next-build/chunk.js apps/web/.design/tokens.js');
  run('git commit -q -m "fixture"');

  // Untracked-but-not-ignored — exactly what a pre-commit scan exists for.
  write(REPO, 'src/new.js', `const AWS_KEY = "${SECRET}";\n`);
});

after(() => {
  fs.rmSync(REPO, { recursive: true, force: true });
  clearScanIgnoreMatcherCache();
});

async function scanSecretFiles() {
  const mod = new SecretsModule();
  const result = makeResult();
  await mod.run(result, { projectRoot: REPO, get: () => undefined });
  return result.checks
    .filter((c) => !c.passed && c.file)
    .map((c) => c.file.replace(/\\/g, '/'));
}

describe('BaseModule._collectFiles honours .gitignore by default (issue #767)', () => {
  it('default scan finds tracked + untracked + negated files, none under gitignored paths', async () => {
    setIncludeIgnored(false);
    clearScanIgnoreMatcherCache();
    const files = await scanSecretFiles();

    assert.ok(files.includes('src/config.js'), 'tracked file must still be scanned');
    assert.ok(files.includes('src/new.js'), 'untracked-but-not-ignored file must still be scanned');
    assert.ok(files.includes('keep.js'), 'a matched-then-negated (!keep.js) file must still be scanned');

    assert.ok(!files.includes('apps/web/.next-build/chunk.js'), 'root-gitignored build output must be skipped');
    assert.ok(!files.includes('apps/web/.design/tokens.js'), 'nested-gitignored path must be skipped');
  });

  it('--include-ignored finds all four planted secrets', async () => {
    setIncludeIgnored(true);
    clearScanIgnoreMatcherCache();
    try {
      const files = await scanSecretFiles();
      assert.ok(files.includes('src/config.js'));
      assert.ok(files.includes('src/new.js'));
      assert.ok(files.includes('keep.js'));
      assert.ok(files.includes('apps/web/.next-build/chunk.js'), '--include-ignored must scan gitignored build output');
      assert.ok(files.includes('apps/web/.design/tokens.js'), '--include-ignored must scan nested-gitignored paths');
    } finally {
      setIncludeIgnored(false);
      clearScanIgnoreMatcherCache();
    }
  });
});

describe('GateTestRunner summary — issue #767 not-checked line', () => {
  it('reports how many gitignored paths were skipped, by default', async () => {
    setIncludeIgnored(false);
    clearScanIgnoreMatcherCache();
    const runner = new GateTestRunner({ projectRoot: REPO, get: () => undefined, getSuite: () => ['secrets'] }, {});
    runner.register('secrets', new SecretsModule());
    const summary = await runner.runSuite ? await runner.runSuite('quick') : await runner.run(['secrets']);
    assert.ok(summary.gitignoreSkip, 'summary must carry a gitignoreSkip field when paths were skipped');
    assert.ok(summary.gitignoreSkip.count >= 2, `expected at least 2 skipped files, got ${JSON.stringify(summary.gitignoreSkip)}`);
  });

  it('reports null when --include-ignored is set', async () => {
    setIncludeIgnored(true);
    clearScanIgnoreMatcherCache();
    try {
      const runner = new GateTestRunner({ projectRoot: REPO, get: () => undefined, getSuite: () => ['secrets'] }, {});
      runner.register('secrets', new SecretsModule());
      const summary = runner.runSuite ? await runner.runSuite('quick') : await runner.run(['secrets']);
      assert.strictEqual(summary.gitignoreSkip, null);
    } finally {
      setIncludeIgnored(false);
      clearScanIgnoreMatcherCache();
    }
  });
});
