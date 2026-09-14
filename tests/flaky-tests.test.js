const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const FlakyTestsModule = require('../src/modules/flaky-tests');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) {
      this.checks.push({ name, passed, ...details });
    },
  };
}

function run(projectRoot) {
  const mod = new FlakyTestsModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('FlakyTestsModule — discovery', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ft-disc-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('skips when no test files exist', async () => {
    write(tmp, 'src/a.js', 'console.log("hi");\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'flaky-tests:no-files'));
  });

  it('discovers *.test.js files', async () => {
    write(tmp, 'src/a.test.js', 'it("x", () => {});\n');
    const r = await run(tmp);
    const scan = r.checks.find((c) => c.name === 'flaky-tests:scanning');
    assert.ok(scan);
    assert.match(scan.message, /1 test file/);
  });

  it('discovers *.spec.ts files', async () => {
    write(tmp, 'src/a.spec.ts', 'it("x", () => {});\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'flaky-tests:scanning'));
  });

  it('discovers files under tests/ directory', async () => {
    write(tmp, 'tests/something.js', 'it("x", () => {});\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'flaky-tests:scanning'));
  });
});

describe('FlakyTestsModule — focus/skip modifiers', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ft-mod-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on it.only', async () => {
    write(tmp, 'a.test.js', 'it.only("x", () => { expect(1).toBe(1); });\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('flaky-tests:only-committed:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('errors on fdescribe', async () => {
    write(tmp, 'a.test.js', 'fdescribe("group", () => { it("x", () => {}); });\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('flaky-tests:only-committed:')));
  });

  it('warns on it.skip', async () => {
    write(tmp, 'a.test.js', 'it.skip("x", () => {});\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('flaky-tests:skip-committed:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('warns on xit', async () => {
    write(tmp, 'a.test.js', 'xit("x", () => {});\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('flaky-tests:skip-committed:')));
  });

  it('emits info on .todo with no linked issue', async () => {
    write(tmp, 'a.test.js', 'it.todo("handles negative zero");\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('flaky-tests:todo-no-issue:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'info');
  });

  it('does NOT flag `.skip` / `.only` embedded in string fixtures', async () => {
    // Regression: fake-fix-detector-style fixtures contain diff lines
    // like `"+  it.skip('rejects invalid tokens', () => {"` — those are
    // string literals, not real test code.
    write(tmp, 'a.test.js', [
      'const fixture = [',
      '  "--- a/tests/auth.test.js",',
      '  "+++ b/tests/auth.test.js",',
      "  \"+  it.skip(\'rejects invalid tokens\', () => {\",",
      "  \"+  it.only(\'debug\', () => {\",",
      '].join("\\n");',
      'it("checks the fixture", () => { expect(fixture).toBeDefined(); });',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('flaky-tests:skip-committed:')),
      undefined,
    );
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('flaky-tests:only-committed:')),
      undefined,
    );
  });

  it('does NOT flag .todo with issue link', async () => {
    write(tmp, 'a.test.js', 'it.todo("handles negative zero — see #456");\n');
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('flaky-tests:todo-no-issue:')),
      undefined,
    );
  });
});

describe('FlakyTestsModule — nondeterminism', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ft-nd-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('does NOT flag a timer, a clock read, an env assignment or a network call that lives inside a string, a template or a comment — and DOES flag the real ones beside them (2026-09-05)', async () => {
    write(tmp, 'a.test.js', [
      "const fixture = \"setTimeout(() => {}, 10); const t = Date.now(); process.env.GHOST = '1';\";",
      'const tpl = `setInterval(() => fetch("https://api.example.com"), 5000)`;',
      '// setTimeout(() => {}, 1000) and Date.now() in a comment',
      '/* process.env.GHOST_BLOCK = "x"; fetch("https://api.example.com/x") */',
      'it("real", (done) => {',
      '  setTimeout(done, 10);',
      '  const t = Date.now();',
      // A VALUE assertion — `toBeGreaterThan(0)` was the control until
      // 2026-09-13, and it is a bound, which the rule now reads as a budget.
      '  expect(t).toBe(1700000000000);',
      '  expect(fixture).toBeDefined(); expect(tpl).toBeDefined();',
      '});',
    ].join('\n') + '\n');
    const r = await run(tmp);
    const names = r.checks.filter((c) => !c.passed).map((c) => c.name);
    assert.deepStrictEqual(names.filter((n) => n.includes(':a.test.js:1') || n.includes(':a.test.js:2') || n.includes(':a.test.js:3') || n.includes(':a.test.js:4')), [], `strings and comments must be silent: ${names.join(', ')}`);
    assert.ok(names.some((n) => n === 'flaky-tests:real-timer:a.test.js:6'), `the real setTimeout must fire: ${names.join(', ')}`);
    assert.ok(names.some((n) => n === 'flaky-tests:real-clock:a.test.js:7'), `the asserted clock read must fire: ${names.join(', ')}`);
    assert.ok(!names.some((n) => n.startsWith('flaky-tests:env-leak:')), 'env assignments in strings are not leaks');
    assert.ok(!names.some((n) => n.startsWith('flaky-tests:real-network:')), 'network calls in strings are not calls');
  });

  it('warns on Math.random() in test', async () => {
    write(tmp, 'a.test.js', [
      'it("picks a number", () => {',
      '  const n = Math.random();',
      '  expect(n).toBeGreaterThan(0);',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('flaky-tests:math-random:')));
  });

  it('warns on Date.now() without fake timers', async () => {
    write(tmp, 'a.test.js', [
      'it("is recent", () => {',
      '  const t = Date.now();',
      // Asserted by VALUE. The control was `toBeGreaterThan(0)` until
      // 2026-09-13 — a bound, which is a budget, not a race (see below).
      '  expect(t).toBe(1700000000000);',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('flaky-tests:real-clock:')));
  });

  // A BOUND on the clock is a performance budget, not a race: it fails
  // when the code regresses, never because the clock moved. Our own
  // scanner reported tests/code-quality.test.js:76 (`elapsed < 5000`) and
  // tests/legal-facts.test.js:149 (`daysLeft > 60`) for it (2026-09-13).
  it('does NOT warn on a clock reading asserted as a bound (a budget)', async () => {
    write(tmp, 'a.test.js', [
      'it("is fast", () => {',
      '  const start = Date.now();',
      '  work();',
      '  const elapsed = Date.now() - start;',
      '  assert.ok(elapsed < 5000, `took ${elapsed}ms`);',
      '  const daysLeft = (new Date(exp) - Date.now()) / 86400000;',
      '  assert.ok(daysLeft > 60);',
      '  expect(Date.now() - start).toBeLessThan(5000);',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.deepStrictEqual(
      r.checks.filter((c) => c.name.startsWith('flaky-tests:real-clock:')).map((c) => c.name),
      [],
    );
  });

  it('DOES warn when a clock value is asserted by value (crosses midnight)', async () => {
    // tests/scan-fix-nuclear-ciso-wire.test.js:217, verbatim shape.
    write(tmp, 'a.test.js', [
      'it("defaults to today", () => {',
      '  const today = new Date().toISOString().slice(0, 10);',
      '  assert.equal(cisoReportPath(), `gatetest-reports/ciso-board-report-${today}.md`);',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'flaky-tests:real-clock:a.test.js:2'));
  });

  it('does NOT warn on Date.now() under node:test mock.timers', async () => {
    write(tmp, 'a.test.js', [
      'it("defaults to today", (t) => {',
      "  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-05-18T12:00:00Z') });",
      '  const today = new Date().toISOString().slice(0, 10);',
      '  assert.equal(cisoReportPath(), `report-${today}.md`);',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.name.startsWith('flaky-tests:real-clock:')), undefined);
  });

  // A random value that no assertion reads cannot flake anything. Nine of
  // this repo's findings were a random suffix on a temp filename
  // (tests/fix-telemetry.test.js:17 and siblings, 2026-09-13).
  it('does NOT warn on Math.random() that only makes a temp name unique', async () => {
    write(tmp, 'a.test.js', [
      'function tmpFile() {',
      '  return path.join(os.tmpdir(), `gt-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);',
      '}',
      'it("writes", () => {',
      '  const f = tmpFile();',
      '  expect(fs.existsSync(f)).toBe(false);',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.name.startsWith('flaky-tests:math-random:')), undefined);
    assert.strictEqual(r.checks.find((c) => c.name.startsWith('flaky-tests:real-clock:')), undefined);
  });

  it('does NOT warn on Date.now() when jest.useFakeTimers is set', async () => {
    write(tmp, 'a.test.js', [
      'beforeEach(() => { jest.useFakeTimers(); });',
      'it("is recent", () => {',
      '  const t = Date.now();',
      '  expect(t).toBeGreaterThan(0);',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('flaky-tests:real-clock:')),
      undefined,
    );
  });
});

describe('FlakyTestsModule — real network', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ft-net-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on fetch() with real URL and no mock', async () => {
    write(tmp, 'a.test.js', [
      'it("hits api", async () => {',
      '  const r = await fetch("https://api.example.com/x");',
      '  expect(r.ok).toBe(true);',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('flaky-tests:real-network:')));
  });

  it('does NOT warn on fetch() when nock is used', async () => {
    write(tmp, 'a.test.js', [
      'const nock = require("nock");',
      'nock("https://api.example.com").get("/x").reply(200, { ok: true });',
      'it("hits api", async () => {',
      '  const r = await fetch("https://api.example.com/x");',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('flaky-tests:real-network:')),
      undefined,
    );
  });

  it('warns on axios.get with real URL and no mock', async () => {
    write(tmp, 'a.test.js', [
      'const axios = require("axios");',
      'it("gets", async () => {',
      '  await axios.get("https://api.stripe.com/v1/charges");',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('flaky-tests:real-network:')));
  });
});

describe('FlakyTestsModule — real timers', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ft-tim-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on setTimeout without fake timers', async () => {
    write(tmp, 'a.test.js', [
      'it("delays", (done) => {',
      '  setTimeout(() => done(), 100);',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('flaky-tests:real-timer:')));
  });

  it('does NOT warn on setTimeout when vi.useFakeTimers is set', async () => {
    write(tmp, 'a.test.js', [
      'beforeEach(() => { vi.useFakeTimers(); });',
      'it("delays", () => {',
      '  setTimeout(() => {}, 100);',
      '  vi.advanceTimersByTime(100);',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('flaky-tests:real-timer:')),
      undefined,
    );
  });

  // ── BOUNDS are not races (2026-09-13) ────────────────────────────────
  // A timeout the test only reaches by hanging changes how a failure is
  // reported, never whether the test passes. Thirteen of this repo's own
  // findings were opened one by one; these are the shapes, verbatim.
  const timerNames = (r) => r.checks.filter((c) => c.name.startsWith('flaky-tests:real-timer:')).map((c) => c.name);

  it('does NOT warn on a timeout whose handle is cleared on the success path', async () => {
    // tests/heavy/mcp-server.test.js:67
    write(tmp, 'a.test.js', [
      'function call(proc) {',
      '  return new Promise((resolve, reject) => {',
      '    const timer = setTimeout(() => {',
      '      proc.kill();',
      '      reject(new Error("timed out"));',
      '    }, 5000);',
      '    proc.stdout.on("data", (chunk) => {',
      '      clearTimeout(timer);',
      '      resolve(chunk);',
      '    });',
      '  });',
      '}',
      '',
    ].join('\n'));
    assert.deepStrictEqual(timerNames(await run(tmp)), []);
  });

  it('does NOT warn on a timeout that only kills / rejects / records timedOut', async () => {
    // tests/heavy/mcp-server.test.js:345 and tests/heavy/mcp-scan-local.test.js:50
    write(tmp, 'a.test.js', [
      'it("exits", () => new Promise((resolve) => {',
      '  setTimeout(() => { proc.kill(); resolve(); }, 5000);',
      '  setTimeout(() => finish({ timedOut: true }), 2000);',
      '  setTimeout(() => done(new Error("hung")), 3000).unref();',
      '}));',
      '',
    ].join('\n'));
    assert.deepStrictEqual(timerNames(await run(tmp)), []);
  });

  it('does NOT warn on a sleep inside a stub handed to the code under test', async () => {
    // tests/empire-smoke.test.js:212 — a timer never fires EARLY, so
    // "sleep 60ms, assert slow > 30ms" is deterministic.
    write(tmp, 'a.test.js', [
      'it("a slow probe warns", async () => {',
      '  const slowFetch = async (url) => {',
      '    await new Promise((r) => setTimeout(r, 60));',
      '    return healthyFetch()(url);',
      '  };',
      '  const report = await runSmoke({ fetch: slowFetch, slowMs: 30 });',
      '  assert.equal(report.status, "yellow");',
      '});',
      '',
    ].join('\n'));
    assert.deepStrictEqual(timerNames(await run(tmp)), []);
  });

  it('does NOT warn on a sleep helper used to poll in a bounded loop', async () => {
    // tests/heavy/mutation-crash-safe-restore.test.js:80
    write(tmp, 'a.test.js', [
      'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));',
      'it("polls", async () => {',
      '  let seen = false;',
      '  for (let i = 0; i < 40; i++) {',
      '    await sleep(500);',
      '    if (fs.existsSync(marker)) { seen = true; break; }',
      '  }',
      '  while (!ready()) await sleep(50);',
      '  assert.ok(seen);',
      '});',
      '',
    ].join('\n'));
    assert.deepStrictEqual(timerNames(await run(tmp)), []);
  });

  it('DOES warn on a sleep followed by an assertion — inline and through a helper', async () => {
    // The load-bearing half. "Wait 250ms and hope the sandbox is gone" is
    // the race; tests/heavy/mutation-crash-safe-restore.test.js:100.
    write(tmp, 'a.test.js', [
      'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));',
      'it("cleans up", async () => {',
      '  child.kill();',
      '  await sleep(250);',
      '  assert.strictEqual(fs.existsSync(sandbox), false);',
      '  await new Promise((resolve) => setTimeout(resolve, 100));',
      '  expect(handler).toHaveBeenCalled();',
      '});',
      '',
    ].join('\n'));
    assert.deepStrictEqual(timerNames(await run(tmp)).sort(), [
      'flaky-tests:real-timer:a.test.js:4',
      'flaky-tests:real-timer:a.test.js:6',
    ]);
  });

  it('DOES warn on a timer that defers the verdict with no bound', async () => {
    write(tmp, 'a.test.js', [
      'it("eventually", (done) => {',
      '  setTimeout(() => { expect(store.count).toBe(1); done(); }, 100);',
      '});',
      '',
    ].join('\n'));
    assert.deepStrictEqual(timerNames(await run(tmp)), ['flaky-tests:real-timer:a.test.js:2']);
  });
});

describe('FlakyTestsModule — process.env leaks', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ft-env-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on process.env mutation with no restore', async () => {
    write(tmp, 'a.test.js', [
      'it("uses env", () => {',
      '  process.env.STRIPE_KEY = "sk_test_123";',
      '  expect(process.env.STRIPE_KEY).toBe("sk_test_123");',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('flaky-tests:env-leak:'));
    assert.ok(hit);
    assert.strictEqual(hit.envVar, 'STRIPE_KEY');
  });

  it('does NOT warn when afterEach restores the env', async () => {
    write(tmp, 'a.test.js', [
      'const orig = process.env.STRIPE_KEY;',
      'afterEach(() => { process.env.STRIPE_KEY = orig; });',
      'it("uses env", () => {',
      '  process.env.STRIPE_KEY = "sk_test_123";',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('flaky-tests:env-leak:')),
      undefined,
    );
  });

  it('does NOT warn when afterEach deletes the env var', async () => {
    write(tmp, 'a.test.js', [
      'afterEach(() => { delete process.env.STRIPE_KEY; });',
      'it("uses env", () => {',
      '  process.env.STRIPE_KEY = "sk_test_123";',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('flaky-tests:env-leak:')),
      undefined,
    );
  });

  // The restore shapes this rule did not know until 2026-09-13 — each one
  // reported as a leak on this repo's own tests.
  const envNames = (r) => r.checks.filter((c) => c.name.startsWith('flaky-tests:env-leak:')).map((c) => c.name);

  it('does NOT warn when a finally block restores the var', async () => {
    // tests/external-integrations-store.test.js:325
    write(tmp, 'a.test.js', [
      'it("fails closed", () => {',
      '  const original = process.env.INTEGRATIONS_SECRET;',
      '  process.env.INTEGRATIONS_SECRET = "";',
      '  try {',
      '    assert.throws(() => encryptToken("x"));',
      '  } finally {',
      '    process.env.INTEGRATIONS_SECRET = original;',
      '  }',
      '});',
      '',
    ].join('\n'));
    assert.deepStrictEqual(envNames(await run(tmp)), []);
  });

  it('does NOT warn when node:test after() / t.after() restores the var', async () => {
    write(tmp, 'a.test.js', [
      'const orig = process.env.GATETEST_ADMIN;',
      'after(() => { process.env.GATETEST_ADMIN = orig; });',
      'it("admin", (t) => {',
      '  process.env.GATETEST_ADMIN = "1";',
      '});',
      '',
    ].join('\n'));
    assert.deepStrictEqual(envNames(await run(tmp)), []);
  });

  it('does NOT warn when the teardown restores by computed key from a saved map', async () => {
    // tests/pr-size.test.js:33-45
    write(tmp, 'a.test.js', [
      'const saved = {};',
      'beforeEach(() => { for (const k of ["GITHUB_BASE_REF"]) { saved[k] = process.env[k]; delete process.env[k]; } });',
      'afterEach(() => {',
      '  for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }',
      '});',
      'it("counts", () => {',
      '  process.env.GITHUB_BASE_REF = "part-1";',
      '});',
      '',
    ].join('\n'));
    assert.deepStrictEqual(envNames(await run(tmp)), []);
  });

  it('does NOT warn when the teardown replaces process.env wholesale', async () => {
    write(tmp, 'a.test.js', [
      'const ORIGINAL_ENV = { ...process.env };',
      'afterAll(() => { process.env = { ...ORIGINAL_ENV }; });',
      'it("x", () => { process.env.NODE_ENV = "production"; });',
      '',
    ].join('\n'));
    assert.deepStrictEqual(envNames(await run(tmp)), []);
  });

  it('DOES warn when the only "after" is a comment', async () => {
    // The restore check runs on the masked source: prose is not a teardown.
    write(tmp, 'a.test.js', [
      '// set after the require so the module sees it',
      'process.env.INTEGRATIONS_SECRET = "test-secret-at-least-32-characters-long";',
      'it("x", () => {});',
      '',
    ].join('\n'));
    assert.deepStrictEqual(envNames(await run(tmp)), ['flaky-tests:env-leak:a.test.js:2:INTEGRATIONS_SECRET']);
  });
});

describe('FlakyTestsModule — self-admitted flakes', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ft-admit-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on test title containing "flaky"', async () => {
    write(tmp, 'a.test.js', 'it("is sometimes flaky in CI", () => {});\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('flaky-tests:self-admitted:'));
    assert.ok(hit);
  });

  it('warns on test title containing "intermittent"', async () => {
    write(tmp, 'a.test.js', 'it("intermittent failure on Windows", () => {});\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('flaky-tests:self-admitted:')));
  });

  it('does NOT warn on a normal title', async () => {
    write(tmp, 'a.test.js', 'it("parses a valid JSON payload", () => {});\n');
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('flaky-tests:self-admitted:')),
      undefined,
    );
  });

  // A title in which flakiness is the SUBJECT — a classifier under test —
  // is not a confession (2026-09-13: tests/ci-doctor-failure-classifier
  // .test.js:148 and tests/replay-plan.test.js:192).
  for (const title of [
    'classifies: flaky timer / timeout test',
    'compareResults — CI failed but local passed → flaky',
    'flags flaky tests in the digest',
  ]) {
    it(`does NOT warn when flakiness is what the test classifies: "${title}"`, async () => {
      write(tmp, 'a.test.js', `test('${title}', () => {});\n`);
      const r = await run(tmp);
      assert.strictEqual(r.checks.find((c) => c.name.startsWith('flaky-tests:self-admitted:')), undefined);
    });
  }

  it('DOES warn on a confession that names no classifier', async () => {
    write(tmp, 'a.test.js', 'test("uploads the report (flaky on Windows)", () => {});\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('flaky-tests:self-admitted:')));
  });
});

describe('FlakyTestsModule — clean baseline', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ft-clean-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('emits zero findings for a well-written test', async () => {
    write(tmp, 'a.test.js', [
      'const { describe, it } = require("node:test");',
      'const assert = require("node:assert");',
      'describe("math", () => {',
      '  it("adds two numbers", () => {',
      '    assert.strictEqual(1 + 2, 3);',
      '  });',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const issues = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(issues.length, 0, `unexpected findings: ${JSON.stringify(issues, null, 2)}`);
  });

  it('records a summary', async () => {
    write(tmp, 'a.test.js', 'it("x", () => {});\n');
    const r = await run(tmp);
    const summary = r.checks.find((c) => c.name === 'flaky-tests:summary');
    assert.ok(summary);
    assert.match(summary.message, /1 file\(s\)/);
  });
});

describe('FlakyTestsModule — real-network is matched outside string literals (PR #431 bot finding)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-flaky-str-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('NEGATIVE: a fixture STRING containing fetch("https://…") is data, not a call', async () => {
    write(tmp, 'prompt-safety.test.js', [
      'it("opens a raw-fetch gateway", async () => {',
      "  write(tmp, 'src/gateway.ts', 'const r = await fetch(\"https://api.openai.com/v1/chat/completions\", { body: JSON.stringify({ model: \"gpt-4o\" }) });\\n');",
      '  const r = await run(tmp);',
      '  assert.ok(r);',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(!r.checks.find((c) => c.name.startsWith('flaky-tests:real-network:')), r.checks.map((c) => c.name).join(', '));
  });

  it('POSITIVE: the same call as code, in the same kind of file, still fires', async () => {
    write(tmp, 'gateway.test.js', [
      'it("hits the gateway", async () => {',
      '  const r = await fetch("https://api.openai.com/v1/chat/completions");',
      '  assert.ok(r.ok);',
      '});',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('flaky-tests:real-network:')));
  });
});
