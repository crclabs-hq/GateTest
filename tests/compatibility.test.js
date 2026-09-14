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

  it('still flags a genuine RegExp literal using the v flag (in browser-shipped code — Node 20+ has it natively)', async () => {
    fs.writeFileSync(path.join(tmp, 'index.jsx'), `const re = /[\\p{ASCII}]/v;\n`);
    const mod = new CompatibilityModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp });
    assert.ok(
      result.checks.some((c) => c.name.includes('RegExp v flag')),
      'a genuine /pattern/v regex literal should still be flagged'
    );
  });
});

// =============================================================================
// One file, one runtime. Self-scan 2026-09-13: 60 findings, every one a
// browser-support warning on Node-only code (src/modules, bin/*.mjs,
// website/app/lib/*.ts, route.ts) in a package declaring engines.node >=20.
// The rule now judges browser-shipped code against the browser matrix and
// everything else against the Node floor the owning package.json declares.
// =============================================================================
describe('CompatibilityModule — the file\'s runtime decides the matrix', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-compat-target-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  function write(rel, body) {
    const full = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof body === 'string' ? body : JSON.stringify(body));
  }
  async function scan() {
    const mod = new CompatibilityModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp });
    return result.checks.filter((c) => c.name.startsWith('compat:js:'));
  }

  it('Node code under engines.node >=20 is quiet on APIs Node 20 has (toSorted, AbortSignal.timeout, structuredClone, v flag)', async () => {
    write('package.json', { name: 'x', engines: { node: '>=20.0.0' } });
    write('lib/server.js', 'const a = [3,1].toSorted();\nconst s = AbortSignal.timeout(5);\nconst c = structuredClone(a);\nconst re = /[\\p{ASCII}]/v;\n');
    assert.deepStrictEqual(await scan(), []);
  });

  it('the same Node code under engines.node >=18 names the API, the Node version it needs and the declared floor', async () => {
    write('package.json', { name: 'x', engines: { node: '>=18' } });
    write('lib/server.js', 'const a = [3,1].toSorted();\nconst s = AbortSignal.timeout(5);\n');
    const checks = await scan();
    assert.deepStrictEqual(checks.map((c) => c.name), [`compat:js:Array.toSorted:lib/server.js`]);
    assert.match(checks[0].message, /needs Node 20\+/);
    assert.match(checks[0].message, /">=18" admits Node 18/);
  });

  it('a Node file with no engines field assumes Node 20 and says so', async () => {
    write('package.json', { name: 'x' });
    write('lib/server.js', 'const { promise, resolve } = Promise.withResolvers();\n');
    const checks = await scan();
    assert.strictEqual(checks.length, 1);
    assert.match(checks[0].message, /needs Node 22\+ but engines\.node is not declared — assuming Node 20/);
  });

  it('the NEAREST package.json owns the file: a nested app on >=22 is quiet while the root declares >=18', async () => {
    write('package.json', { name: 'root', engines: { node: '>=18' } });
    write('apps/api/package.json', { name: 'api', engines: { node: '>=22' } });
    write('apps/api/route.ts', 'export const x = Promise.withResolvers();\n');
    assert.deepStrictEqual(await scan(), []);
  });

  it('a "use client" module gets the browser matrix even under engines.node >=22', async () => {
    write('package.json', { name: 'x', engines: { node: '>=22' } });
    write('app/lib/client.ts', '"use client";\nexport const s = AbortSignal.timeout(5);\n');
    const checks = await scan();
    assert.strictEqual(checks.length, 1);
    assert.match(checks[0].message, /AbortSignal\.timeout.*Chrome 103.*target browsers/);
  });

  it('a .tsx component and a public/ script get the browser matrix; a shebang script does not', async () => {
    write('package.json', { name: 'x', engines: { node: '>=22' } });
    write('components/List.tsx', 'export const L = () => <ul>{[1].toSorted().map((n) => <li key={n}>{n}</li>)}</ul>;\n');
    write('public/app.js', 'const c = structuredClone({});\n');
    write('bin/tool.js', '#!/usr/bin/env node\nconst c = structuredClone({});\n');
    const names = (await scan()).map((c) => c.name).sort();
    assert.deepStrictEqual(names, [
      `compat:js:Array.toSorted:components/List.tsx`,
      `compat:js:structuredClone:public/app.js`,
    ]);
  });

  it('a browserslist project with no Node engine treats plain source as browser code', async () => {
    write('package.json', { name: 'x', browserslist: ['defaults'] });
    write('src/main.js', 'const c = structuredClone({});\n');
    const checks = await scan();
    assert.strictEqual(checks.length, 1);
    assert.match(checks[0].message, /target browsers/);
  });

  it('feature-detected use is not a finding (typeof AbortSignal … && AbortSignal.timeout ? …)', async () => {
    write('package.json', { name: 'x' });
    write('app/lib/fetcher.tsx', "export const sig = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(5) : undefined;\n");
    assert.deepStrictEqual(await scan(), []);
  });

  it('a comment or a string naming the API does not fire (masked source)', async () => {
    write('package.json', { name: 'x' });
    write('components/A.tsx', "// we avoid structuredClone( here\nconst s = 'call structuredClone(x) later';\nexport const A = 1;\n");
    assert.deepStrictEqual(await scan(), []);
  });
});

describe('CompatibilityModule — Iterator helpers are iterator calls, not array chaining', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-compat-iter-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  async function scanFile(rel, body, pkg) {
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(pkg));
    fs.writeFileSync(path.join(tmp, rel), body);
    const mod = new CompatibilityModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp });
    const suffix = rel; // finding ids are /-joined on every OS (src/core/repo-path.js)
    return result.checks.filter((c) => c.name.includes('Iterator helpers') && c.name.endsWith(suffix));
  }

  it('arr.map(f).filter(g) — Array.prototype chaining since ES5 — is never a finding (39 of 60 self-scan findings)', async () => {
    const checks = await scanFile('components/A.tsx', 'export const A = [1,2].map((x) => x * 2).filter((x) => x > 2);\nconst e = Object.entries({}).map(([k]) => k).filter(Boolean);\n', { name: 'x' });
    assert.deepStrictEqual(checks, []);
  });

  it('set.values().map(f) and Iterator.from( are the real thing: Chrome 122 in a browser file, Node 22 on the server', async () => {
    const browser = await scanFile('components/B.tsx', 'export const B = new Set([1]).values().map((x) => x);\n', { name: 'x' });
    assert.strictEqual(browser.length, 1);
    assert.match(browser[0].message, /Chrome 122/);
    const node = await scanFile('lib/b.js', 'const it = Iterator.from([1]).take(1);\n', { name: 'x', engines: { node: '>=20' } });
    assert.strictEqual(node.length, 1);
    assert.match(node[0].message, /needs Node 22\+/);
    const node22 = await scanFile('lib/c.js', 'const it = Iterator.from([1]).take(1);\n', { name: 'x', engines: { node: '>=22' } });
    assert.deepStrictEqual(node22, []);
  });
});

describe('CompatibilityModule — Set methods, top-level await, engines parsing', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-compat-misc-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  async function scanFile(rel, body, pkg) {
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(pkg));
    fs.writeFileSync(path.join(tmp, rel), body);
    const mod = new CompatibilityModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp });
    const suffix = rel; // finding ids are /-joined on every OS (src/core/repo-path.js)
    return result.checks.filter((c) => c.name.startsWith('compat:js:') && c.name.endsWith(suffix));
  }

  it('z.union([...]) is a schema builder, a.union(b) on a Set is the finding (src/modules/zod-schema.js, self-scan)', async () => {
    const zod = await scanFile('components/Z.tsx', 'const S = z.union([z.string(), z.number()]);\nexport const Z = S;\n', { name: 'x' });
    assert.deepStrictEqual(zod, []);
    const set = await scanFile('components/S.tsx', 'export const S = new Set([1]).union(new Set([2]));\n', { name: 'x' });
    assert.deepStrictEqual(set.map((c) => c.name), [`compat:js:Set methods (union/intersection):components/S.tsx`]);
  });

  it('top-level await inside a template literal is not a statement; a real one in a CJS .js is; "type": "module" makes it legal', async () => {
    const fixture = await scanFile('tests/gen.test.js', 'const src = `\nawait run();\n`;\nmodule.exports = src;\n', { name: 'x' });
    assert.deepStrictEqual(fixture, []);
    const real = await scanFile('lib/top.js', 'const x = 1;\nawait run(x);\n', { name: 'x' });
    assert.deepStrictEqual(real.map((c) => c.name), [`compat:js:top-level-await:lib/top.js`]);
    const esm = await scanFile('lib/top2.js', 'const x = 1;\nawait run(x);\n', { name: 'x', type: 'module' });
    assert.deepStrictEqual(esm, []);
  });

  it('engines.node floors: >=18.17, ^20 || >=22, 20.x, >18 read as 18 / 20 / 20 / 18; * and <21 bound nothing', async () => {
    const { minNodeMajor } = CompatibilityModule;
    assert.strictEqual(minNodeMajor('>=18.17.0'), 18);
    assert.strictEqual(minNodeMajor('^20 || >=22'), 20);
    assert.strictEqual(minNodeMajor('20.x'), 20);
    assert.strictEqual(minNodeMajor('>18'), 18);
    assert.strictEqual(minNodeMajor('*'), null);
    assert.strictEqual(minNodeMajor('<21'), null);
    assert.strictEqual(minNodeMajor(undefined), null);
  });
});
