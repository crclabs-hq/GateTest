// =============================================================================
// BUDGET-TRACKER ENGINE TWIN — src/core/budget-tracker.js
// =============================================================================
// The hosted tracker (website/app/lib/budget-tracker.js) is not shipped in the
// npm package (`files` is bin/ src/ lib/), so the CLI, the local MCP server and
// the editor extension had no price table and could not tell a BYOK user what
// a fix cost. The engine twin carries the same table. This file pins:
//   1. the two price tables and the chars/token ratio agree (twin sync),
//   2. the cap aborts before the NEXT call, pricing each call at its model,
//   3. estimateFixCost is driven by the orchestrator's exported request shape
//      and refuses to run on an invented one.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const engine = require(path.join(ROOT, 'src', 'core', 'budget-tracker.js'));
const hosted = require(path.join(ROOT, 'website', 'app', 'lib', 'budget-tracker.js'));
const { FIX_CALL_SHAPE } = require(path.join(ROOT, 'src', 'core', 'cli-fix-orchestrator.js'));
const { allowedModelIds, FIX_DEPTHS } = require(path.join(ROOT, 'src', 'core', 'engine-models.js'));
const webModels = require(path.join(ROOT, 'website', 'app', 'lib', 'engine-models.js'));

describe('budget-tracker engine twin: agrees with the hosted table', () => {
  it('has the same model rows and rates as website/app/lib/budget-tracker.js', () => {
    assert.deepEqual(Object.keys(engine.MODEL_PRICING).sort(), Object.keys(hosted.MODEL_PRICING).sort());
    for (const id of Object.keys(hosted.MODEL_PRICING)) {
      assert.deepEqual(engine.MODEL_PRICING[id], hosted.MODEL_PRICING[id], `rate for ${id}`);
    }
    assert.equal(engine.CHARS_PER_TOKEN, hosted.CHARS_PER_TOKEN);
    assert.equal(engine.INPUT_USD_PER_MTOK, hosted.INPUT_USD_PER_MTOK);
    assert.equal(engine.OUTPUT_USD_PER_MTOK, hosted.OUTPUT_USD_PER_MTOK);
  });

  it('prices every model on the user allow-list — no --model choice is priced by guesswork', () => {
    for (const id of allowedModelIds()) {
      assert.equal(engine.hasKnownPrice(id), true, `${id} needs a row in MODEL_PRICING`);
    }
    for (const [depth, d] of Object.entries(FIX_DEPTHS)) {
      assert.equal(engine.hasKnownPrice(d.model), true, `fix depth ${depth} needs a priced model`);
    }
  });

  it('the editor depth table is the same in both engine-models twins and only ever maps onto the allow-list', () => {
    assert.deepEqual(webModels.FIX_DEPTHS, FIX_DEPTHS);
    assert.deepEqual(Object.keys(FIX_DEPTHS), ['standard', 'deep']);
    for (const d of Object.values(FIX_DEPTHS)) assert.ok(allowedModelIds().includes(d.model), d.model);
  });

  it('prices an unknown id at the most expensive known rate and an untagged call at the default', () => {
    assert.deepEqual(engine.priceFor('some-new-model'), hosted.priceFor('some-new-model'));
    assert.deepEqual(engine.priceFor(''), { input: engine.INPUT_USD_PER_MTOK, output: engine.OUTPUT_USD_PER_MTOK });
    assert.equal(engine.hasKnownPrice('some-new-model'), false);
  });

  it('estimateTokens matches the hosted twin on the same text', () => {
    for (const t of ['', 'abc', 'x'.repeat(1000), 'const a = 1;\n'.repeat(40)]) {
      assert.equal(engine.estimateTokens(t), hosted.estimateTokens(t));
    }
  });
});

describe('budget-tracker engine twin: BudgetTracker', () => {
  const response = (input_tokens, output_tokens, text = 'ok') => ({ data: { usage: { input_tokens, output_tokens }, content: [{ text }] } });

  it('uses exact usage when present and prices the call at the model that ran it', () => {
    const t = new engine.BudgetTracker({ maxUsd: 10 });
    const r = t.record('{}', response(1000, 500), 'claude-fable-5');
    assert.deepEqual(r, { inputTokens: 1000, outputTokens: 500, exact: true });
    assert.equal(t.estimatedUsd(), (1000 / 1e6) * 10 + (500 / 1e6) * 50);
    assert.equal(t.snapshot().callCount, 1);
  });

  it('falls back to a char estimate — flagged inexact — when the provider returns no usage', () => {
    const t = new engine.BudgetTracker({ maxUsd: 10 });
    const r = t.record('x'.repeat(300), { data: { content: [{ text: 'y'.repeat(60) }] } }, 'claude-sonnet-5');
    assert.deepEqual(r, { inputTokens: 100, outputTokens: 20, exact: false });
  });

  it('aborts on the NEXT preflight once the USD cap is crossed, with a snapshot on the error', () => {
    const t = new engine.BudgetTracker({ maxUsd: 0.01 });
    t.preflight(); // nothing spent yet
    t.record('{}', response(1000, 1000), 'claude-sonnet-5'); // $0.003 + $0.015 = $0.018 > cap
    assert.equal(t.aborted, true);
    assert.match(t.abortReason, /usd cap exceeded/);
    assert.throws(() => t.preflight(), (err) => {
      assert.equal(err.code, 'BUDGET_EXCEEDED');
      assert.match(err.message, /^AI provider budget exhausted: usd cap exceeded/);
      assert.equal(err.tracker.aborted, true);
      return true;
    });
  });

  it('no cap means Infinity — record() never aborts', () => {
    const t = new engine.BudgetTracker();
    t.record('{}', response(5_000_000, 5_000_000), 'claude-fable-5');
    assert.equal(t.aborted, false);
    t.preflight();
  });
});

describe('budget-tracker engine twin: estimateFixCost', () => {
  it('reads the request shape from the orchestrator export, never a typed copy', () => {
    assert.deepEqual(Object.keys(FIX_CALL_SHAPE).sort(), ['hypotheses', 'maxAttempts', 'maxOutputTokens']);
    const fileText = 'const a = 1;\n'.repeat(100); // 1300 chars → 434 tokens
    const e = engine.estimateFixCost({ model: 'claude-sonnet-5', fileText, ...FIX_CALL_SHAPE });
    const fileTokens = engine.estimateTokens(fileText);
    assert.equal(e.fileTokens, fileTokens);
    assert.equal(e.inputTokensPerCall, fileTokens);
    assert.equal(e.outputTokensPerCall, Math.min(fileTokens * FIX_CALL_SHAPE.hypotheses, FIX_CALL_SHAPE.maxOutputTokens));
    assert.equal(e.perAttemptUsd, engine.usdFor('claude-sonnet-5', e.inputTokensPerCall, e.outputTokensPerCall));
    assert.equal(e.maxAttempts, FIX_CALL_SHAPE.maxAttempts);
    assert.equal(e.worstCaseUsd, e.perAttemptUsd * FIX_CALL_SHAPE.maxAttempts);
    assert.equal(e.knownPrice, true);
    assert.match(e.basis, /prompt scaffolding and issue text not counted/);
  });

  it('caps the output side at max_tokens for a large file', () => {
    const e = engine.estimateFixCost({ model: 'claude-sonnet-5', fileText: 'x'.repeat(60_000), ...FIX_CALL_SHAPE });
    assert.equal(e.outputTokensPerCall, FIX_CALL_SHAPE.maxOutputTokens);
  });

  it('refuses to estimate without a shape — the caller must not invent 3 / 8192 / 3', () => {
    assert.throws(() => engine.estimateFixCost({ model: 'claude-sonnet-5', fileText: 'x' }), /pass FIX_CALL_SHAPE/);
  });
});
