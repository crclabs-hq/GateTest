// ============================================================================
// AI-INVOCATION-LIMIT TEST
// ============================================================================
// Verifies the MAX_AI_INVOCATIONS circuit breaker wired into the fix route.
//
// The circuit breaker lives at the `anthropicCall` level — it reads the
// per-request budget tracker's `callCount` and `_maxInvocations` fields
// and throws `INVOCATION_LIMIT_EXCEEDED` before the Anthropic API call is made.
//
// This file tests:
//   1. The constant value is correct (1000).
//   2. The circuit-breaker logic fires at the right callCount threshold.
//   3. The error carries the right name so the per-file catch handler can
//      set `state.haltRun = true` without re-throwing as a network error.
// ============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Read the route source to verify the constant without importing the whole
// Next.js route (which would require the full Next.js runtime).
const routeSrc = fs.readFileSync(
  path.resolve(__dirname, '..', 'website', 'app', 'api', 'scan', 'fix', 'route.ts'),
  'utf-8'
);

describe('MAX_AI_INVOCATIONS constant', () => {
  it('is defined in the fix route', () => {
    assert.ok(
      /const MAX_AI_INVOCATIONS\s*=\s*1000/.test(routeSrc),
      'Expected `const MAX_AI_INVOCATIONS = 1000` in fix route'
    );
  });

  it('is 1000', () => {
    const m = routeSrc.match(/const MAX_AI_INVOCATIONS\s*=\s*(\d+)/);
    assert.ok(m, 'MAX_AI_INVOCATIONS not found');
    assert.strictEqual(Number(m[1]), 1000);
  });

  it('is applied to scan_fix and nuclear tiers only', () => {
    assert.ok(
      routeSrc.includes('"scan_fix"') && routeSrc.includes('"nuclear"') &&
      routeSrc.includes('_maxInvocations'),
      'Expected _maxInvocations wired for scan_fix and nuclear'
    );
    // Must NOT be applied unconditionally (free tiers stay uncapped)
    const unconditional = /createTrackerForTier[\s\S]{0,30}_maxInvocations/.test(routeSrc);
    assert.ok(!unconditional, 'MAX_AI_INVOCATIONS should be tier-conditional, not unconditional');
  });
});

describe('Circuit-breaker logic', () => {
  // Simulate the check that lives inside `anthropicCall`:
  //   if (tracker._maxInvocations !== undefined && tracker.callCount >= tracker._maxInvocations)
  function makeTracker(callCount, maxInvocations) {
    return { callCount, _maxInvocations: maxInvocations };
  }

  function simulatePreflightCheck(tracker) {
    if (tracker._maxInvocations !== undefined && tracker.callCount >= tracker._maxInvocations) {
      const err = new Error(`INVOCATION_LIMIT_EXCEEDED:${tracker._maxInvocations}`);
      err.name = 'INVOCATION_LIMIT_EXCEEDED';
      throw err;
    }
  }

  it('does not fire before the limit', () => {
    const tracker = makeTracker(999, 1000);
    assert.doesNotThrow(() => simulatePreflightCheck(tracker));
  });

  it('fires exactly at the limit', () => {
    const tracker = makeTracker(1000, 1000);
    assert.throws(
      () => simulatePreflightCheck(tracker),
      { name: 'INVOCATION_LIMIT_EXCEEDED' }
    );
  });

  it('fires past the limit', () => {
    const tracker = makeTracker(1500, 1000);
    assert.throws(
      () => simulatePreflightCheck(tracker),
      { name: 'INVOCATION_LIMIT_EXCEEDED' }
    );
  });

  it('is a no-op when _maxInvocations is undefined (uncapped tiers)', () => {
    const tracker = { callCount: 9999 }; // no _maxInvocations
    assert.doesNotThrow(() => simulatePreflightCheck(tracker));
  });

  it('error name is INVOCATION_LIMIT_EXCEEDED (not a network error)', () => {
    // The per-file catch handler checks `err.name === "INVOCATION_LIMIT_EXCEEDED"`
    // to avoid mistakenly treating it as a retryable network failure.
    const tracker = makeTracker(1000, 1000);
    try {
      simulatePreflightCheck(tracker);
      assert.fail('should have thrown');
    } catch (err) {
      assert.strictEqual(err.name, 'INVOCATION_LIMIT_EXCEEDED');
      assert.ok(!err.message.includes('EPROTO'), 'must not look like a network error');
    }
  });
});
