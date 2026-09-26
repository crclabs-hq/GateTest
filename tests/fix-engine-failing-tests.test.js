'use strict';
/**
 * THE-FIFTY move 8: a failing unit test becomes an actionable fix target for
 * `gatetest fix --apply` / `--auto-pr`, with proof.
 *
 * Control pair, end to end, no live AI calls:
 *   (a) UnitTestsModule attaches file/line/details.failures[] to a real
 *       failing node:test run (the arena's shape: src/math.js + tests/math.test.js,
 *       clamp with swapped bounds).
 *   (b) the fix collector (src/core/fix-collector.js) resolves the TEST
 *       file's own check into a fixable finding targeting the IMPLEMENTATION.
 *   (c) a mocked model returning the correct fix: applied to src/math.js,
 *       the test file untouched, re-verified true.
 *   (d) a mocked model returning a wrong fix: verified false, test untouched.
 *   (e) a mocked model that rewrites the test instead: refused outright.
 */
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const UnitTestsModule = require('../src/modules/unit-tests');
const { collectFixableFindings } = require('../src/core/fix-collector');
const { runFixBatch } = require('../src/core/cli-fix-orchestrator');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) { this.checks.push({ name, passed, ...details }); },
  };
}

const BUGGY_MATH = `'use strict';
function add(a, b) { return a + b; }
function subtract(a, b) { return a - b; }
function multiply(a, b) { return a * b; }
function divide(a, b) { if (b === 0) throw new Error('divide by zero'); return a / b; }
function isPositive(n) { return n > 0; }
// BUG: bounds swapped — clamp(5, 1, 10) returns 1 instead of 5.
function clamp(n, min, max) { return Math.min(min, Math.max(max, n)); }
function uniqueSorted(arr) { return [...new Set(arr)].sort((a, b) => a - b); }
module.exports = { add, subtract, multiply, divide, isPositive, clamp, uniqueSorted };
`;

const CORRECT_CLAMP_MATH = BUGGY_MATH
  .replace('// BUG: bounds swapped — clamp(5, 1, 10) returns 1 instead of 5.\n', '')
  .replace('function clamp(n, min, max) { return Math.min(min, Math.max(max, n)); }',
    'function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }');

const MATH_TEST = `'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { add, subtract, multiply, divide, isPositive, clamp, uniqueSorted } = require('../src/math');

test('add', () => { assert.strictEqual(add(2, 3), 5); });
test('subtract', () => { assert.strictEqual(subtract(5, 3), 2); });
test('multiply', () => { assert.strictEqual(multiply(2, 3), 6); });
test('divide', () => { assert.strictEqual(divide(6, 3), 2); });
test('isPositive', () => { assert.strictEqual(isPositive(5), true); });
test('clamp', () => { assert.strictEqual(clamp(5, 1, 10), 5); });
test('uniqueSorted', () => { assert.deepStrictEqual(uniqueSorted([3, 1, 2, 1]), [1, 2, 3]); });
`;

// A hypothesis "fix" shaped like a rewritten TEST, not an implementation —
// what the model must be refused for proposing (case e).
const TEST_SHAPED_RESPONSE = `'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
test('clamp', () => { assert.ok(true); });
`;

const DELIMS = [
  '=== GATETEST_HYPOTHESIS_ALPHA ===',
  '=== GATETEST_HYPOTHESIS_BETA ===',
  '=== GATETEST_HYPOTHESIS_GAMMA ===',
];

// Same shape as tests/cli-fix-orchestrator.test.js's fakeClaude: the
// injected _callClaude seam returns a plain string (the raw hypothesis
// text), not an Anthropic response object — that parsing happens inside the
// real _callClaude, before orchestration logic ever sees it.
function fakeClaude(code) {
  return async () => [DELIMS[0], code, DELIMS[1], code, DELIMS[2], code].join('\n');
}

function buildFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-failing-test-'));
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.mkdirSync(path.join(tmp, 'tests'));
  fs.writeFileSync(path.join(tmp, 'src', 'math.js'), BUGGY_MATH, 'utf-8');
  fs.writeFileSync(path.join(tmp, 'tests', 'math.test.js'), MATH_TEST, 'utf-8');
  return tmp;
}

describe('failing-test fix engine (THE-FIFTY move 8)', () => {
  let tmp;
  beforeEach(() => { tmp = buildFixture(); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  test('(a) UnitTestsModule attaches file/line/details.failures[] to a real failing run', async () => {
    const mod = new UnitTestsModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp, getModuleConfig() { return {}; } });

    const check = result.checks.find((c) => c.name === 'unit-tests:run');
    assert.ok(check, `expected a unit-tests:run check, got: ${JSON.stringify(result.checks.map((c) => c.name))}`);
    assert.equal(check.passed, false);
    assert.equal(check.severity, 'error');
    assert.equal(check.file, 'tests/math.test.js');
    assert.ok(Array.isArray(check.details.failures) && check.details.failures.length > 0,
      `expected details.failures[], got: ${JSON.stringify(check.details)}`);
    assert.equal(check.details.failures[0].name, 'clamp');
    assert.equal(check.details.failures[0].file, 'tests/math.test.js');
  });

  test('(b) the collector targets the implementation, not the test', async () => {
    const mod = new UnitTestsModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp, getModuleConfig() { return {}; } });
    const check = result.checks.find((c) => c.name === 'unit-tests:run');

    const summary = { results: [{ module: 'unitTests', checks: result.checks }] };
    const { fixable, needsManualReview } = collectFixableFindings(summary, tmp);

    assert.equal(needsManualReview.length, 0, JSON.stringify(needsManualReview));
    const target = fixable.find((f) => f.kind === 'failing-test');
    assert.ok(target, `expected a failing-test fixable entry, got: ${JSON.stringify(fixable)}`);
    assert.equal(target.file, 'src/math.js');
    assert.equal(target.testFile, 'tests/math.test.js');
    assert.equal(target.failures[0].name, 'clamp');
    assert.notEqual(target.file, check.file); // never the test file itself
  });

  test('(c) a correct mocked fix is applied to src/math.js, the test is untouched, verified: true', async () => {
    const mod = new UnitTestsModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp, getModuleConfig() { return {}; } });
    const summary = { results: [{ module: 'unitTests', checks: result.checks }] };
    const { fixable } = collectFixableFindings(summary, tmp);

    const orchestration = await runFixBatch(fixable, tmp, 'test-key', {
      maxAttempts: 1,
      _callClaude: fakeClaude(CORRECT_CLAMP_MATH),
    });

    assert.equal(orchestration.accepted.length, 1, JSON.stringify(orchestration.failed));
    const accepted = orchestration.accepted[0];
    assert.equal(accepted.file, 'src/math.js');
    assert.equal(accepted.result.verified, true, JSON.stringify(accepted.result.verifiedSummary));
    assert.equal(accepted.result.testName, 'clamp');

    // _parseHypotheses trims the model's returned code; compare trimmed.
    assert.equal(fs.readFileSync(path.join(tmp, 'src', 'math.js'), 'utf-8').trim(), CORRECT_CLAMP_MATH.trim());
    assert.equal(fs.readFileSync(path.join(tmp, 'tests', 'math.test.js'), 'utf-8'), MATH_TEST);
  });

  test('(d) a wrong mocked fix reports verified: false, the test is still untouched', async () => {
    const mod = new UnitTestsModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp, getModuleConfig() { return {}; } });
    const summary = { results: [{ module: 'unitTests', checks: result.checks }] };
    const { fixable } = collectFixableFindings(summary, tmp);

    // Syntactically valid, still wrong: clamp untouched, so the test stays red.
    const orchestration = await runFixBatch(fixable, tmp, 'test-key', {
      maxAttempts: 1,
      _callClaude: fakeClaude(BUGGY_MATH),
    });

    assert.equal(orchestration.accepted.length, 1, JSON.stringify(orchestration.failed));
    assert.equal(orchestration.accepted[0].result.verified, false);
    assert.equal(fs.readFileSync(path.join(tmp, 'tests', 'math.test.js'), 'utf-8'), MATH_TEST);
  });

  test('(e) a mocked model that rewrites the test instead is refused', async () => {
    const mod = new UnitTestsModule();
    const result = makeResult();
    await mod.run(result, { projectRoot: tmp, getModuleConfig() { return {}; } });
    const summary = { results: [{ module: 'unitTests', checks: result.checks }] };
    const { fixable } = collectFixableFindings(summary, tmp);

    const orchestration = await runFixBatch(fixable, tmp, 'test-key', {
      maxAttempts: 1,
      _callClaude: fakeClaude(TEST_SHAPED_RESPONSE),
    });

    assert.equal(orchestration.accepted.length, 0);
    assert.equal(orchestration.failed.length, 1);
    assert.equal(orchestration.failed[0].reason, 'test-change proposed');

    // Neither file was touched — the guard fires before anything is written.
    assert.equal(fs.readFileSync(path.join(tmp, 'src', 'math.js'), 'utf-8'), BUGGY_MATH);
    assert.equal(fs.readFileSync(path.join(tmp, 'tests', 'math.test.js'), 'utf-8'), MATH_TEST);
  });
});
