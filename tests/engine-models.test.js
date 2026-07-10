// ============================================================================
// Engine model selection — the hybrid AI-layer model policy.
// Craig 2026-07-07: Fable 5 on paid fix tiers, Sonnet elsewhere, Opus 4.8
// as the refusal fallback. Craig 2026-07-10: Sonnet 5 replaces Sonnet 4.6
// everywhere; users may pick the model via the ALLOWED_FIX_MODELS allow-list.
// Both the website twin and the src/core twin must agree so the CLI and the
// website pick the same model per tier.
// ============================================================================
const { describe, it } = require('node:test');
const assert = require('node:assert');

const webTwin = require('../website/app/lib/engine-models.js');
const cliTwin = require('../src/core/engine-models.js');

for (const [label, mod] of [['website', webTwin], ['src/core', cliTwin]]) {
  describe(`engine-models (${label})`, () => {
    it('paid fix tiers resolve to Fable 5', () => {
      assert.equal(mod.modelForTier('scan_fix'), 'claude-fable-5');
      assert.equal(mod.modelForTier('nuclear'), 'claude-fable-5');
      assert.equal(mod.modelForTier('forensic'), 'claude-fable-5');
    });

    it('cheap / free / unknown tiers resolve to Sonnet 5', () => {
      assert.equal(mod.modelForTier('quick'), 'claude-sonnet-5');
      assert.equal(mod.modelForTier('full'), 'claude-sonnet-5');
      assert.equal(mod.modelForTier('continuous'), 'claude-sonnet-5');
      assert.equal(mod.modelForTier(''), 'claude-sonnet-5');
      assert.equal(mod.modelForTier(undefined), 'claude-sonnet-5');
      assert.equal(mod.modelForTier(null), 'claude-sonnet-5');
    });

    it('tier matching is case-insensitive', () => {
      assert.equal(mod.modelForTier('SCAN_FIX'), 'claude-fable-5');
      assert.equal(mod.modelForTier('Nuclear'), 'claude-fable-5');
    });

    it('constants are the expected current models', () => {
      assert.equal(mod.FIX_MODEL, 'claude-fable-5');
      assert.equal(mod.CHEAP_MODEL, 'claude-sonnet-5');
      assert.equal(mod.FALLBACK_MODEL, 'claude-opus-4-8');
    });

    it('needsRefusalFallback flags Fable-family models only', () => {
      assert.equal(mod.needsRefusalFallback('claude-fable-5'), true);
      assert.equal(mod.needsRefusalFallback('claude-mythos-5'), true);
      assert.equal(mod.needsRefusalFallback('claude-sonnet-5'), false);
      assert.equal(mod.needsRefusalFallback('claude-opus-4-8'), false);
    });

    it('allow-list contains exactly the user-selectable models', () => {
      assert.deepEqual(mod.allowedModelIds(), [
        'claude-sonnet-5',
        'claude-opus-4-8',
        'claude-fable-5',
      ]);
    });

    it('resolveModelChoice accepts exact ids', () => {
      for (const id of mod.allowedModelIds()) {
        assert.deepEqual(mod.resolveModelChoice(id), { ok: true, model: id });
      }
    });

    it('resolveModelChoice accepts aliases, case-insensitively, with whitespace', () => {
      assert.deepEqual(mod.resolveModelChoice('sonnet'), { ok: true, model: 'claude-sonnet-5' });
      assert.deepEqual(mod.resolveModelChoice('OPUS'), { ok: true, model: 'claude-opus-4-8' });
      assert.deepEqual(mod.resolveModelChoice('opus-4.8'), { ok: true, model: 'claude-opus-4-8' });
      assert.deepEqual(mod.resolveModelChoice('  Fable '), { ok: true, model: 'claude-fable-5' });
      assert.deepEqual(mod.resolveModelChoice('fable-5'), { ok: true, model: 'claude-fable-5' });
    });

    it('resolveModelChoice rejects unknown / empty / non-string input, naming every allowed id', () => {
      for (const bad of ['gpt-4', 'claude-sonnet-4-6', '', '   ', null, undefined, 42, {}]) {
        const res = mod.resolveModelChoice(bad);
        assert.equal(res.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
        for (const id of mod.allowedModelIds()) {
          assert.ok(res.error.includes(id), `error should name ${id}: ${res.error}`);
        }
      }
    });
  });
}

describe('engine-models — twins agree', () => {
  it('website and src/core resolve identically for every tier', () => {
    for (const tier of ['quick', 'full', 'scan_fix', 'nuclear', 'forensic', 'continuous', 'mcp', '', undefined]) {
      assert.equal(webTwin.modelForTier(tier), cliTwin.modelForTier(tier), `mismatch for tier ${tier}`);
    }
  });

  it('website and src/core expose identical allow-lists', () => {
    assert.deepEqual(webTwin.ALLOWED_FIX_MODELS, cliTwin.ALLOWED_FIX_MODELS);
    assert.deepEqual(webTwin.allowedModelIds(), cliTwin.allowedModelIds());
    for (const input of ['sonnet', 'opus', 'fable', 'claude-fable-5', 'bogus']) {
      assert.deepEqual(webTwin.resolveModelChoice(input), cliTwin.resolveModelChoice(input), `mismatch for ${input}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Model-aware pricing in the budget tracker
// ---------------------------------------------------------------------------
const tracker = require('../website/app/lib/budget-tracker.js');

describe('budget-tracker — model-aware pricing', () => {
  it('prices a Fable call at 10/50 and Sonnet calls at 3/15', () => {
    const fable = tracker.priceFor('claude-fable-5');
    assert.deepEqual(fable, { input: 10, output: 50 });
    assert.deepEqual(tracker.priceFor('claude-sonnet-5'), { input: 3, output: 15 });
    assert.deepEqual(tracker.priceFor('claude-sonnet-4-6'), { input: 3, output: 15 });
  });

  it('unknown / untagged model falls back to the Sonnet default rate', () => {
    assert.deepEqual(tracker.priceFor('some-unknown-model'), { input: 3, output: 15 });
    assert.deepEqual(tracker.priceFor(undefined), { input: 3, output: 15 });
  });

  it('record() prices a Fable response higher than the same Sonnet response', () => {
    const usage = { input_tokens: 100000, output_tokens: 100000 };
    const sonnetT = tracker.createBudgetTracker({ maxUsd: 1000, maxTokens: 10_000_000 });
    sonnetT.record('x', { status: 200, data: { usage } }, 'claude-sonnet-5');
    const fableT = tracker.createBudgetTracker({ maxUsd: 1000, maxTokens: 10_000_000 });
    fableT.record('x', { status: 200, data: { usage } }, 'claude-fable-5');
    // Sonnet: 0.1*3 + 0.1*15 = 1.8 ; Fable: 0.1*10 + 0.1*50 = 6.0
    assert.ok(Math.abs(sonnetT.estimatedUsd() - 1.8) < 1e-9, `sonnet ${sonnetT.estimatedUsd()}`);
    assert.ok(Math.abs(fableT.estimatedUsd() - 6.0) < 1e-9, `fable ${fableT.estimatedUsd()}`);
  });

  it('record() reads the model off response.data.model when not passed explicitly', () => {
    const usage = { input_tokens: 100000, output_tokens: 100000 };
    const t = tracker.createBudgetTracker({ maxUsd: 1000, maxTokens: 10_000_000 });
    t.record('x', { status: 200, data: { usage, model: 'claude-fable-5' } });
    assert.ok(Math.abs(t.estimatedUsd() - 6.0) < 1e-9, `expected Fable pricing, got ${t.estimatedUsd()}`);
  });

  it('paid fix-tier caps were raised to fund Fable ($30 / $60)', () => {
    assert.equal(tracker.capsForTier('scan_fix').maxUsd, 30);
    assert.equal(tracker.capsForTier('nuclear').maxUsd, 60);
    // Cheap tiers unchanged.
    assert.equal(tracker.capsForTier('quick').maxUsd, 1.5);
    assert.equal(tracker.capsForTier('full').maxUsd, 5);
  });
});

// ---------------------------------------------------------------------------
// BYOK tracker — customer's own key, so no USD cap; token cap stays as the
// runaway guard and spend still accumulates for observability.
// ---------------------------------------------------------------------------
describe('budget-tracker — BYOK mode', () => {
  it('BYOK tracker never USD-aborts but keeps the tier token cap', () => {
    const t = tracker.createTrackerForTier('scan_fix', { byok: true });
    const bigUsage = { input_tokens: 1_000_000, output_tokens: 500_000 };
    // One Fable call at this size is 10 + 25 = $35 — over the $30 scan_fix cap.
    t.record('big', { status: 200, data: { usage: bigUsage } }, 'claude-fable-5');
    assert.ok(t.estimatedUsd() > 30, `spend should accumulate: ${t.estimatedUsd()}`);
    assert.doesNotThrow(() => t.preflight('next'));
    // Token cap still enforced (scan_fix cap is 1.5M; we are at 1.5M).
    t.record('more', { status: 200, data: { usage: { input_tokens: 1, output_tokens: 0 } } }, 'claude-sonnet-5');
    assert.throws(() => t.preflight('after-cap'), /BUDGET_EXCEEDED|token/i);
  });

  it('non-BYOK tracker still enforces the USD cap', () => {
    const t = tracker.createTrackerForTier('scan_fix');
    const bigUsage = { input_tokens: 1_000_000, output_tokens: 500_000 };
    t.record('big', { status: 200, data: { usage: bigUsage } }, 'claude-fable-5');
    assert.throws(() => t.preflight('next'), /BUDGET_EXCEEDED|usd|\$/i);
  });
});
