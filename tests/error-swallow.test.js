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

describe('ErrorSwallowModule — discovery', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-es-disc-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('skips when no JS/TS files exist', async () => {
    write(tmp, 'README.md', '# hi\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'error-swallow:no-files'));
  });

  it('scans JS/TS files', async () => {
    write(tmp, 'src/a.ts', 'export const x = 1;\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'error-swallow:scanning'));
  });
});

describe('ErrorSwallowModule — empty catch', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-es-empty-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on `catch (err) {}`', async () => {
    write(tmp, 'src/a.js', [
      'async function run() {',
      '  try {',
      '    await doThing();',
      '  } catch (err) {',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('error-swallow:empty-catch:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('errors on single-line `catch {}`', async () => {
    write(tmp, 'src/a.js', [
      'function run() {',
      '  try { doThing(); } catch {}',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('error-swallow:empty-catch:')));
  });

  it('does NOT flag a catch that rethrows', async () => {
    write(tmp, 'src/a.js', [
      'function run() {',
      '  try { doThing(); } catch (err) { throw new Error("wrapped: " + err.message); }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('error-swallow:empty-catch:')),
      undefined,
    );
  });

  it('warns (not errors) on a catch block whose body is only a comment', async () => {
    // Corpus shape (src/api/handler.js): comments document intent but don't
    // handle the error, so it's still a surfaced finding — but this codebase's
    // own documented idiom is `catch { // explain why }`, so firing at ERROR
    // blocked our own self-scan with 291 false positives. Calibrated to
    // warning: still visible, no longer blocking.
    write(tmp, 'src/handler.js', [
      'async function getOrderHandler(req, res) {',
      '  try {',
      '    const order = await findOrderById(req.params.id);',
      '    res.json(order);',
      '  } catch (err) {',
      '    // PLANTED: silently swallowed error',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('error-swallow:empty-catch:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('still errors (not warns) on a truly bare empty catch — no code, no comment', async () => {
    write(tmp, 'src/a.js', [
      'async function run() {',
      '  try {',
      '    await doThing();',
      '  } catch (err) {',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('error-swallow:empty-catch:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('does NOT flag a comment-only catch nested inside a string literal', async () => {
    write(tmp, 'src/a.js', [
      'const exampleSnippet = "try { x(); } catch (err) { /* nothing */ }";',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('error-swallow:empty-catch:')),
      undefined,
    );
  });

  it('downgrades empty catch in test files to warning', async () => {
    write(tmp, 'a.test.js', [
      'it("throws", () => {',
      '  try { doThing(); } catch {}',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('error-swallow:empty-catch:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });
});

describe('ErrorSwallowModule — log-and-eat', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-es-log-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on catch that only console.errors', async () => {
    write(tmp, 'src/a.js', [
      'async function run() {',
      '  try {',
      '    await doThing();',
      '  } catch (err) {',
      '    console.error("doThing failed", err);',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('error-swallow:log-and-eat:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('does NOT flag catch that logs AND rethrows', async () => {
    write(tmp, 'src/a.js', [
      'async function run() {',
      '  try {',
      '    await doThing();',
      '  } catch (err) {',
      '    console.error("doThing failed", err);',
      '    throw err;',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('error-swallow:log-and-eat:')),
      undefined,
    );
  });

  it('does NOT flag catch that calls next(err) Express-style', async () => {
    write(tmp, 'src/a.js', [
      'app.use(async (req, res, next) => {',
      '  try {',
      '    await doThing();',
      '  } catch (err) {',
      '    logger.error({ err }, "doThing failed");',
      '    next(err);',
      '  }',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('error-swallow:log-and-eat:')),
      undefined,
    );
  });
});

describe('ErrorSwallowModule — .catch(noop)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-es-catch-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on .catch(() => {})', async () => {
    write(tmp, 'src/a.js', 'promise.catch(() => {});\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('error-swallow:catch-noop:')));
  });

  it('errors on .catch(() => null)', async () => {
    write(tmp, 'src/a.js', 'const result = await promise.catch(() => null);\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('error-swallow:catch-noop:')));
  });

  it('errors on .catch((e) => {})', async () => {
    write(tmp, 'src/a.js', 'promise.catch((e) => {});\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('error-swallow:catch-noop:')));
  });

  it('errors on .catch(noop) where `noop` is a known empty helper name', async () => {
    write(tmp, 'src/a.js', 'promise.catch(noop);\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('error-swallow:catch-noop:')));
  });

  it('does NOT flag .catch((err) => log.error(err))', async () => {
    write(tmp, 'src/a.js', 'promise.catch((err) => log.error({ err }));\n');
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('error-swallow:catch-noop:')),
      undefined,
    );
  });
});

describe('ErrorSwallowModule — global silent handler', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-es-glob-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on uncaughtException handler that neither logs nor exits', async () => {
    write(tmp, 'src/a.js', [
      "process.on('uncaughtException', (err) => {",
      '  // oh well',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('error-swallow:global-silent-handler:')));
  });

  it('does NOT flag an uncaughtException handler that calls process.exit(1)', async () => {
    write(tmp, 'src/a.js', [
      "process.on('uncaughtException', (err) => {",
      '  logger.fatal({ err });',
      '  process.exit(1);',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('error-swallow:global-silent-handler:')),
      undefined,
    );
  });
});

describe('ErrorSwallowModule — callback err ignored', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-es-cb-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns when err is never referenced in callback body', async () => {
    write(tmp, 'src/a.js', [
      'fs.readFile(p, (err, data) => {',
      '  console.log(data.toString());',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('error-swallow:callback-err-ignored:')));
  });

  it('does NOT warn when err is branched on', async () => {
    write(tmp, 'src/a.js', [
      'fs.readFile(p, (err, data) => {',
      '  if (err) throw err;',
      '  console.log(data.toString());',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('error-swallow:callback-err-ignored:')),
      undefined,
    );
  });
});

describe('ErrorSwallowModule — floating promise', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-es-float-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on fire-and-forget db.save()', async () => {
    write(tmp, 'src/a.js', [
      'function run() {',
      '  db.save({ x: 1 });',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('error-swallow:floating-promise:'));
    assert.ok(hit);
    assert.strictEqual(hit.method, 'save');
  });

  it('does NOT flag when awaited', async () => {
    write(tmp, 'src/a.js', [
      'async function run() {',
      '  await db.save({ x: 1 });',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('error-swallow:floating-promise:')),
      undefined,
    );
  });

  it('does NOT flag Map/Set/cookie .delete(bareKey) — returns boolean/void, not a promise', async () => {
    // Regression (2026-07-11): collection deletes take a bare key and return
    // boolean; only ORM deletes (object-literal arg) are floating-promise smells.
    write(tmp, 'src/a.js', [
      'function run(scanId, firstIdent, cookieStore) {',
      '  costLedger.delete(scanId);',
      '  taintedVars.delete(firstIdent[1]);',
      '  cookieStore.delete("gh_oauth_state");',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('error-swallow:floating-promise:')),
      undefined,
      'collection .delete(bareKey) must not be flagged',
    );
  });

  it('STILL flags an ORM .delete({ where }) — object-literal arg is a real smell', async () => {
    write(tmp, 'src/a.js', [
      'function run(id) {',
      '  prisma.user.delete({ where: { id } });',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(
      r.checks.find((c) => c.name.startsWith('error-swallow:floating-promise:')),
      'ORM delete with an object arg should still be flagged',
    );
  });

  it('does NOT flag .write() on any receiver — it returns a boolean, not a promise', async () => {
    // Regression (2026-07-11): stream/request .write() returns the backpressure
    // boolean per Node's contract, never an awaitable promise. Flagging it was a
    // 42-finding false-positive flood on our own repo (out.write, req.write, …).
    write(tmp, 'src/a.js', [
      'function run(out, req, sink) {',
      '  out.write("hello\\n");',
      '  req.write(JSON.stringify(body));',
      '  sink.write(chunk);',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('error-swallow:floating-promise:')),
      undefined,
      'stream .write() must not be flagged as a floating promise',
    );
  });

  it('does NOT flag when chained with .then/.catch', async () => {
    write(tmp, 'src/a.js', [
      'function run() {',
      '  db.save({ x: 1 }).then((r) => log.info(r)).catch((e) => log.error(e));',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('error-swallow:floating-promise:')),
      undefined,
    );
  });

  it('does NOT flag when assigned / returned', async () => {
    write(tmp, 'src/a.js', [
      'function run() {',
      '  const p = db.save({ x: 1 });',
      '  return p;',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('error-swallow:floating-promise:')),
      undefined,
    );
  });

  it('does NOT flag in test files (tests often fire-and-forget setup)', async () => {
    write(tmp, 'a.test.js', [
      'it("saves", () => {',
      '  db.save({ x: 1 });',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('error-swallow:floating-promise:')),
      undefined,
    );
  });
});

describe('ErrorSwallowModule — clean baseline', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-es-clean-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('emits zero findings for well-written async code', async () => {
    write(tmp, 'src/a.js', [
      'async function run() {',
      '  try {',
      '    await db.save({ x: 1 });',
      '  } catch (err) {',
      '    logger.error({ err }, "db.save failed");',
      '    throw err;',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const issues = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(issues.length, 0, `unexpected findings: ${JSON.stringify(issues, null, 2)}`);
  });

  // The "void promise" idiom — explicit, ESLint-recommended way to mark
  // intentional fire-and-forget. Must NOT trip catch-noop.
  it('does NOT flag `void promise.catch(() => {})` — idiomatic fire-and-forget', async () => {
    write(tmp, 'src/a.js', [
      'function run() {',
      '  void analytics.track("event").catch(() => {});',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const issues = r.checks.filter((c) => c.passed === false && c.name.includes('catch-noop'));
    assert.strictEqual(issues.length, 0, `expected no catch-noop on void prefix, got: ${JSON.stringify(issues, null, 2)}`);
  });

  it('does NOT flag multi-line `void promise\\n  .catch(() => {})` chains', async () => {
    write(tmp, 'src/a.js', [
      'function run() {',
      '  void analytics',
      '    .track("event")',
      '    .catch(() => {});',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const issues = r.checks.filter((c) => c.passed === false && c.name.includes('catch-noop'));
    assert.strictEqual(issues.length, 0, `expected no catch-noop on multi-line void chain, got: ${JSON.stringify(issues, null, 2)}`);
  });

  it('does NOT flag `void promise.catch(noop)` with named noop', async () => {
    write(tmp, 'src/a.js', [
      'const noop = () => {};',
      'function run() {',
      '  void analytics.track("event").catch(noop);',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const issues = r.checks.filter((c) => c.passed === false && c.name.includes('catch-noop'));
    assert.strictEqual(issues.length, 0, `expected no catch-noop with void + named noop, got: ${JSON.stringify(issues, null, 2)}`);
  });

  it('still flags `promise.catch(() => {})` WITHOUT a void prefix', async () => {
    write(tmp, 'src/a.js', [
      'function run() {',
      '  db.save({ x: 1 }).catch(() => {});',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const issues = r.checks.filter((c) => c.passed === false && c.name.includes('catch-noop'));
    assert.ok(issues.length >= 1, `expected catch-noop to still fire without void prefix`);
  });

  it('accepts `// gatetest-fire-and-forget` marker as suppression', async () => {
    write(tmp, 'src/a.js', [
      'function run() {',
      '  // gatetest-fire-and-forget',
      '  db.save({ x: 1 }).catch(() => {});',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const issues = r.checks.filter((c) => c.passed === false && c.name.includes('catch-noop'));
    assert.strictEqual(issues.length, 0, `marker comment should suppress catch-noop, got: ${JSON.stringify(issues, null, 2)}`);
  });

  it('does not let a `void` on an unrelated earlier line accidentally suppress', async () => {
    write(tmp, 'src/a.js', [
      'function run() {',
      '  void noop();',         // a void statement
      '  return doSomething();', // statement boundary in between
      '  db.save({ x: 1 }).catch(() => {});', // this is real fire-and-forget, no void
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const issues = r.checks.filter((c) => c.passed === false && c.name.includes('catch-noop'));
    assert.ok(issues.length >= 1, `void on a prior statement must not suppress an unrelated catch-noop`);
  });

  it('records a summary', async () => {
    write(tmp, 'src/a.js', 'export const x = 1;\n');
    const r = await run(tmp);
    const s = r.checks.find((c) => c.name === 'error-swallow:summary');
    assert.ok(s);
    assert.match(s.message, /1 file\(s\)/);
  });
});
