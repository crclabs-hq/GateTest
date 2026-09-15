const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const IntegrationTestsModule = require('../src/modules/integration-tests');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) { this.checks.push({ name, passed, ...details }); },
  };
}

describe('IntegrationTestsModule — baseline shape', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-integ-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('exposes the expected BaseModule shape', () => {
    const mod = new IntegrationTestsModule();
    assert.strictEqual(typeof mod.name, 'string');
    assert.ok(mod.name.length > 0);
    assert.strictEqual(typeof mod.description, 'string');
    assert.ok(mod.description.length > 0);
    assert.strictEqual(typeof mod.run, 'function');
  });

  it('runs without throwing on an empty project root', async () => {
    const mod = new IntegrationTestsModule();
    const result = makeResult();
    await assert.doesNotReject(mod.run(result, { projectRoot: tmp }));
  });
});

// KI #106 (the Fifty, move 11): endpoints were detected with a private
// `(?:app|router).(get|post|…)` — Express spelled out by hand. A Fastify,
// Hono, Koa or Elysia service, a NestJS controller or a SvelteKit
// `+server.ts` reported `integration-tests:not-needed`. And the test-file
// walk asked `_collectFiles` for ['.test.js', …], which matches on
// path.extname and so matched NOTHING: every endpoint was "untested" even
// when a test named it. Both fixed 2026-09-05, with controls both ways.
describe('IntegrationTestsModule — one route grammar, real test discovery (KI #106)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-integ-grammar-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const w = (rel, c) => { const f = path.join(tmp, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };
  const run = async () => { const r = makeResult(); await new IntegrationTestsModule().run(r, { projectRoot: tmp, getModuleConfig() { return {}; }, get() { return null; } }); return r.checks; };
  const names = (checks) => checks.map((c) => c.name);

  it('POSITIVE: a Fastify service with no tests is told it has untested endpoints (was: not-needed)', async () => {
    w('src/server.ts', "import Fastify from 'fastify';\nconst fastify = Fastify();\nfastify.post('/users', async (req) => req.body);\nfastify.get('/users/:id', async () => ({}));\n");
    const c = await run();
    assert.ok(!names(c).includes('integration-tests:not-needed'), names(c).join());
    assert.ok(names(c).includes('integration-tests:missing'), names(c).join());
    assert.ok(names(c).includes('integration:untested:POST:/users'), names(c).join());
  });

  it('a NestJS controller: @Controller prefix + verb decorators become endpoints; a SvelteKit +server.ts too', async () => {
    w('src/cats/cats.controller.ts', "@Controller('cats')\nexport class CatsController {\n  @Get(':id')\n  findOne() {}\n  @Post()\n  create() {}\n}\n");
    w('src/routes/api/health/+server.ts', 'export async function GET() { return new Response("ok"); }\n');
    const c = await run();
    assert.ok(names(c).includes('integration:untested:GET:/cats/:id'), names(c).join());
    assert.ok(names(c).includes('integration:untested:POST:/cats'), names(c).join());
    assert.ok(names(c).some((n) => /^integration:untested:GET:.*\+server\.ts$/.test(n)), names(c).join());
  });

  it('NEGATIVE: a library with no routes, db ops or services is still not-needed; a route inside a comment is not a route', async () => {
    w('src/index.ts', "// example: fastify.post('/x', handler)\nexport const add = (a: number, b: number) => a + b;\n");
    const c = await run();
    assert.ok(names(c).includes('integration-tests:not-needed'), names(c).join());
  });

  it('a route inside a string, a template or a comment is not an endpoint; the real one beside them is (2026-09-05)', async () => {
    // Control pair for the one-stripper migration: the match position is
    // judged against BaseModule._maskedLines, which sees a template literal
    // and a block comment that span lines — the per-line quote counter it
    // replaced could not.
    w('src/server.js', [
      "const doc = \"app.get('/in-string', h)\";",
      'const tpl = `',
      "  app.get('/in-template', h)",
      '`;',
      '/* example:',
      "   app.get('/in-comment', h)",
      '*/',
      "app.get('/real', h);",
      '',
    ].join('\n'));
    const c = await run();
    assert.deepStrictEqual(names(c).filter((n) => n.startsWith('integration:untested:')), ['integration:untested:GET:/real']);
  });

  it('POSITIVE CONTROL for the walk: a tests/integration/*.test.ts that names the route IS found and the route is not "untested"', async () => {
    w('src/app.js', "const app = require('express')();\napp.post('/users', (req, res) => res.json(req.body));\n");
    w('tests/integration/users.test.js', "test('POST /users', async () => { await request(app).post('/users'); });\n");
    const c = await run();
    const found = c.find((x) => x.name === 'integration-tests:found');
    assert.ok(found && /1 integration test file/.test(found.message), JSON.stringify(found));
    assert.ok(!names(c).includes('integration:untested:POST:/users'), names(c).join());
    assert.ok(!names(c).includes('integration-tests:missing'));
  });

  it('a `users.integration.test.ts` outside any integration dir counts too; an ordinary unit test does not', async () => {
    w('src/app.js', "const app = require('express')();\napp.get('/health', (req, res) => res.send('ok'));\n");
    w('src/__tests__/users.integration.test.ts', "it('GET /health', () => {});\n");
    w('src/__tests__/math.test.ts', "it('adds', () => {});\n");
    const c = await run();
    const found = c.find((x) => x.name === 'integration-tests:found');
    assert.ok(found && /1 integration test file/.test(found.message), JSON.stringify(found));
  });
});

// The third state (doctrine §1): a `test:integration` script that cannot run
// on this box — dependencies never installed, or a runner that never reached
// a test — is "not executed", never "Integration tests failed". nest and
// prisma both blocked on that here (2026-09-05).
describe('IntegrationTestsModule — an environment failure is not a failing suite', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-integ-env-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const w = (rel, c) => { const f = path.join(tmp, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof c === 'string' ? c : JSON.stringify(c)); };
  const run = async () => { const r = makeResult(); await new IntegrationTestsModule().run(r, { projectRoot: tmp, getModuleConfig() { return {}; }, get() { return null; } }); return r.checks; };
  const runCheck = (c) => c.find((x) => x.name === 'integration-tests:run');

  it('dependencies not installed: the script is not run, reported as info', async () => {
    w('package.json', { name: 'svc', scripts: { 'test:integration': 'node -e "process.exit(1)"' }, devDependencies: { vitest: '^1' } });
    w('src/app.js', "app.post('/users', (req, res) => res.json(req.body));\n");
    w('tests/integration/users.test.js', "test('POST /users', () => {});\n");
    const rc = runCheck(await run());
    assert.ok(rc && rc.passed && rc.severity === 'info' && /not executed/.test(rc.message), JSON.stringify(rc));
  });

  it('POSITIVE CONTROL: with dependencies present, a script that really fails is still "Integration tests failed"', async () => {
    w('package.json', { name: 'svc', scripts: { 'test:integration': 'node -e "console.log(\'1 test failed\'); process.exit(1)"' }, devDependencies: { vitest: '^1' } });
    fs.mkdirSync(path.join(tmp, 'node_modules'), { recursive: true });
    w('src/app.js', "app.post('/users', (req, res) => res.json(req.body));\n");
    w('tests/integration/users.test.js', "test('POST /users', () => {});\n");
    const rc = runCheck(await run());
    assert.ok(rc && !rc.passed && /failed/.test(rc.message), JSON.stringify(rc));
  });

  it('a runner that never reached a test (missing binary) is "not executed", not failed', async () => {
    w('package.json', { name: 'svc', scripts: { 'test:integration': 'node -e "console.error(\'sh: 1: vitest: not found\'); process.exit(127)"' }, devDependencies: { vitest: '^1' } });
    fs.mkdirSync(path.join(tmp, 'node_modules'), { recursive: true });
    w('src/app.js', "app.post('/users', (req, res) => res.json(req.body));\n");
    w('tests/integration/users.test.js', "test('POST /users', () => {});\n");
    const rc = runCheck(await run());
    assert.ok(rc && rc.passed && /toolchain/.test(rc.message), JSON.stringify(rc));
  });
});

describe('IntegrationTestsModule — a timeout is not a verdict', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-integ-to-')); });
  // The module's timeout ends `npm run …` (cmd.exe / sh), not the script npm
  // started: that grandchild keeps running with tmp as its cwd, and on
  // Windows a directory that is some process's cwd cannot be removed — EPERM
  // in this hook, deterministic whenever npm managed to start the script
  // within the 1.5 s (2026-09-14; it passed under load only because npm had
  // not). The script is kept short and the removal polled past its end —
  // rmSync's own maxRetries returns this EPERM at once (measured), so the
  // wait is explicit: 250 ms steps, 10 s ceiling, the last error thrown.
  afterEach(() => {
    const deadline = Date.now() + 10000;
    for (;;) {
      try { fs.rmSync(tmp, { recursive: true, force: true }); return; } catch (err) {
        if (Date.now() > deadline) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      }
    }
  });
  const w = (rel, c) => { const f = path.join(tmp, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof c === 'string' ? c : JSON.stringify(c)); };
  it('a script that does not finish in time is "not executed", reported as info', async () => {
    w('package.json', { name: 'svc', scripts: { 'test:integration': 'node -e "setTimeout(() => {}, 4000)"' }, devDependencies: { vitest: '^1' } });
    fs.mkdirSync(path.join(tmp, 'node_modules'), { recursive: true });
    w('src/app.js', "app.post('/users', (req, res) => res.json(req.body));\n");
    w('tests/integration/users.test.js', "test('POST /users', () => {});\n");
    const mod = new IntegrationTestsModule();
    mod._testTimeoutMs = 1500;
    const r = makeResult();
    await mod.run(r, { projectRoot: tmp, getModuleConfig() { return {}; }, get() { return null; } });
    const rc = r.checks.find((x) => x.name === 'integration-tests:run');
    assert.ok(rc && rc.passed && rc.severity === 'info' && /did not finish/.test(rc.message), JSON.stringify(rc));
  });
});
