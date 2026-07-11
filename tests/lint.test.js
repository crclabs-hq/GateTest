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
});
