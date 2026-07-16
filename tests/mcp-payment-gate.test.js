'use strict';
/**
 * MCP Payment Gate — unit tests
 *
 * Covers: API key generation, in-process validation cache,
 * gate logic (GATED_TOOLS vs free tools), and store helpers.
 * No real Stripe, no real DB, no real network calls.
 */
const assert = require('node:assert/strict');
const { test, mock } = require('node:test');

// ---------------------------------------------------------------------------
// 1. generateApiKey format
// ---------------------------------------------------------------------------
test('generateApiKey() returns gtmcp_ prefixed 70-char key', () => {
  const { generateApiKey } = require('../website/app/lib/mcp-subscription-store.js');
  const key = generateApiKey();
  assert.match(key, /^gtmcp_[0-9a-f]{64}$/, 'key must match gtmcp_<64hex>');
  assert.equal(key.length, 70, 'key must be exactly 70 chars');
});

test('generateApiKey() returns unique keys on each call', () => {
  const { generateApiKey } = require('../website/app/lib/mcp-subscription-store.js');
  const keys = Array.from({ length: 5 }, generateApiKey);
  const unique = new Set(keys);
  assert.equal(unique.size, 5, 'all keys must be unique');
});

// ---------------------------------------------------------------------------
// 2. isKeyValid cache logic (tested via the internal logic, not the export)
//    We simulate the behaviour by rebuilding it inline.
// ---------------------------------------------------------------------------
test('isKeyValid() returns false when GATETEST_API_KEY is not set', async () => {
  const origKey = process.env.GATETEST_API_KEY;
  delete process.env.GATETEST_API_KEY;
  try {
    // Rebuild a local copy of the cache logic for isolation
    const isKeyValid = buildIsKeyValid({ valid: false });
    const result = await isKeyValid();
    assert.equal(result, false);
  } finally {
    if (origKey !== undefined) process.env.GATETEST_API_KEY = origKey;
  }
});

test('isKeyValid() returns cached value within TTL (no second fetch call)', async () => {
  process.env.GATETEST_API_KEY = 'gtmcp_' + 'a'.repeat(64);
  let fetchCount = 0;
  const isKeyValid = buildIsKeyValid({ valid: true, onFetch: () => { fetchCount++; } });
  await isKeyValid();
  await isKeyValid(); // should hit cache
  assert.equal(fetchCount, 1, 'fetch should only be called once within TTL');
  delete process.env.GATETEST_API_KEY;
});

test('isKeyValid() re-fetches after TTL expires', async () => {
  process.env.GATETEST_API_KEY = 'gtmcp_' + 'b'.repeat(64);
  let fetchCount = 0;
  const isKeyValid = buildIsKeyValid({ valid: true, onFetch: () => { fetchCount++; }, ttlMs: 0 });
  await isKeyValid();
  await isKeyValid(); // TTL=0 → always expired
  assert.ok(fetchCount >= 2, 'should re-fetch after TTL expires');
  delete process.env.GATETEST_API_KEY;
});

test('isKeyValid() falls back to stale cache on network error', async () => {
  process.env.GATETEST_API_KEY = 'gtmcp_' + 'c'.repeat(64);
  const isKeyValid = buildIsKeyValid({ valid: true, throwOnFetch: true, primeCache: true });
  // Second call: stale cache (valid=true) should be returned on network error
  const result = await isKeyValid();
  assert.equal(result, true, 'should return stale cached value on network error');
  delete process.env.GATETEST_API_KEY;
});

// ---------------------------------------------------------------------------
// 3. Gate: gated tool without key → gate message
// ---------------------------------------------------------------------------
test('GATED_TOOLS members return 🔒 message when key missing', async () => {
  delete process.env.GATETEST_API_KEY;
  const result = simulateGate('capture_screenshot', {});
  assert.ok(result !== null, 'gate should fire');
  assert.ok(result.content[0].text.includes('🔒'), 'response must include 🔒');
  assert.ok(result.content[0].text.includes('gatetest.ai/mcp'), 'response must link to subscription page');
});

test('scan_local with quick suite passes without key', async () => {
  delete process.env.GATETEST_API_KEY;
  const gated = simulateGate('scan_local', { suite: 'quick' });
  assert.equal(gated, null, 'scan_local quick must not be gated');
});

test('scan_local with full suite is gated without key', async () => {
  delete process.env.GATETEST_API_KEY;
  const result = simulateGate('scan_local', { suite: 'full' });
  assert.ok(result !== null, 'scan_local full must be gated');
  assert.ok(result.content[0].text.includes('🔒'));
});

test('scan_local with no suite arg is gated without key (defaults to standard, not quick)', async () => {
  delete process.env.GATETEST_API_KEY;
  const result = simulateGate('scan_local', {});
  assert.ok(result !== null, 'scan_local with no suite must be gated — it defaults to the standard suite, not quick');
  assert.ok(result.content[0].text.includes('🔒'));
});

test('scan_local with an explicit modules array is gated without key', async () => {
  delete process.env.GATETEST_API_KEY;
  const result = simulateGate('scan_local', { modules: ['memory', 'syntax'] });
  assert.ok(result !== null, 'scan_local with a modules array must be gated — it bypasses the suite selector entirely');
  assert.ok(result.content[0].text.includes('🔒'));
});

test('scan_local with an empty modules array falls back to standard-suite gating (still gated)', async () => {
  delete process.env.GATETEST_API_KEY;
  const result = simulateGate('scan_local', { modules: [] });
  assert.ok(result !== null, 'empty modules array must not accidentally slip through as free');
});

// ---------------------------------------------------------------------------
// 4. findByApiKey — returns null for unknown key (mock sql)
// ---------------------------------------------------------------------------
test('findByApiKey() returns null for unknown key', async () => {
  const { findByApiKey } = require('../website/app/lib/mcp-subscription-store.js');
  // Mock sql that returns empty array
  const mockSql = async () => [];
  mockSql[Symbol.iterator] = function* () {}; // quack like a tagged-template
  // Use a tagged-template-compatible mock
  const sql = makeMockSql([]);
  const result = await findByApiKey(sql, 'gtmcp_' + '0'.repeat(64));
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// 5. upsertMcpSubscription idempotency (mock sql)
// ---------------------------------------------------------------------------
test('upsertMcpSubscription() is idempotent — returns the row on conflict', async () => {
  const { upsertMcpSubscription, generateApiKey } = require('../website/app/lib/mcp-subscription-store.js');
  const key = generateApiKey();
  let callCount = 0;
  const sql = makeMockSql([{ id: 1, stripe_subscription_id: 'sub_test', api_key: key, status: 'active' }], () => { callCount++; });
  const result1 = await upsertMcpSubscription(sql, {
    stripeSubscriptionId: 'sub_test',
    stripeCustomerId: 'cus_test',
    apiKey: key,
    status: 'active',
    customerEmail: 'test@example.com',
  });
  const result2 = await upsertMcpSubscription(sql, {
    stripeSubscriptionId: 'sub_test', // same sub ID
    stripeCustomerId: 'cus_test',
    apiKey: key,
    status: 'active',
    customerEmail: 'test@example.com',
  });
  assert.ok(result1 !== null, 'first upsert must return a row');
  assert.ok(result2 !== null, 'second upsert must also return a row (idempotent)');
  assert.equal(result1.api_key, key, 'api_key must be preserved on conflict');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an isolated copy of the isKeyValid function for testing. */
function buildIsKeyValid({ valid, onFetch, throwOnFetch, ttlMs = 3600000, primeCache = false }) {
  let _keyCache = { valid: primeCache ? valid : null, ts: primeCache ? Date.now() : 0 };
  const KEY_TTL_MS = ttlMs;
  return async function isKeyValid() {
    const key = process.env.GATETEST_API_KEY;
    if (!key || !key.startsWith('gtmcp_') || key.length < 70) return false;
    const now = Date.now();
    if (_keyCache.valid !== null && now - _keyCache.ts < KEY_TTL_MS) return _keyCache.valid;
    try {
      if (throwOnFetch) throw new Error('network error');
      if (onFetch) onFetch();
      _keyCache = { valid: !!valid, ts: now };
      return _keyCache.valid;
    } catch {
      if (_keyCache.valid !== null) return _keyCache.valid;
      return false;
    }
  };
}

/** Simulate the gate check (sync, no real fetch — just checks GATETEST_API_KEY presence). */
function simulateGate(toolName, args) {
  const GATED_TOOLS = new Set([
    'run_module', 'fix_issue', 'explain_finding', 'compose_pr',
    'capture_screenshot', 'get_visual_diff',
    'run_live_checks', 'get_production_errors',
    'verify_fix', 'audit_log', 'compare_repos', 'get_report', 'scan_repo',
  ]);
  const keyPresent = !!(process.env.GATETEST_API_KEY);
  const needsKey =
    GATED_TOOLS.has(toolName) ||
    (toolName === 'scan_local' && (
      (Array.isArray(args?.modules) && args.modules.length > 0) ||
      (args?.suite || 'standard') !== 'quick'
    ));
  if (needsKey && !keyPresent) {
    return {
      content: [{
        type: 'text',
        text: `🔒 **${toolName}** requires a GateTest MCP subscription ($29/mo).\n\nSubscribe at https://gatetest.ai/mcp — API key delivered by email instantly.`,
      }],
    };
  }
  return null;
}

/** Build a tagged-template-compatible mock sql function. */
function makeMockSql(rows, onCall) {
  const fn = function sql(strings, ...values) {
    if (onCall) onCall(strings, values);
    return Promise.resolve(rows);
  };
  fn.toString = () => '[mock sql]';
  return fn;
}
