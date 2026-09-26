const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ErrorSwallowModule = require('../src/modules/error-swallow');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) {
      this.checks.push({ name, passed, ...details });
    },
  };
}

function run(projectRoot) {
  const mod = new ErrorSwallowModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// Issue #769: AlecRae's cross-test (GT-17) found 69 blocking errorSwallow
// findings on `.catch(() => null)` / `.catch(() => undefined)` whose
// returned sentinel the caller actually reads (`if (!x) return …`,
// `?? default`) — the documented sentinel idiom, not a swallowed error.
// The tree had zero literal `.catch(() => {})`. Control pair below: (a)/(b)
// consumed sentinels must not block; (c) the bare noop that discards and
// continues on a success path must still block; (d) a sentinel assigned
// but never read must still block (consumption, not mere assignment, is
// what earns the downgrade); (e) the exact AlecRae shape from the evidence
// file (api.ts:291) with the error-check idiom that codebase uses elsewhere.
describe('ErrorSwallowModule — consumed-sentinel guard (control pair, issue #769)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-es-sentinel-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const noop = (r) => r.checks.find((c) => c.name.startsWith('error-swallow:catch-noop:'));

  it('(a) `const u = await load().catch(() => null); if (!u) return res.status(404).end();` — consumed, no blocking finding', async () => {
    write(tmp, 'src/handler.js', [
      'async function handler(req, res) {',
      '  const u = await load().catch(() => null);',
      '  if (!u) return res.status(404).end();',
      '  return res.json(u);',
      '}',
      'module.exports = { handler };',
    ].join('\n'));
    const r = await run(tmp);
    const hit = noop(r);
    assert.ok(hit, 'the sentinel catch is still reported, just not as a swallow');
    assert.strictEqual(hit.severity, 'warning');
    assert.strictEqual(hit.guarded, 'consumed-sentinel');
    assert.match(hit.message, /if \(!u\)|checked-return idiom/);
  });

  it('(b) `const v = (await get().catch(() => undefined)) ?? DEFAULT;` — same-statement nullish, no blocking finding', async () => {
    write(tmp, 'src/svc.js', [
      'async function load() {',
      '  const v = (await get().catch(() => undefined)) ?? DEFAULT;',
      '  return v;',
      '}',
      'module.exports = { load };',
    ].join('\n'));
    const r = await run(tmp);
    const hit = noop(r);
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
    assert.strictEqual(hit.guarded, 'consumed-sentinel');
  });

  it('(c) `await save().catch(() => {}); res.json({ ok: true });` — bare noop discards and continues, STILL BLOCKING', async () => {
    write(tmp, 'src/save.js', [
      'async function commit(res) {',
      '  await save().catch(() => {});',
      '  res.json({ ok: true });',
      '}',
      'module.exports = { commit };',
    ].join('\n'));
    const r = await run(tmp);
    const hit = noop(r);
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
    assert.strictEqual(hit.guarded, undefined);
  });

  it('(d) `const r = await fetch().catch(() => null); res.json({ ok: true });` — sentinel assigned but never read, STILL BLOCKING', async () => {
    write(tmp, 'src/ping.js', [
      'async function ping(res) {',
      '  const r = await fetch().catch(() => null);',
      '  res.json({ ok: true });',
      '}',
      'module.exports = { ping };',
    ].join('\n'));
    const r = await run(tmp);
    const hit = noop(r);
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
    assert.strictEqual(hit.guarded, undefined);
  });

  it('(e) AlecRae shape (GT-17, api.ts:291): `const err = (await res.json().catch(() => null)) as ApiError | null;` checked by the caller — no blocking finding', async () => {
    // The evidence file (alecrae-crosstest.md, GT-17) quotes this exact
    // line as one of the 69 false positives; the surrounding consumer
    // (`if (err) throw err;`) is the same error-check idiom used across
    // that codebase's other cited sites (settings/page.tsx, ai-liveness.ts).
    write(tmp, 'src/api.ts', [
      'async function request(res: Response) {',
      '  const err = (await res.json().catch(() => null)) as ApiError | null;',
      '  if (err) throw err;',
      '  return res;',
      '}',
      'module.exports = { request };',
    ].join('\n'));
    const r = await run(tmp);
    const hit = noop(r);
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
    assert.strictEqual(hit.guarded, 'consumed-sentinel');
  });

  it('a consumed sentinel is still reported (never fully silenced) — the finding names the consumer', async () => {
    write(tmp, 'src/handler2.js', [
      'async function handler(req, res) {',
      '  const u = await load().catch(() => null);',
      '  if (!u) return res.status(404).end();',
      '}',
      'module.exports = { handler };',
    ].join('\n'));
    const r = await run(tmp);
    const hit = noop(r);
    assert.ok(hit);
    assert.match(hit.message, /line 3/);
  });

  it('`.catch(() => false)` whose result is consumed downstream is not blocking', async () => {
    write(tmp, 'src/flag.js', [
      'async function check() {',
      '  const ok = await verify().catch(() => false);',
      '  if (!ok) return null;',
      '  return true;',
      '}',
      'module.exports = { check };',
    ].join('\n'));
    const r = await run(tmp);
    const hit = noop(r);
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
    assert.strictEqual(hit.guarded, 'consumed-sentinel');
  });

  it('`.catch(() => false)` never read still blocks', async () => {
    write(tmp, 'src/flag2.js', [
      'async function check(res) {',
      '  const ok = await verify().catch(() => false);',
      '  res.end();',
      '}',
      'module.exports = { check };',
    ].join('\n'));
    const r = await run(tmp);
    const hit = noop(r);
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
    assert.strictEqual(hit.guarded, undefined);
  });

  it('sentinel passed straight to a guard function call is consumed', async () => {
    write(tmp, 'src/route.js', [
      'async function route() {',
      '  const session = await loadSession().catch(() => null);',
      '  return requireSession(session);',
      '}',
      'module.exports = { route };',
    ].join('\n'));
    const r = await run(tmp);
    const hit = noop(r);
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
    assert.strictEqual(hit.guarded, 'consumed-sentinel');
  });
});
