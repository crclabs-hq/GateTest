const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ErrorSwallowModule = require('../src/modules/error-swallow');
const { bodyNeverRejects, neverRejectingNames, importedNames } = require('../src/core/never-rejects');

function makeResult() {
  return { checks: [], addCheck(name, passed, details = {}) { this.checks.push({ name, passed, ...details }); } };
}
function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
async function noopHits(root) {
  const result = makeResult();
  await new ErrorSwallowModule().run(result, { projectRoot: root });
  return result.checks.filter((c) => c.name.startsWith('error-swallow:catch-noop:'));
}

// Gluecron src/lib/notify.ts `audit()`, as written there on 2026-10-02.
const NOTIFY = [
  'export async function audit(opts: { action: string; metadata?: Record<string, unknown> }): Promise<void> {',
  '  try {',
  '    const orgId = opts.metadata ? await deriveOrg(opts) : null;',
  '    await db.insert(auditLog).values({ action: opts.action, orgId });',
  '  } catch (err) {',
  '    // Audit must never break the primary flow',
  '    console.error("[audit] failed:", err);',
  '  }',
  '}',
  'export async function mayFail(opts) {',
  '  try {',
  '    await db.insert(auditLog).values(opts);',
  '  } catch (err) {',
  '    console.error(err);',
  '    throw err;',
  '  }',
  '}',
].join('\n');

const CALLER = (fn) => [
  `import { ${fn} } from "../lib/notify";`,
  'export async function route(c, result) {',
  `  await ${fn}({`,
  '    action: "deploy_key.add",',
  '    metadata: { title: result.title },',
  '  }).catch(() => {});',
  '  return c.json(result, 201);',
  '}',
].join('\n');

describe('errorSwallow — callee-never-rejects (Gluecron audit() shape, 2026-10-02)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-es-nr-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('`.catch(() => {})` on an imported async function that catches its own errors is not blocking', async () => {
    write(tmp, 'src/lib/notify.ts', NOTIFY);
    write(tmp, 'src/routes/keys.ts', CALLER('audit'));
    const [hit] = await noopHits(tmp);
    assert.ok(hit, 'still reported');
    assert.strictEqual(hit.severity, 'warning');
    assert.strictEqual(hit.guarded, 'callee-never-rejects');
  });

  it('control: the same call to a function whose catch rethrows still blocks', async () => {
    write(tmp, 'src/lib/notify.ts', NOTIFY);
    write(tmp, 'src/routes/keys.ts', CALLER('mayFail'));
    const [hit] = await noopHits(tmp);
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('control: a method of the same name on another object is not resolved to the function', async () => {
    write(tmp, 'src/lib/notify.ts', NOTIFY);
    write(tmp, 'src/routes/keys.ts', [
      'import { audit } from "../lib/notify";',
      'export async function route(client) {',
      '  await client.audit({ action: "x" }).catch(() => {});',
      '  return audit;',
      '}',
    ].join('\n'));
    const [hit] = await noopHits(tmp);
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('control: an unresolvable import (package or alias) keeps blocking', async () => {
    write(tmp, 'src/routes/keys.ts', CALLER('audit').replace('"../lib/notify"', '"@acme/notify"'));
    const [hit] = await noopHits(tmp);
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });
});

describe('never-rejects — body reader', () => {
  it('a try/catch body that logs never rejects', () => {
    assert.strictEqual(bodyNeverRejects('try { await x(); } catch (e) { log(e); }'), true);
    assert.strictEqual(bodyNeverRejects('try { await x(); return true; } catch { return false; }'), true);
  });
  it('control: rethrow, Promise.reject, code after the catch, an un-awaited return', () => {
    assert.strictEqual(bodyNeverRejects('try { await x(); } catch (e) { throw e; }'), false);
    assert.strictEqual(bodyNeverRejects('try { await x(); } catch (e) { return Promise.reject(e); }'), false);
    assert.strictEqual(bodyNeverRejects('try { await x(); } catch {} await y();'), false);
    assert.strictEqual(bodyNeverRejects('try { return x(); } catch { return null; }'), false);
    assert.strictEqual(bodyNeverRejects('try { return await x(); } catch { return null; }'), true);
    assert.strictEqual(bodyNeverRejects('const a = 1; try { await x(); } catch {}'), false);
  });
  it('only async functions qualify; arrows are read too', () => {
    const names = neverRejectingNames([
      'function syncFn() { try { return p(); } catch {} }',
      'async function a() { try { await p(); } catch {} }',
      'export const b = async (x: string): Promise<void> => { try { await p(x); } catch {} };',
    ].join('\n'));
    assert.deepStrictEqual([...names].sort(), ['a', 'b']);
  });
  it('import reader follows aliases and type-only names', () => {
    const m = importedNames('import { audit, notify as send, type X } from "../lib/notify";');
    assert.deepStrictEqual(m.get('send'), { name: 'notify', spec: '../lib/notify' });
    assert.ok(m.has('audit'));
  });
});
