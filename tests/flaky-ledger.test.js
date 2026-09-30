// =============================================================================
// FLAKY-TEST LEDGER — auto-quarantine, expiry, and the flake rate (launch move 6)
// =============================================================================
// Until this landed the engine knew about flaky tests only through the static
// `flakyTests` module, which reads test SOURCE (it.only, Math.random, a real
// setTimeout race). It could never know whether a test actually flaked, and a
// test that failed once in three runs blocked the gate every third run — the
// exact "retry and merge" culture the module exists to end.
//
// The ledger (src/core/flaky-ledger.js, fed by src/core/test-outcomes.js from
// src/modules/unit-tests.js) records each test's pass/fail per run in
// `.gatetest/memory.json` and quarantines a measured flake: its failure is a
// warning for `quarantineDays`, then it blocks again unless fixed.
//
// Control pairs (Doctrine 3), each with the shape it must not be confused with:
//   fails 10 of 10 runs           -> BLOCKS (that is a failure, not a flake)
//   flips 3 of 10 runs            -> QUARANTINED
//   the same quarantine, 15 days on -> BLOCKS AGAIN (expired)
//   the same flake with --no-quarantine -> BLOCKS
//   a failure the runner output cannot fully account for -> BLOCKS
//   the static `flakyTests` rule still fires on `it.only(`
// =============================================================================

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { parseTestOutcomes } = require('../src/core/test-outcomes');
const ledger = require('../src/core/flaky-ledger');
const persistentMemory = require('../src/core/persistent-memory');
const UnitTestsModule = require('../src/modules/unit-tests');
const FlakyTestsModule = require('../src/modules/flaky-tests');
const { renderBody, renderFlakySection } = require('../scripts/post-scan-summary-comment');
const { checkReportContract } = require('../src/core/report-schema');

const CLI = path.join(__dirname, '..', 'bin', 'gatetest.js');
const DAY = 86400_000;
const CFG = { flips: 2, window: 10, quarantineDays: 14, quarantine: true };

/** A child `node --test` must not think it is a subtest of this run. */
function cleanEnv() { const e = { ...process.env }; delete e.NODE_TEST_CONTEXT; return e; }
function tmpdir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) { this.checks.push({ name, passed, ...details }); },
  };
}
const byName = (result, name) => result.checks.filter((c) => c.name === name);

/** Telemetry consent ON for the duration of a test (the ledger's gate). */
function withConsent(fn) {
  const saved = {
    a: process.env.GATETEST_NO_TELEMETRY, b: process.env.GATETEST_TELEMETRY,
    c: process.env.GATETEST_NO_ARTIFACTS, d: process.env.GATETEST_NO_QUARANTINE,
    e: process.env.GATETEST_REPORT_DIR,
  };
  delete process.env.GATETEST_NO_TELEMETRY;
  delete process.env.GATETEST_NO_ARTIFACTS;
  delete process.env.GATETEST_NO_QUARANTINE;
  delete process.env.GATETEST_REPORT_DIR;
  process.env.GATETEST_TELEMETRY = '1';
  const restore = () => {
    const put = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    put('GATETEST_NO_TELEMETRY', saved.a); put('GATETEST_TELEMETRY', saved.b);
    put('GATETEST_NO_ARTIFACTS', saved.c); put('GATETEST_NO_QUARANTINE', saved.d);
    put('GATETEST_REPORT_DIR', saved.e);
  };
  return Promise.resolve().then(fn).finally(restore);
}

// ── 1. The outcome parser, against what node:test really prints ──────────────

describe('parseTestOutcomes — real node:test output, both reporters', () => {
  let root;
  const NESTED = [
    "const { test, describe } = require('node:test');",
    "const assert = require('node:assert');",
    "describe('suite', () => {",
    "  test('inner ok', () => {});",
    "  test('inner bad', () => { assert.strictEqual(1, 2); });",
    "  test('parent', async (t) => {",
    "    await t.test('child bad', () => { assert.fail('x'); });",
    "    await t.test('child ok', () => {});",
    '  });',
    '});',
    "test('top skip', { skip: true }, () => {});",
    "test('top ok', () => {});",
    '',
  ].join('\n');

  before(() => { root = tmpdir('gt-outcomes-'); write(root, 'nested.test.js', NESTED); });
  after(() => { fs.rmSync(root, { recursive: true, force: true }); });

  function run(reporter) {
    const r = spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`, 'nested.test.js'], {
      cwd: root, encoding: 'utf8', env: cleanEnv(),
    });
    delete r.env;
    return `${r.stdout}${r.stderr}`;
  }

  for (const reporter of ['tap', 'spec']) {
    it(`${reporter}: leaves, containers, skips and the completeness proof`, () => {
      const parsed = parseTestOutcomes(run(reporter));
      assert.strictEqual(parsed.format, reporter);
      const leaves = parsed.outcomes.filter((o) => !o.container);
      const names = (ok) => leaves.filter((o) => o.ok === ok).map((o) => o.path.join(' > ')).sort();
      assert.deepStrictEqual(names(false), ['suite > inner bad', 'suite > parent > child bad']);
      assert.deepStrictEqual(names(true), ['suite > inner ok', 'suite > parent > child ok', 'top ok']);
      assert.ok(!parsed.outcomes.some((o) => o.name === 'top skip'), 'a skipped test is neither a pass nor a fail');
      const failedContainers = parsed.outcomes.filter((o) => o.container && !o.ok).map((o) => o.name).sort();
      assert.deepStrictEqual(failedContainers, ['parent', 'suite']);
      assert.strictEqual(parsed.complete, true, parsed.incompleteReason);
    });
  }

  it('control: a run the parser cannot fully account for is not complete (it must never downgrade a failure)', () => {
    // A before-hook that throws fails the container without any failing test in it.
    write(root, 'hook.test.js', [
      "const { test, describe, before } = require('node:test');",
      "describe('h', () => { before(() => { throw new Error('boom'); }); test('t', () => {}); });",
      '',
    ].join('\n'));
    for (const reporter of ['tap', 'spec']) {
      const r = spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`, 'hook.test.js'], { cwd: root, encoding: 'utf8', env: cleanEnv() });
      const parsed = parseTestOutcomes(`${r.stdout}${r.stderr}`);
      assert.strictEqual(parsed.format, reporter, 'the fixture must be read before it can be judged incomplete');
      assert.strictEqual(parsed.complete, false, `${reporter}: ${JSON.stringify(parsed.outcomes)}`);
    }
  });

  it('control: another runner\'s output is not read at all (three-state, not a guess)', () => {
    const jest = ' FAIL  src/a.test.js\n  ✕ adds (3 ms)\n\nTests:       1 failed, 2 passed, 3 total\n';
    const parsed = parseTestOutcomes(jest);
    assert.strictEqual(parsed.format, null);
    assert.strictEqual(parsed.outcomes.length, 0);
    assert.strictEqual(parsed.complete, false);
  });
});

// ── 2. The verdict, as a pure function ───────────────────────────────────────

describe('classify — the flake verdict', () => {
  const NOW = Date.UTC(2026, 8, 30);
  const h = (s) => s.split('').map((c) => `${c}`).join(' '); // 'pfp' -> 'p f p'

  it('fails 10 of 10 runs: NOT flaky, never quarantined (a real failure, Doctrine 1)', () => {
    const v = ledger.classify({ h: h('ffffffffff') }, CFG, NOW);
    assert.strictEqual(v.flaky, false);
    assert.strictEqual(v.quarantined, false);
    assert.strictEqual(v.allFailed, true);
  });

  it('flips 3 of the last 10 runs: flaky and quarantined', () => {
    // Exactly three flips in ten runs, ending red: p p p p p f p f f f (p->f, f->p, p->f).
    const three = ledger.classify({ h: h('pppppfpfff') }, CFG, NOW);
    assert.strictEqual(three.flips, 3);
    assert.strictEqual(three.runs, 10);
    assert.strictEqual(three.flaky, true);
    assert.strictEqual(three.quarantined, true);
    const many = ledger.classify({ h: h('pppfppfpfp') }, CFG, NOW);
    assert.ok(many.flips > 3);
    assert.strictEqual(many.quarantined, true);
  });

  it('one flip is a regression or a fix, not a flake', () => {
    const v = ledger.classify({ h: h('ppppppppff') }, CFG, NOW);
    assert.strictEqual(v.flips, 1);
    assert.strictEqual(v.flaky, false);
  });

  it('passed and failed on the same commit: flaky at once, with no second flip needed', () => {
    const v = ledger.classify({ h: 'pabc1234 fabc1234' }, CFG, NOW);
    assert.strictEqual(v.sameCommit, true);
    assert.strictEqual(v.flaky, true);
    const otherCommits = ledger.classify({ h: 'pabc1234 fdef5678' }, CFG, NOW);
    assert.strictEqual(otherCommits.flaky, false, 'a pass then a fail on DIFFERENT commits is one flip, not a flake');
  });

  it('flips older than the window do not count', () => {
    const v = ledger.classify({ h: `${h('pfpf')}${' p'.repeat(10)}`.trim() }, CFG, NOW);
    assert.strictEqual(v.flaky, false);
  });

  it('quarantine expires: flagged 15 days ago -> blocks again; 13 days ago -> still quarantined', () => {
    const entry = (ago) => ({ h: h('pfpfpf'), since: NOW - ago * DAY });
    const fresh = ledger.classify(entry(13), CFG, NOW);
    assert.strictEqual(fresh.quarantined, true);
    assert.strictEqual(fresh.expired, false);
    const old = ledger.classify(entry(15), CFG, NOW);
    assert.strictEqual(old.flaky, true);
    assert.strictEqual(old.expired, true);
    assert.strictEqual(old.quarantined, false);
  });

  it('quarantine can be switched off and the test is still measured flaky', () => {
    const v = ledger.classify({ h: h('pfpfpf') }, { ...CFG, quarantine: false }, NOW);
    assert.strictEqual(v.flaky, true);
    assert.strictEqual(v.quarantined, false);
  });

  it('thresholds come from .gatetest.json `flaky` and clamp to sane values', () => {
    const cfgOf = (flaky) => ledger.resolveFlakyConfig({ get: (k) => (k.startsWith('flaky.') ? flaky[k.slice(6)] : undefined) }, {});
    assert.deepStrictEqual(cfgOf({}), CFG);
    assert.deepStrictEqual(cfgOf({ flips: 3, window: 20, quarantineDays: 7 }), { flips: 3, window: 20, quarantineDays: 7, quarantine: true });
    assert.strictEqual(cfgOf({ quarantine: false }).quarantine, false);
    assert.strictEqual(cfgOf({ window: 'x', flips: -4 }).window, 10);
    assert.strictEqual(ledger.resolveFlakyConfig(null, { GATETEST_NO_QUARANTINE: '1' }).quarantine, false);
    assert.strictEqual(ledger.resolveFlakyConfig(null, { GATETEST_NO_QUARANTINE: '0' }).quarantine, true);
  });
});

// ── 3. The ledger on disk ────────────────────────────────────────────────────

describe('recordRun — .gatetest/memory.json', () => {
  let root;
  beforeEach(() => { root = tmpdir('gt-ledger-'); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const parsedOf = (specs) => ({
    format: 'tap', complete: true, summary: {},
    outcomes: specs.map(([name, ok]) => ({ path: [name], name, ok, container: false, testFailure: !ok, file: null, line: null })),
  });

  it('records outcomes, tracks only tests that have failed, and never stores a test name', () => {
    const NOW = Date.UTC(2026, 8, 30);
    ledger.recordRun(root, parsedOf([['secret customer test name', false], ['steady', true]]), { cfg: CFG, now: NOW, commit: 'aaaaaaa' });
    ledger.recordRun(root, parsedOf([['secret customer test name', true], ['steady', true]]), { cfg: CFG, now: NOW + 1, commit: 'bbbbbbb' });
    const raw = fs.readFileSync(path.join(root, '.gatetest', 'memory.json'), 'utf8');
    assert.ok(!raw.includes('secret customer test name'), 'the memory file must carry no test names');
    assert.ok(!raw.includes('steady'));
    const mem = JSON.parse(raw);
    assert.strictEqual(mem.flakyLedger.runs, 2);
    const key = ledger.testKey(['secret customer test name']);
    assert.strictEqual(mem.flakyLedger.tests[key].h, 'faaaaaaa pbbbbbbb');
    assert.strictEqual(Object.keys(mem.flakyLedger.tests).length, 1, 'a test that never failed is not tracked');
    assert.strictEqual(mem.flakyLedger.lastRun.tests, 2);
  });

  it('a same-named test that passes AND fails inside one run is ambiguous: not recorded, not quarantinable', () => {
    const parsed = parsedOf([['dup', true], ['dup', false]]);
    const rec = ledger.recordRun(root, parsed, { cfg: CFG, now: 1, commit: 'aaaaaaa' });
    assert.ok(rec.ambiguous.has(ledger.testKey(['dup'])));
    assert.strictEqual(rec.verdicts.size, 0);
  });

  it('a harness failure (hook, crash) is not a verdict on the test and is not recorded', () => {
    const parsed = parsedOf([['t', false]]);
    parsed.outcomes[0].testFailure = false;
    ledger.recordRun(root, parsed, { cfg: CFG, now: 1, commit: 'aaaaaaa' });
    const mem = persistentMemory.load(root);
    assert.deepStrictEqual(Object.keys((mem.flakyLedger || { tests: {} }).tests), []);
  });

  it('flake rate: flaky tests over the tests the last run saw; not measured before any run', () => {
    assert.strictEqual(ledger.readFlakeSummary(root, CFG).measured, false);
    assert.strictEqual(ledger.readFlakeSummary(root, CFG).rate, null);
    const NOW = Date.UTC(2026, 8, 30);
    const seq = [false, true, false, true];
    seq.forEach((ok, i) => ledger.recordRun(root, parsedOf([['flip', ok], ['a', true], ['b', true], ['c', true]]), { cfg: CFG, now: NOW + i, commit: `c${i}00000`.slice(0, 7) }));
    const s = ledger.readFlakeSummary(root, CFG, NOW + 10);
    assert.strictEqual(s.measured, true);
    assert.strictEqual(s.tests, 4);
    assert.strictEqual(s.flakyTests, 1);
    assert.strictEqual(s.rate, 25);
    assert.strictEqual(s.quarantined, 1);
  });

  it('a test that is healthy again for a full window drops out of the ledger (the flake was fixed)', () => {
    const NOW = Date.UTC(2026, 8, 30);
    [false, true, false, true].forEach((ok, i) => ledger.recordRun(root, parsedOf([['flip', ok]]), { cfg: CFG, now: NOW + i, commit: null }));
    assert.strictEqual(ledger.readFlakeSummary(root, CFG, NOW + 5).flakyTests, 1);
    for (let i = 0; i < 10; i++) ledger.recordRun(root, parsedOf([['flip', true]]), { cfg: CFG, now: NOW + 10 + i, commit: null });
    const s = ledger.readFlakeSummary(root, CFG, NOW + 40);
    assert.strictEqual(s.flakyTests, 0);
    assert.deepStrictEqual(Object.keys(persistentMemory.load(root).flakyLedger.tests), []);
  });
});

// ── 4. End to end through the unit-test module, on a real suite ──────────────

describe('UnitTestsModule — quarantine end to end', () => {
  let root;
  const SAVED = {};
  beforeEach(() => {
    root = tmpdir('gt-quarantine-');
    // GT_FLIP drives the one test that flakes; 'always red' and 'steady' are the controls.
    write(root, 'tests/suite.test.js', [
      "const { test } = require('node:test');",
      "const assert = require('node:assert');",
      "test('flip me', () => { assert.strictEqual(process.env.GT_FLIP, 'pass'); });",
      "test('always red', () => { assert.strictEqual(1, 2); });",
      "test('steady', () => {});",
      '',
    ].join('\n'));
    SAVED.flip = process.env.GT_FLIP;
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    if (SAVED.flip === undefined) delete process.env.GT_FLIP; else process.env.GT_FLIP = SAVED.flip;
  });

  async function runOnce(mod, flip, config = { projectRoot: root, getModuleConfig() { return {}; } }) {
    process.env.GT_FLIP = flip;
    const result = makeResult();
    await mod.run(result, config);
    return result;
  }
  const runCheck = (result) => byName(result, 'unit-tests:run')[0];

  it('control: fails 10 of 10 runs -> still BLOCKS, never quarantined', () => withConsent(async () => {
    const mod = new UnitTestsModule();
    mod._nowMs = Date.UTC(2026, 8, 1);
    let last;
    for (let i = 0; i < 4; i++) { mod._nowMs += 1000; last = await runOnce(mod, 'fail'); }
    // 4 runs here stand in for 10: the verdict does not depend on the count, only on "no pass, no flip".
    assert.strictEqual(runCheck(last).passed, false);
    assert.strictEqual(runCheck(last).severity, 'error');
    assert.strictEqual(byName(last, 'unit-tests:quarantined-flaky').length, 0);
    const led = byName(last, 'unit-tests:flake-ledger')[0];
    assert.deepStrictEqual(led.flaky, []);
  }));

  it('flips 3 of the last runs -> the flaky test is quarantined (warning), the always-red test still blocks', () => withConsent(async () => {
    const mod = new UnitTestsModule();
    mod._nowMs = Date.UTC(2026, 8, 1);
    let last;
    for (const flip of ['fail', 'pass', 'fail', 'pass', 'fail']) { mod._nowMs += 1000; last = await runOnce(mod, flip); }
    // 'always red' fails every run, so the run as a whole must still block on it.
    assert.strictEqual(runCheck(last).passed, false, 'the always-red test keeps the run red');
    assert.match(runCheck(last).message, /always red/);
    const q = byName(last, 'unit-tests:quarantined-flaky');
    assert.strictEqual(q.length, 1);
    assert.strictEqual(q[0].passed, false);
    assert.strictEqual(q[0].severity, 'warning');
    assert.match(q[0].message, /^quarantined flaky test \(flipped 4 of last 5 runs\): flip me/);
    assert.strictEqual(q[0].quarantine.state, 'quarantined');
    const flaky = byName(last, 'unit-tests:flake-ledger')[0].flaky;
    assert.deepStrictEqual(flaky.map((f) => f.name), ['flip me']);
    assert.ok(!flaky.some((f) => f.name === 'always red'));
  }));

  it('flake only (the always-red test removed): the run passes with a quarantine warning; it blocks again after expiry', () => withConsent(async () => {
    write(root, 'tests/suite.test.js', [
      "const { test } = require('node:test');",
      "const assert = require('node:assert');",
      "test('flip me', () => { assert.strictEqual(process.env.GT_FLIP, 'pass'); });",
      "test('steady', () => {});",
      '',
    ].join('\n'));
    const mod = new UnitTestsModule();
    const T0 = Date.UTC(2026, 8, 1);
    mod._nowMs = T0;
    let last;
    for (const flip of ['fail', 'pass', 'fail', 'pass', 'fail']) { mod._nowMs += 1000; last = await runOnce(mod, flip); }
    assert.strictEqual(runCheck(last).passed, true, JSON.stringify(runCheck(last)));
    assert.match(runCheck(last).message, /passed apart from 1 quarantined flaky test/);
    assert.strictEqual(byName(last, 'unit-tests:quarantined-flaky').length, 1);
    assert.ok(byName(last, 'unit-tests:quarantined-flaky')[0].quarantine.daysLeft >= 13);

    // 15 days later the same failing flake blocks again.
    mod._nowMs = T0 + 15 * DAY;
    last = await runOnce(mod, 'fail');
    assert.strictEqual(runCheck(last).passed, false);
    assert.strictEqual(runCheck(last).severity, 'error');
    assert.match(runCheck(last).message, /flip me.*quarantine expired/);
    assert.strictEqual(byName(last, 'unit-tests:quarantined-flaky').length, 0);
    const entry = byName(last, 'unit-tests:flake-ledger')[0].flaky[0];
    assert.strictEqual(entry.state, 'expired');
  }));

  it('--no-quarantine (GATETEST_NO_QUARANTINE) turns the downgrade off; the flake is still measured', () => withConsent(async () => {
    write(root, 'tests/suite.test.js', [
      "const { test } = require('node:test');",
      "const assert = require('node:assert');",
      "test('flip me', () => { assert.strictEqual(process.env.GT_FLIP, 'pass'); });",
      '',
    ].join('\n'));
    process.env.GATETEST_NO_QUARANTINE = '1';
    const mod = new UnitTestsModule();
    mod._nowMs = Date.UTC(2026, 8, 1);
    let last;
    for (const flip of ['fail', 'pass', 'fail', 'pass', 'fail']) { mod._nowMs += 1000; last = await runOnce(mod, flip); }
    assert.strictEqual(runCheck(last).passed, false);
    assert.strictEqual(byName(last, 'unit-tests:quarantined-flaky').length, 0);
    assert.strictEqual(byName(last, 'unit-tests:flake-ledger')[0].flaky[0].state, 'off');
  }));

  it('same commit, both outcomes: quarantined on the second run, no second flip needed', () => withConsent(async () => {
    write(root, 'tests/suite.test.js', [
      "const { test } = require('node:test');",
      "const assert = require('node:assert');",
      "test('flip me', () => { assert.strictEqual(process.env.GT_FLIP, 'pass'); });",
      '',
    ].join('\n'));
    const mod = new UnitTestsModule();
    mod._nowMs = Date.UTC(2026, 8, 1);
    mod._commitOverride = 'abc1234';
    await runOnce(mod, 'pass');
    mod._nowMs += 1000;
    const failed = await runOnce(mod, 'fail');
    // A passing test is not tracked until it fails, so the failure above is the first
    // record (no history: it blocks). The next pass on the same commit completes the pair.
    mod._nowMs += 1000;
    const passed = await runOnce(mod, 'pass');
    mod._nowMs += 1000;
    const again = await runOnce(mod, 'fail');
    assert.strictEqual(runCheck(failed).passed, false, 'first ever failure has no history: it blocks');
    assert.strictEqual(runCheck(passed).passed, true);
    assert.strictEqual(runCheck(again).passed, true, JSON.stringify(runCheck(again)));
    assert.strictEqual(byName(again, 'unit-tests:quarantined-flaky')[0].quarantine.sameCommit, true);
  }));

  it('consent off (GATETEST_NO_TELEMETRY): nothing is recorded, every failure blocks, and the report says "not measured"', async () => {
    const saved = process.env.GATETEST_NO_TELEMETRY;
    process.env.GATETEST_NO_TELEMETRY = '1';
    try {
      const mod = new UnitTestsModule();
      const result = await runOnce(mod, 'fail');
      assert.strictEqual(runCheck(result).passed, false);
      assert.ok(!fs.existsSync(path.join(root, '.gatetest', 'memory.json')), 'no ledger may be written without consent');
      const led = byName(result, 'unit-tests:flake-ledger')[0];
      assert.strictEqual(led.flake.measured, false);
      assert.strictEqual(led.flake.rate, null);
      assert.match(led.message, /not measured — telemetry consent is off/);
    } finally {
      if (saved === undefined) delete process.env.GATETEST_NO_TELEMETRY; else process.env.GATETEST_NO_TELEMETRY = saved;
    }
  });

  it('a runner whose output is not per-test readable says "not measured" and quarantines nothing', () => withConsent(async () => {
    const mod = new UnitTestsModule();
    const state = mod._flakyLedger(root, { get: () => undefined }, ' FAIL a.test.js\n  ✕ adds\nTests: 1 failed, 1 total\n');
    assert.strictEqual(state.state, 'unreadable');
    const split = mod._splitQuarantined(state, [{ name: 'adds' }]);
    assert.strictEqual(split.allQuarantined, false);
    assert.deepStrictEqual(split.blockingFailures, [{ name: 'adds' }]);
  }));

  it('control: the static flakyTests rule still fires on the source shape (it.only)', async () => {
    write(root, 'tests/only.test.js', "it.only('focus', () => {});\n");
    const result = makeResult();
    await new FlakyTestsModule().run(result, {
      projectRoot: root,
      getModuleConfig() { return {}; },
      get() { return undefined; },
    });
    assert.ok(result.checks.some((c) => /^flaky-tests:only-committed/.test(c.name) && c.passed === false), JSON.stringify(result.checks.map((c) => c.name)));
  });
});

// ── 5. The CLI: exit code, JSON `flaky[]`, --no-quarantine ────────────────────

describe('CLI — flaky[] in the JSON report, exit code, --no-quarantine', () => {
  let root; let home;
  before(() => {
    root = tmpdir('gt-flaky-cli-');
    home = tmpdir('gt-flaky-home-');
    write(root, 'tests/suite.test.js', [
      "const { test } = require('node:test');",
      "const assert = require('node:assert');",
      "test('flip me', () => { assert.strictEqual(1, 2); });",
      "test('steady', () => {});",
      '',
    ].join('\n'));
    // A ledger that already measured 'flip me' as flaky, flagged just now.
    const key = ledger.testKey(['flip me']);
    persistentMemory.save(root, Object.assign(persistentMemory.load(root), {
      flakyLedger: {
        version: 1, runs: 6, lastRun: { at: new Date().toISOString(), tests: 2, commit: null, flaky: 1 },
        tests: { [key]: { h: 'p f p f p', since: Date.now() - DAY, lastSeen: Date.now() - 1000 } },
      },
    }));
  });
  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  function scan(extra = []) {
    const env = { ...process.env, HOME: home, USERPROFILE: home, GATETEST_TELEMETRY: '1', GATETEST_ADMIN: '', GATETEST_TELEMETRY_URL: 'http://127.0.0.1:9/never' };
    delete env.GATETEST_NO_TELEMETRY; delete env.GATETEST_NO_ARTIFACTS; delete env.NODE_TEST_CONTEXT; delete env.GATETEST_NO_QUARANTINE;
    const r = spawnSync(process.execPath, [CLI, '--module', 'unitTests', '--project', root, '--format', 'json', ...extra], { env, encoding: 'utf8', timeout: 120000 });
    let doc = null;
    try { doc = JSON.parse(r.stdout); } catch { /* asserted by callers */ }
    return { status: r.status, doc, raw: r.stdout, err: r.stderr };
  }

  it('the flake is quarantined: exit 0, `flaky[]` lists it, `flake` carries the rate', () => {
    const { status, doc, raw, err } = scan();
    assert.ok(doc, `no JSON: ${raw}\n${err}`);
    assert.strictEqual(status, 0, raw);
    assert.strictEqual(doc.flaky.length, 1);
    assert.strictEqual(doc.flaky[0].state, 'quarantined');
    assert.strictEqual(doc.flaky[0].name, 'flip me');
    assert.ok(doc.flake && doc.flake.measured === true);
    assert.ok(doc.issues.some((i) => /quarantined flaky test \(flipped/.test(i.message)), JSON.stringify(doc.issues.map((i) => i.message)));
    assert.ok(!doc.issues.some((i) => i.blocking), 'nothing blocks');
  });

  it('control: --no-quarantine on the same repo blocks on the same failure', () => {
    const { status, doc } = scan(['--no-quarantine']);
    assert.strictEqual(status, 1);
    assert.strictEqual(doc.flaky[0].state, 'off');
    assert.ok(doc.issues.some((i) => i.blocking && /flip me/.test(i.message)));
  });

  it('the on-disk report satisfies the schema contract with flaky / summary.flake present', () => {
    scan();
    const report = JSON.parse(fs.readFileSync(path.join(root, '.gatetest', 'reports', 'gatetest-report-latest.json'), 'utf8'));
    const { ok, missing } = checkReportContract(report);
    assert.ok(ok, `missing: ${missing.join(', ')}`);
    assert.ok(Array.isArray(report.flaky));
    assert.ok('flake' in report.summary);
  });
});

// ── 6. The PR comment ─────────────────────────────────────────────────────────

describe('PR comment — Flaky tests section', () => {
  const grade = { grade: 'A', score: 95, passed: 10, total: 10, errors: 0, warnings: 1, findings: [] };
  const flaky = [
    { name: 'flip me', file: 'tests/a.test.js', line: 3, state: 'quarantined', flips: 3, runs: 10, expiresAt: '2026-10-14T00:00:00.000Z' },
    { name: 'stale one', state: 'expired', flips: 4, runs: 10, expiresAt: '2026-09-01T00:00:00.000Z' },
  ];

  it('lists each flaky test with its flips, its status and when the quarantine ends', () => {
    const body = renderBody({ grade, runUrl: 'https://example.test/run', overrides: [], flaky, flake: { measured: true, rate: 2.5 } });
    assert.match(body, /Flaky tests \(2, 1 quarantined · flake rate 2\.5%\)/);
    assert.match(body, /`flip me`.*flipped 3 of last 10 runs; quarantined, warning only — ends 2026-10-14/);
    assert.match(body, /`stale one`.*quarantine expired 2026-09-01 — blocking/);
  });

  it('control: no flaky tests -> no section at all', () => {
    assert.deepStrictEqual(renderFlakySection([], null), []);
    const body = renderBody({ grade, runUrl: 'https://example.test/run', overrides: [] });
    assert.doesNotMatch(body, /Flaky tests/);
  });
});
