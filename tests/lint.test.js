const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const LintModule = require('../src/modules/lint');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) { this.checks.push({ name, passed, ...details }); },
  };
}

describe('LintModule — baseline shape', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-lint-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('exposes the expected BaseModule shape', () => {
    const mod = new LintModule();
    assert.strictEqual(typeof mod.name, 'string');
    assert.ok(mod.name.length > 0);
    assert.strictEqual(typeof mod.description, 'string');
    assert.ok(mod.description.length > 0);
    assert.strictEqual(typeof mod.run, 'function');
  });

  it('runs without throwing on an empty project root', async () => {
    const mod = new LintModule();
    const result = makeResult();
    await assert.doesNotReject(mod.run(result, { projectRoot: tmp }));
  });
});

describe('LintModule — markdown findings are INFO (not error/warning noise)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-lint-md-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('flags markdown whitespace at info severity, not error', async () => {
    // Trailing whitespace + triple blank lines → a markdown finding.
    fs.writeFileSync(path.join(tmp, 'README.md'), '# Title   \n\n\n\nsome text\n');
    const mod = new LintModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp });
    const md = result.checks.find((c) => c.name.startsWith('lint:markdown:') && c.passed === false);
    assert.ok(md, 'expected a markdown finding');
    assert.strictEqual(md.severity, 'info', 'markdown nits must be info, never error/warning');
  });

  it('KI #48: does NOT flag CRLF line endings as trailing whitespace (same bug fixed in env-integrity)', async () => {
    fs.writeFileSync(path.join(tmp, 'README.md'), '# Title\r\n\r\nsome text\r\nmore text\r\n');
    const mod = new LintModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp });
    const md = result.checks.find((c) => c.name.startsWith('lint:markdown:') && c.passed === false);
    assert.strictEqual(md, undefined, `CRLF alone should not produce a markdown finding, got: ${JSON.stringify(md)}`);
  });
});

// GT-14a (issue #771): a full scan of the AlecRae monorepo counted lint
// errors inside a GITIGNORED build directory — `_runEslint` handed ESLint
// the bare `.` directory instead of the same in-scope file set `_collectFiles`
// already honours (issue #767 / #776's `getScanIgnoreMatcher`). Fixture root
// is placed INSIDE this repo (not os.tmpdir()) so `_resolveEslintBin`'s
// `../node_modules/.bin/eslint` fallback finds this repo's real ESLint.
describe('LintModule — ESLint does not count gitignored / build-output directories (#771 GT-14a)', () => {
  let tmp;
  const ESLINT_CONFIG = "module.exports = [\n  { languageOptions: { ecmaVersion: 2022, sourceType: 'script' }, rules: { 'no-unused-vars': 'error' } },\n];\n";

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(__dirname, '..', '.gt-lint-fixture-'));
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('NEGATIVE: dist/bundle.js is gitignored and full of lint errors, src/ is clean — ESLint stays quiet', async () => {
    fs.writeFileSync(path.join(tmp, 'eslint.config.js'), ESLINT_CONFIG);
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'dist/\n');
    fs.mkdirSync(path.join(tmp, 'dist'));
    fs.writeFileSync(path.join(tmp, 'dist', 'bundle.js'), 'var unused = 1;\nvar alsoUnused = 2;\n');
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'clean.js'), 'module.exports = {};\n');

    const mod = new LintModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp });
    const eslint = result.checks.find((c) => c.name === 'lint:eslint');
    assert.ok(eslint, `expected a lint:eslint check, got: ${JSON.stringify(result.checks.map((c) => c.name))}`);
    assert.strictEqual(eslint.passed, true, JSON.stringify(eslint));
  });

  it('POSITIVE: the same bad file moved into src/ (not gitignored) fires', async () => {
    fs.writeFileSync(path.join(tmp, 'eslint.config.js'), ESLINT_CONFIG);
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'dist/\n');
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'bundle.js'), 'var unused = 1;\nvar alsoUnused = 2;\n');

    const mod = new LintModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp });
    const eslint = result.checks.find((c) => c.name === 'lint:eslint');
    assert.ok(eslint, `expected a lint:eslint check, got: ${JSON.stringify(result.checks.map((c) => c.name))}`);
    assert.strictEqual(eslint.passed, false, JSON.stringify(eslint));
  });
});
