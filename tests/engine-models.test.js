// ============================================================================
// Engine model selection — the hybrid AI-layer model policy.
// Craig 2026-07-07: Fable 5 on paid fix tiers, Sonnet 4.6 elsewhere, Opus 4.8
// as the refusal fallback. Both the website twin and the src/core twin must
// agree so the CLI and the website pick the same model per tier.
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

    it('cheap / free / unknown tiers resolve to Sonnet 4.6', () => {
      assert.equal(mod.modelForTier('quick'), 'claude-sonnet-4-6');
      assert.equal(mod.modelForTier('full'), 'claude-sonnet-4-6');
      assert.equal(mod.modelForTier('continuous'), 'claude-sonnet-4-6');
      assert.equal(mod.modelForTier(''), 'claude-sonnet-4-6');
      assert.equal(mod.modelForTier(undefined), 'claude-sonnet-4-6');
      assert.equal(mod.modelForTier(null), 'claude-sonnet-4-6');
    });

    it('tier matching is case-insensitive', () => {
      assert.equal(mod.modelForTier('SCAN_FIX'), 'claude-fable-5');
      assert.equal(mod.modelForTier('Nuclear'), 'claude-fable-5');
    });

    it('constants are the expected current models', () => {
      assert.equal(mod.FIX_MODEL, 'claude-fable-5');
      assert.equal(mod.CHEAP_MODEL, 'claude-sonnet-4-6');
      assert.equal(mod.FALLBACK_MODEL, 'claude-opus-4-8');
    });

    it('needsRefusalFallback flags Fable-family models only', () => {
      assert.equal(mod.needsRefusalFallback('claude-fable-5'), true);
      assert.equal(mod.needsRefusalFallback('claude-mythos-5'), true);
      assert.equal(mod.needsRefusalFallback('claude-sonnet-4-6'), false);
      assert.equal(mod.needsRefusalFallback('claude-opus-4-8'), false);
    });
  });
}

describe('engine-models — twins agree', () => {
  it('website and src/core resolve identically for every tier', () => {
    for (const tier of ['quick', 'full', 'scan_fix', 'nuclear', 'forensic', 'continuous', 'mcp', '', undefined]) {
      assert.equal(webTwin.modelForTier(tier), cliTwin.modelForTier(tier), `mismatch for tier ${tier}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Model-aware pricing in the budget tracker
// ---------------------------------------------------------------------------
const tracker = require('../website/app/lib/budget-tracker.js');

describe('budget-tracker — model-aware pricing', () => {
  it('prices a Fable call at 10/50 and a Sonnet call at 3/15', () => {
    const fable = tracker.priceFor('claude-fable-5');
    assert.deepEqual(fable, { input: 10, output: 50 });
    const sonnet = tracker.priceFor('claude-sonnet-4-6');
    assert.deepEqual(sonnet, { input: 3, output: 15 });
  });

  it('unknown / untagged model falls back to the Sonnet default rate', () => {
    assert.deepEqual(tracker.priceFor('some-unknown-model'), { input: 3, output: 15 });
    assert.deepEqual(tracker.priceFor(undefined), { input: 3, output: 15 });
  });

  it('record() prices a Fable response higher than the same Sonnet response', () => {
    const usage = { input_tokens: 100000, output_tokens: 100000 };
    const sonnetT = tracker.createBudgetTracker({ maxUsd: 1000, maxTokens: 10_000_000 });
    sonnetT.record('x', { status: 200, data: { usage } }, 'claude-sonnet-4-6');
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
