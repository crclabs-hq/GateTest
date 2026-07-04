// ============================================================================
// LIB SHIMS TRIPWIRE — website/app/lib clients re-export src/core canonicals.
// ============================================================================
// The Sentry/Datadog(/Rollbar) clients were lifted to src/core so the MCP
// server (CLI-side) can use them without reaching into website/. The
// website keeps one-line re-export shims at the old paths so every
// existing import and the Vercel file-tracing setup keep working.
//
// This test is the tripwire against a future session "simplifying" a shim
// into a fork: the website export MUST be the same function object as the
// src/core export — identity, not equality.
// ============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('website lib shims re-export src/core canonicals (identity)', () => {
  it('sentry-client', () => {
    const core = require('../src/core/sentry-client.js');
    const shim = require('../website/app/lib/sentry-client.js');
    assert.strictEqual(shim.fetchTopErrors, core.fetchTopErrors);
    assert.strictEqual(shim.exchangeOAuthCode, core.exchangeOAuthCode);
    assert.strictEqual(shim.extractFrames, core.extractFrames);
  });

  it('datadog-client', () => {
    const core = require('../src/core/datadog-client.js');
    const shim = require('../website/app/lib/datadog-client.js');
    assert.strictEqual(shim.fetchTopErrors, core.fetchTopErrors);
    assert.strictEqual(shim.fetchErrorTraces, core.fetchErrorTraces);
    assert.strictEqual(shim.extractSourceLocation, core.extractSourceLocation);
  });

  it('rollbar-client', () => {
    const core = require('../src/core/rollbar-client.js');
    const shim = require('../website/app/lib/rollbar-client.js');
    assert.strictEqual(shim.fetchTopErrors, core.fetchTopErrors);
    assert.strictEqual(shim.extractSourceLocation, core.extractSourceLocation);
  });
});
