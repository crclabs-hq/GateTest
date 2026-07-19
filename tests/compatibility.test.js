const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CompatibilityModule = require('../src/modules/compatibility');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) { this.checks.push({ name, passed, ...details }); },
  };
}

describe('CompatibilityModule — baseline shape', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-compat-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('exposes the expected BaseModule shape', () => {
    const mod = new CompatibilityModule();
    assert.strictEqual(typeof mod.name, 'string');
    assert.ok(mod.name.length > 0);
    assert.strictEqual(typeof mod.description, 'string');
    assert.ok(mod.description.length > 0);
    assert.strictEqual(typeof mod.run, 'function');
  });

  it('runs without throwing on an empty project root', async () => {
    const mod = new CompatibilityModule();
    const result = makeResult();
    await assert.doesNotReject(mod.run(result, { projectRoot: tmp }));
  });
});

describe('CompatibilityModule — RegExp v flag (KI #50)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-compat-vflag-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('does NOT flag an ordinary import path (/lib/validators — 202 of 237 self-scan findings were this bug)', async () => {
    fs.writeFileSync(path.join(tmp, 'index.js'), `import { check } from "./lib/validators";\nconst x = 1;\n`);
    const mod = new CompatibilityModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp });
    assert.ok(
      !result.checks.some((c) => c.name.includes('RegExp v flag')),
      'a plain import path must not be flagged as a RegExp v-flag usage'
    );
  });

  it('does NOT flag other v-word-after-slash paths (/api/version, /components/value)', async () => {
    fs.writeFileSync(path.join(tmp, 'index.js'), `const a = require('./api/version');\nconst b = require('./components/value');\n`);
    const mod = new CompatibilityModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp });
    assert.ok(!result.checks.some((c) => c.name.includes('RegExp v flag')));
  });

  it('still flags a genuine RegExp literal using the v flag', async () => {
    fs.writeFileSync(path.join(tmp, 'index.js'), `const re = /[\\p{ASCII}]/v;\n`);
    const mod = new CompatibilityModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp });
    assert.ok(
      result.checks.some((c) => c.name.includes('RegExp v flag')),
      'a genuine /pattern/v regex literal should still be flagged'
    );
  });
});
