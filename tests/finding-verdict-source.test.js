'use strict';

/**
 * verdictSource — the Fifty, move 14 (complaints C1/C4: "40% of AI review
 * alerts ignored"). Every finding carries `verdictSource`:
 * 'deterministic' | 'model' | 'mixed', set ONCE in
 * `TestResult.addCheck` (src/core/runner.js) from the one module table
 * (src/core/model-judged-modules.js). A model-judged finding never blocks
 * the gate by default; `wouldBlock` on the finding preserves what a
 * stricter policy (`gate.modelVerdictsBlock` / `--model-verdicts-block` /
 * `GATETEST_MODEL_VERDICTS_BLOCK=1`) would have decided.
 *
 * Control pair throughout: a deterministic-module finding and a
 * model-module finding with the IDENTICAL severity/confidence — only the
 * gate's treatment of the second should differ.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { GateTestRunner, TestResult } = require('../src/core/runner');
const { isBlockingFinding } = require('../src/core/confidence');
const { MODEL_JUDGED_MODULES, defaultVerdictSource } = require('../src/core/model-judged-modules');
const { normalizeFindings, summarizeFindings } = require('../src/core/finding-registry');
const { SarifReporter } = require('../src/reporters/sarif-reporter');

function makeTmpProject() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-verdict-source-'));
  fs.writeFileSync(path.join(tmp, 'index.js'), 'module.exports = {};\n', 'utf-8');
  return tmp;
}
function cleanup(tmp) {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* error-ok — Windows handle may still be open */ }
}

/** A finding a module would report — same shape regardless of engine. */
const ERROR_DETAILS = { severity: 'error', confidence: 1.0, message: 'synthetic finding for the control pair' };

function makeErrorModule() {
  return { run: async (result) => { result.addCheck('synthetic:error', false, { ...ERROR_DETAILS }); } };
}

// ─── model-judged-modules.js — the one table ──────────────────────────────

test('model-judged-modules: table matches the modules verified to call the AI client', () => {
  assert.deepStrictEqual(
    [...MODEL_JUDGED_MODULES].sort(),
    ['agentic', 'aiReview', 'architectureDrift', 'intentVerification', 'regressionPredictor'].sort(),
  );
});

test('model-judged-modules: aiHallucination and explorer are NOT model-judged (no anthropic-config require)', () => {
  assert.equal(defaultVerdictSource('aiHallucination'), 'deterministic');
  assert.equal(defaultVerdictSource('explorer'), 'deterministic');
});

test('model-judged-modules: fakeFixDetector is intentionally absent (mixed — tags per finding, see fake-fix-detector.js)', () => {
  assert.equal(MODEL_JUDGED_MODULES.has('fakeFixDetector'), false);
  assert.equal(defaultVerdictSource('fakeFixDetector'), 'deterministic');
});

// ─── TestResult.addCheck — the one place verdictSource is set ─────────────

test('addCheck: a deterministic-named module defaults to verdictSource "deterministic"', () => {
  const result = new TestResult('secrets');
  result.addCheck('secrets:hardcoded-key', false, { severity: 'error', confidence: 1.0 });
  assert.equal(result.checks[0].verdictSource, 'deterministic');
});

test('addCheck: a model-judged module defaults to verdictSource "model"', () => {
  const result = new TestResult('aiReview');
  result.addCheck('aiReview:bug', false, { severity: 'error', confidence: 1.0 });
  assert.equal(result.checks[0].verdictSource, 'model');
});

test('addCheck: an explicit per-finding verdictSource wins over the module default (mixed-module support)', () => {
  const result = new TestResult('fakeFixDetector');
  result.addCheck('fake-fix:ai:x', false, { severity: 'error', confidence: 1.0, verdictSource: 'model' });
  result.addCheck('fake-fix:pattern:y', false, { severity: 'error', confidence: 1.0, verdictSource: 'deterministic' });
  assert.equal(result.checks[0].verdictSource, 'model');
  assert.equal(result.checks[1].verdictSource, 'deterministic');
});

test('addCheck: an invalid explicit verdictSource falls back to the module default rather than being trusted', () => {
  const result = new TestResult('secrets');
  result.addCheck('secrets:x', false, { severity: 'error', confidence: 1.0, verdictSource: 'ai-vibes' });
  assert.equal(result.checks[0].verdictSource, 'deterministic');
});

test('addCheck: wouldBlock is present and confidence-only (ignores verdictSource)', () => {
  const modelResult = new TestResult('aiReview');
  modelResult.addCheck('aiReview:bug', false, { severity: 'error', confidence: 1.0 });
  assert.equal(modelResult.checks[0].wouldBlock, true);

  const softModelResult = new TestResult('aiReview');
  softModelResult.addCheck('aiReview:bug', false, { severity: 'error', confidence: 0.1 });
  assert.equal(softModelResult.checks[0].wouldBlock, false);
});

test('addCheck: model-judged checks never populate softErrorChecks (that bucket stays confidence-only)', () => {
  const result = new TestResult('aiReview', { modelVerdictsBlock: false });
  result.addCheck('aiReview:bug', false, { severity: 'error', confidence: 1.0 }); // policy-excluded, NOT low-confidence
  assert.equal(result.softErrorChecks.length, 0);
  assert.equal(result.modelJudgedChecks.length, 1);
});

test('TestResult.blockingErrorChecks / modelJudgedChecks: control pair at the class level', () => {
  const det = new TestResult('secrets');
  det.addCheck('secrets:x', false, { ...ERROR_DETAILS });
  assert.equal(det.blockingErrorChecks.length, 1);
  assert.equal(det.modelJudgedChecks.length, 0);

  const model = new TestResult('aiReview');
  model.addCheck('aiReview:x', false, { ...ERROR_DETAILS });
  assert.equal(model.blockingErrorChecks.length, 0); // held back by policy, not confidence
  assert.equal(model.modelJudgedChecks.length, 1);
  assert.equal(model.modelJudgedChecks[0].wouldBlock, true);

  const modelStrict = new TestResult('aiReview', { modelVerdictsBlock: true });
  modelStrict.addCheck('aiReview:x', false, { ...ERROR_DETAILS });
  assert.equal(modelStrict.blockingErrorChecks.length, 1);
});

// ─── GateTestRunner — end-to-end control pair ─────────────────────────────

test('GateTestRunner: deterministic module blocks, model module does not, by default', async () => {
  const tmp = makeTmpProject();
  try {
    const runner = new GateTestRunner({ projectRoot: tmp });
    runner.register('secrets', makeErrorModule());
    runner.register('aiReview', makeErrorModule());
    const summary = await runner.run(['secrets', 'aiReview']);

    assert.equal(summary.gateStatus, 'BLOCKED'); // secrets still blocks
    assert.equal(summary.checks.blockingErrors, 1);
    assert.equal(summary.checks.blockingErrorsDeterministic, 1);
    assert.equal(summary.checks.blockingErrorsModelJudged, 0);
    assert.equal(summary.checks.modelJudged, 1);
    assert.equal(summary.checks.modelJudgedWouldBlock, 1); // preserved even though it didn't block
    assert.equal(summary.modelVerdictsBlock, false);
  } finally {
    cleanup(tmp);
  }
});

test('GateTestRunner: --model-verdicts-block (constructor option) makes the model finding block too', async () => {
  const tmp = makeTmpProject();
  try {
    const runner = new GateTestRunner({ projectRoot: tmp }, { modelVerdictsBlock: true });
    runner.register('aiReview', makeErrorModule());
    const summary = await runner.run(['aiReview']);

    assert.equal(summary.gateStatus, 'BLOCKED');
    assert.equal(summary.checks.blockingErrorsModelJudged, 1);
    assert.equal(summary.modelVerdictsBlock, true);
  } finally {
    cleanup(tmp);
  }
});

test('GateTestRunner: GATETEST_MODEL_VERDICTS_BLOCK=1 has the same effect as the flag', async () => {
  const tmp = makeTmpProject();
  const prev = process.env.GATETEST_MODEL_VERDICTS_BLOCK;
  process.env.GATETEST_MODEL_VERDICTS_BLOCK = '1';
  try {
    const runner = new GateTestRunner({ projectRoot: tmp });
    runner.register('aiReview', makeErrorModule());
    const summary = await runner.run(['aiReview']);
    assert.equal(summary.checks.blockingErrorsModelJudged, 1);
    assert.equal(summary.modelVerdictsBlock, true);
  } finally {
    if (prev === undefined) delete process.env.GATETEST_MODEL_VERDICTS_BLOCK;
    else process.env.GATETEST_MODEL_VERDICTS_BLOCK = prev;
    cleanup(tmp);
  }
});

test('GateTestRunner: .gatetest.json gate.modelVerdictsBlock=true has the same effect', async () => {
  const tmp = makeTmpProject();
  try {
    const fakeConfig = { projectRoot: tmp, get: (k) => (k === 'gate.modelVerdictsBlock' ? true : undefined) };
    const runner = new GateTestRunner(fakeConfig);
    runner.register('aiReview', makeErrorModule());
    const summary = await runner.run(['aiReview']);
    assert.equal(summary.checks.blockingErrorsModelJudged, 1);
    assert.equal(summary.modelVerdictsBlock, true);
  } finally {
    cleanup(tmp);
  }
});

test('GateTestRunner: a clean model-only run without the flag PASSES the gate (the customer trust fix)', async () => {
  const tmp = makeTmpProject();
  try {
    const runner = new GateTestRunner({ projectRoot: tmp });
    runner.register('aiReview', makeErrorModule());
    const summary = await runner.run(['aiReview']);
    assert.equal(summary.gateStatus, 'PASSED');
  } finally {
    cleanup(tmp);
  }
});

// ─── finding-registry.js — the ranked, deduped view ────────────────────────

test('normalizeFindings: verdictSource + wouldBlock ride on every finding; blocking respects modelVerdictsBlock', () => {
  // wouldBlock is normally computed by TestResult.addCheck; set explicitly
  // here since these are hand-built raw checks, not run through addCheck.
  const results = [
    { module: 'secrets', checks: [{ name: 'secrets:x', passed: false, wouldBlock: true, ...ERROR_DETAILS }] },
    { module: 'aiReview', checks: [{ name: 'aiReview:x', passed: false, wouldBlock: true, ...ERROR_DETAILS, verdictSource: 'model' }] },
  ];

  const soft = normalizeFindings(results, { threshold: 0.7 });
  const detFinding = soft.find((f) => f.module === 'secrets');
  const modelFinding = soft.find((f) => f.module === 'aiReview');
  assert.equal(detFinding.verdictSource, 'deterministic');
  assert.equal(detFinding.blocking, true);
  assert.equal(modelFinding.verdictSource, 'model');
  assert.equal(modelFinding.wouldBlock, true);
  assert.equal(modelFinding.blocking, false); // policy-excluded by default

  const strict = normalizeFindings(results, { threshold: 0.7, modelVerdictsBlock: true });
  assert.equal(strict.find((f) => f.module === 'aiReview').blocking, true);
});

test('summarizeFindings: modelJudged / modelJudgedWouldBlock counted, never folded into softErrors', () => {
  const results = [
    { module: 'secrets', checks: [{ name: 'secrets:x', passed: false, wouldBlock: true, ...ERROR_DETAILS }] },
    { module: 'aiReview', checks: [{ name: 'aiReview:x', passed: false, wouldBlock: true, ...ERROR_DETAILS, verdictSource: 'model' }] },
  ];
  const findings = normalizeFindings(results, { threshold: 0.7 });
  const s = summarizeFindings(findings);
  assert.equal(s.blocking, 1); // secrets only
  assert.equal(s.softErrors, 0); // the model finding is NOT a confidence-soft error
  assert.equal(s.modelJudged, 1);
  assert.equal(s.modelJudgedWouldBlock, 1);
});

// ─── SARIF — properties.verdictSource ─────────────────────────────────────

test('SARIF: every result carries properties.verdictSource, and blocking respects modelVerdictsBlock', () => {
  const runner = { on() {}, projectRoot: process.cwd() };
  const reporter = new SarifReporter(runner, { projectRoot: process.cwd() });
  const summary = {
    confidenceThreshold: 0.7,
    modelVerdictsBlock: false,
    results: [
      { module: 'secrets', checks: [{ name: 'secrets:x', passed: false, ...ERROR_DETAILS, file: 'a.js', line: 1 }] },
      { module: 'aiReview', checks: [{ name: 'aiReview:x', passed: false, ...ERROR_DETAILS, verdictSource: 'model', file: 'b.js', line: 1 }] },
    ],
  };
  const sarif = reporter._buildSarif(summary);
  const byRule = Object.fromEntries(sarif.runs[0].results.map((r) => [r.ruleId, r]));
  const detResult = byRule['gatetest/secrets/synthetic-error'] || sarif.runs[0].results.find((r) => r.ruleId.includes('secrets'));
  const modelResult = sarif.runs[0].results.find((r) => r.ruleId.includes('aiReview'));

  assert.equal(detResult.properties.verdictSource, 'deterministic');
  assert.equal(detResult.properties.blocking, true);
  assert.equal(modelResult.properties.verdictSource, 'model');
  assert.equal(modelResult.properties.blocking, false);

  const strictSarif = reporter._buildSarif({ ...summary, modelVerdictsBlock: true });
  const strictModelResult = strictSarif.runs[0].results.find((r) => r.ruleId.includes('aiReview'));
  assert.equal(strictModelResult.properties.blocking, true);
});
