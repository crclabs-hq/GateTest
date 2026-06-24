const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const UndefinedRefModule = require('../src/modules/undefined-ref');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) {
      this.checks.push({ name, passed, ...details });
    },
  };
}

function run(projectRoot) {
  const mod = new UndefinedRefModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}

function write(root, file, content) {
  const full = path.join(root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('UndefinedRefModule — Crontech regression patterns', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-uref-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  // The actual bug shape that crashed Crontech's api on 2026-05-24:
  // a configuration object passes a function-as-value where the function
  // name was never imported. Crashes at module load.
  it('flags Crontech-shape object-property value referencing undefined name', async () => {
    write(tmp, 'src/handler.ts', `
const app = createSomething({
  tenantCapResolver: resolveTenantCapForHotPath,
});
`);
    const r = await run(tmp);
    const finding = r.checks.find(
      (c) => c.name && c.name.includes('undefined-ref:resolveTenantCapForHotPath:src/handler.ts:'),
    );
    assert.ok(finding, 'should flag the undefined function reference');
    assert.strictEqual(finding.severity, 'error');
    assert.match(finding.message, /never imported or declared/);
  });

  it('passes when the function IS imported', async () => {
    write(tmp, 'src/handler.ts', `
import { resolveTenantCapForHotPath } from './quotas';
const app = createSomething({
  tenantCapResolver: resolveTenantCapForHotPath,
});
`);
    const r = await run(tmp);
    const finding = r.checks.find(
      (c) => c.name && c.name.includes('undefined-ref:resolveTenantCapForHotPath:'),
    );
    assert.strictEqual(finding, undefined, 'should not flag — name is imported');
  });

  it('passes when the function IS declared in the same file', async () => {
    write(tmp, 'src/handler.ts', `
function resolveTenantCapForHotPath() { return Infinity; }
const app = createSomething({
  tenantCapResolver: resolveTenantCapForHotPath,
});
`);
    const r = await run(tmp);
    const finding = r.checks.find(
      (c) => c.name && c.name.includes('undefined-ref:resolveTenantCapForHotPath:'),
    );
    assert.strictEqual(finding, undefined, 'should not flag — name is declared');
  });

  it('catches the second Crontech bug shape (function-call in module init)', async () => {
    write(tmp, 'src/index.ts', `
// createBuilderPublicApiApp defined elsewhere but NEVER imported
const config = {
  builder: createBuilderPublicApiApp,
  tracker: buildTrackingApp,
};
`);
    const r = await run(tmp);
    const a = r.checks.find((c) => c.name && c.name.includes('undefined-ref:createBuilderPublicApiApp:'));
    const b = r.checks.find((c) => c.name && c.name.includes('undefined-ref:buildTrackingApp:'));
    assert.ok(a, 'should flag createBuilderPublicApiApp');
    assert.ok(b, 'should flag buildTrackingApp');
  });
});

describe('UndefinedRefModule — false-positive guards', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-uref-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('does not flag globals (console, fetch, process, Buffer)', async () => {
    write(tmp, 'src/x.ts', `
const cfg = {
  log: console,
  http: fetch,
  proc: process,
  buf: Buffer,
};
`);
    const r = await run(tmp);
    const findings = r.checks.filter((c) => c.severity === 'error');
    assert.strictEqual(findings.length, 0, `expected 0 errors, got ${findings.length}: ${findings.map((f) => f.name).join(', ')}`);
  });

  it('does not flag TS utility types (Partial, Record, etc.)', async () => {
    write(tmp, 'src/x.ts', `
const cfg = {
  shape: Partial,
  pick: Pick,
  record: Record,
};
`);
    const r = await run(tmp);
    const findings = r.checks.filter((c) => c.severity === 'error');
    assert.strictEqual(findings.length, 0);
  });

  it('does not flag identifiers under 4 chars (noise reduction)', async () => {
    // Too many 1-3 char identifiers in real code (loop vars, etc.) — V1
    // skips them to keep FP rate low.
    write(tmp, 'src/x.ts', `
const cfg = {
  x: foo,
  y: bar,
};
`);
    const r = await run(tmp);
    const findings = r.checks.filter((c) => c.severity === 'error');
    assert.strictEqual(findings.length, 0);
  });

  it('does not flag destructure-bound names', async () => {
    write(tmp, 'src/x.ts', `
const { databaseClient, redisClient } = require('./deps');
const cfg = {
  db: databaseClient,
  cache: redisClient,
};
`);
    const r = await run(tmp);
    const findings = r.checks.filter((c) => c.severity === 'error');
    assert.strictEqual(findings.length, 0);
  });

  it('does not flag renamed imports (`import { X as Y }`)', async () => {
    write(tmp, 'src/x.ts', `
import { someFunction as renamedHandler } from './lib';
const cfg = {
  handler: renamedHandler,
};
`);
    const r = await run(tmp);
    const findings = r.checks.filter((c) => c.severity === 'error');
    assert.strictEqual(findings.length, 0);
  });

  it('does not flag names appearing inside string literals', async () => {
    write(tmp, 'src/x.ts', `
import { realName } from './lib';
const message = "looksLikeUndefinedFunctionName is fine in a string";
const cfg = {
  handler: realName,
};
`);
    const r = await run(tmp);
    const findings = r.checks.filter((c) => c.severity === 'error');
    assert.strictEqual(findings.length, 0);
  });

  it('does not flag names appearing inside line comments', async () => {
    write(tmp, 'src/x.ts', `
import { realName } from './lib';
// looksLikeUndefinedFunctionName: not real, just a comment
const cfg = {
  handler: realName,
};
`);
    const r = await run(tmp);
    const findings = r.checks.filter((c) => c.severity === 'error');
    assert.strictEqual(findings.length, 0);
  });

  it('does not flag test-runner globals (describe, it, expect, vi)', async () => {
    write(tmp, 'tests/something.test.ts', `
const cfg = {
  d: describe,
  i: it,
  e: expect,
};
`);
    const r = await run(tmp);
    // In test paths, severity is downgraded to warning anyway; but
    // these names are in the global allowlist so they should never fire.
    const findings = r.checks.filter((c) => c.severity === 'error' || c.severity === 'warning');
    const errs = findings.filter((c) => c.name && c.name.startsWith('undefined-ref:describe') ||
                                        c.name && c.name.startsWith('undefined-ref:it') ||
                                        c.name && c.name.startsWith('undefined-ref:expect'));
    assert.strictEqual(errs.length, 0);
  });
});

describe('UndefinedRefModule — severity & suppression', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-uref-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('downgrades severity in test paths', async () => {
    write(tmp, 'tests/handler.test.ts', `
const cfg = { handler: undefinedFunctionName };
`);
    const r = await run(tmp);
    const f = r.checks.find((c) => c.name && c.name.includes('undefined-ref:undefinedFunctionName:'));
    assert.ok(f);
    assert.strictEqual(f.severity, 'warning', 'test paths should downgrade error → warning');
  });

  it('respects `// undefined-ref-ok` suppression on same line', async () => {
    write(tmp, 'src/x.ts', `
const cfg = { handler: knownLateBindingFunction }; // undefined-ref-ok
`);
    const r = await run(tmp);
    const errs = r.checks.filter((c) => c.severity === 'error');
    assert.strictEqual(errs.length, 0, 'same-line suppression should silence the rule');
  });

  it('respects `// undefined-ref-ok` suppression on preceding line', async () => {
    write(tmp, 'src/x.ts', `
// undefined-ref-ok
const cfg = { handler: knownLateBindingFunction };
`);
    const r = await run(tmp);
    const errs = r.checks.filter((c) => c.severity === 'error');
    assert.strictEqual(errs.length, 0);
  });
});

describe('UndefinedRefModule — discovery', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-uref-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('emits the no-files info check when nothing to scan', async () => {
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'undefined-ref:no-files'));
  });

  it('skips .d.ts files (ambient declarations)', async () => {
    write(tmp, 'src/types.d.ts', `
declare const someAmbientGlobal: any;
const cfg = { x: maybeUndefinedThing };
`);
    const r = await run(tmp);
    // .d.ts is excluded, so the scan finds no files
    assert.ok(r.checks.find((c) => c.name === 'undefined-ref:no-files'));
  });

  it('skips node_modules / dist / build / coverage', async () => {
    write(tmp, 'node_modules/bad/x.ts', `const cfg = { x: thisShouldNotBeFlaggedFromNodeModules };`);
    write(tmp, 'dist/x.ts', `const cfg = { x: thisShouldNotBeFlaggedFromDist };`);
    write(tmp, 'src/real.ts', `const realCfg = { x: realFinding };`);
    const r = await run(tmp);
    const nodeFind = r.checks.find((c) => c.name && c.name.includes('thisShouldNotBeFlaggedFromNodeModules'));
    const distFind = r.checks.find((c) => c.name && c.name.includes('thisShouldNotBeFlaggedFromDist'));
    const realFind = r.checks.find((c) => c.name && c.name.includes('undefined-ref:realFinding:'));
    assert.strictEqual(nodeFind, undefined);
    assert.strictEqual(distFind, undefined);
    assert.ok(realFind);
  });
});
