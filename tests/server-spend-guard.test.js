/**
 * Tests for website/app/lib/server-spend-guard.js — Usage Doctrine Meter 3's
 * one daily ceiling on the platform's OWN Anthropic key spend.
 *
 * Same fake Neon tagged-template recorder as tests/usage-ledger.test.js:
 * schema statements (CREATE TABLE / INDEX / ALTER) never consume the canned
 * results queue, so a test only has to supply results for the query that
 * actually matters (the SELECT summarizeUsage issues, or the INSERT
 * recordUsage issues).
 *
 * Control pairs: a ceiling that is not configured vs. one that is invalid
 * (both fail differently — 'not-configured' allows, 'misconfigured' blocks);
 * spend just under the ceiling vs. spend at it; a server-key call that is
 * recorded vs. a BYOK call that must never be.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const { checkServerSpend, recordServerSpend, SERVER_ACCOUNT_KEY } = require('../website/app/lib/server-spend-guard');
const { usdFor } = require('../src/core/budget-tracker');

function fakeSql(results = []) {
  const queries = [];
  let i = 0;
  const sql = (strings, ...values) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    queries.push({ text, values });
    if (/^(CREATE TABLE|CREATE INDEX|ALTER TABLE)/i.test(text)) {
      return Promise.resolve([]);
    }
    const result = i < results.length ? results[i] : [];
    i += 1;
    return Promise.resolve(result);
  };
  sql.queries = queries;
  return sql;
}

/** One summarizeUsage grouped-query row totalling `usd`. */
function spendRow(usd) {
  return {
    day: '2026-09-16',
    surface: 'api',
    key_owner: 'gatetest',
    events: 1,
    modules_run: 0,
    findings_total: 0,
    findings_blocking: 0,
    ai_calls: 1,
    tokens_in: 0,
    tokens_out: 0,
    usd_estimated: usd,
  };
}

const ENV_KEYS = ['GATETEST_DAILY_API_BUDGET_USD', 'DATABASE_URL'];
let savedEnv;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

async function withWarnCapture(fn) {
  const orig = console.warn;
  console.warn = () => {};
  try { return await fn(); } finally { console.warn = orig; }
}

describe('checkServerSpend — configuration', () => {
  test('unset ceiling: guard disabled, allowed', async () => {
    const out = await checkServerSpend({ sql: fakeSql(), now: new Date('2026-09-16T12:00:00Z') });
    assert.deepStrictEqual(out, { allowed: true, spentMicros: 0, ceilingMicros: null, reason: 'not-configured' });
  });

  test('empty-string ceiling behaves the same as unset', async () => {
    process.env.GATETEST_DAILY_API_BUDGET_USD = '   ';
    const out = await checkServerSpend({ sql: fakeSql() });
    assert.strictEqual(out.allowed, true);
    assert.strictEqual(out.reason, 'not-configured');
  });

  test('invalid ceiling (non-numeric) fails closed: blocked/misconfigured', async () => {
    process.env.GATETEST_DAILY_API_BUDGET_USD = 'not-a-number';
    const out = await checkServerSpend({ sql: fakeSql() });
    assert.deepStrictEqual(out, { allowed: false, spentMicros: 0, ceilingMicros: null, reason: 'misconfigured' });
  });

  test('invalid ceiling (zero/negative) fails closed: blocked/misconfigured', async () => {
    process.env.GATETEST_DAILY_API_BUDGET_USD = '-5';
    const out = await checkServerSpend({ sql: fakeSql() });
    assert.strictEqual(out.allowed, false);
    assert.strictEqual(out.reason, 'misconfigured');
  });

  test('ceiling configured but sql unavailable and no DATABASE_URL: blocked/ledger-unavailable', async () => {
    process.env.GATETEST_DAILY_API_BUDGET_USD = '10';
    // No `sql` passed, DATABASE_URL deleted in beforeEach — the guard has no
    // way to read today's spend and must fail closed, not open.
    const out = await checkServerSpend({});
    assert.strictEqual(out.allowed, false);
    assert.strictEqual(out.reason, 'ledger-unavailable');
    assert.strictEqual(out.ceilingMicros, 10_000_000);
  });

  test('ledger query throwing also fails closed: blocked/ledger-unavailable', async () => {
    process.env.GATETEST_DAILY_API_BUDGET_USD = '10';
    const throwingSql = () => Promise.reject(new Error('connection refused'));
    await withWarnCapture(async () => {
      const out = await checkServerSpend({ sql: throwingSql });
      assert.strictEqual(out.allowed, false);
      assert.strictEqual(out.reason, 'ledger-unavailable');
    });
  });
});

describe('checkServerSpend — ceiling boundary', () => {
  test('ceiling $10, spent $9.99: allowed', async () => {
    process.env.GATETEST_DAILY_API_BUDGET_USD = '10';
    const sql = fakeSql([[spendRow(9.99)]]);
    const out = await checkServerSpend({ sql });
    assert.strictEqual(out.allowed, true);
    assert.strictEqual(out.reason, 'ok');
    assert.strictEqual(out.spentMicros, 9_990_000);
    assert.strictEqual(out.ceilingMicros, 10_000_000);
  });

  test('ceiling $10, spent $10.00: blocked (spent must be strictly under)', async () => {
    process.env.GATETEST_DAILY_API_BUDGET_USD = '10';
    const sql = fakeSql([[spendRow(10.00)]]);
    const out = await checkServerSpend({ sql });
    assert.strictEqual(out.allowed, false);
    assert.strictEqual(out.reason, 'daily-budget-reached');
    assert.strictEqual(out.spentMicros, 10_000_000);
    assert.strictEqual(out.ceilingMicros, 10_000_000);
  });

  test('spend is summed across multiple rows for the server identity', async () => {
    process.env.GATETEST_DAILY_API_BUDGET_USD = '10';
    const sql = fakeSql([[spendRow(4), spendRow(3)]]);
    const out = await checkServerSpend({ sql });
    assert.strictEqual(out.spentMicros, 7_000_000);
    assert.strictEqual(out.allowed, true);
  });
});

describe('recordServerSpend', () => {
  test('computes micros with usdFor, writes the server identity, and inserts exactly once', async () => {
    const sql = fakeSql([[{ id: 77 }]]);
    const model = 'claude-sonnet-5';
    const inputTokens = 12_000;
    const outputTokens = 3_000;
    const expectedUsd = usdFor(model, inputTokens, outputTokens);

    const out = await recordServerSpend({ sql, route: '/api/chat', model, inputTokens, outputTokens });

    assert.strictEqual(out.recorded, true);
    assert.strictEqual(out.id, 77);
    assert.ok(Math.abs(out.usdEstimated - expectedUsd) < 1e-9);

    const inserts = sql.queries.filter((q) => /^INSERT INTO usage_events/i.test(q.text));
    assert.strictEqual(inserts.length, 1, 'exactly one INSERT for one recorded call');
    const values = inserts[0].values;
    assert.ok(values.includes(SERVER_ACCOUNT_KEY), 'row is written under the fixed server identity');
    assert.ok(values.some((v) => typeof v === 'number' && Math.abs(v - expectedUsd) < 1e-6), 'usd_estimated matches usdFor');
  });

  test('a BYOK call is never recorded (guard-level backstop, no DB access at all)', async () => {
    const sql = fakeSql([[{ id: 999 }]]);
    const out = await recordServerSpend({
      sql,
      route: '/api/scan/server-fix',
      model: 'claude-sonnet-5',
      inputTokens: 500,
      outputTokens: 100,
      isCustomerKey: true,
    });
    assert.strictEqual(out.recorded, false);
    assert.strictEqual(out.reason, 'byok');
    assert.strictEqual(sql.queries.length, 0, 'no query at all is issued for a BYOK call');
  });

  test('a ledger write failure never throws (best-effort, matches recordUsageIfConfigured contract)', async () => {
    const throwingSql = () => Promise.reject(new Error('write failed'));
    await withWarnCapture(async () => {
      const out = await recordServerSpend({
        sql: throwingSql,
        route: '/api/heal/sentry-webhook',
        model: 'claude-sonnet-5',
        inputTokens: 10,
        outputTokens: 10,
      });
      assert.strictEqual(out.recorded, false);
      assert.strictEqual(out.reason, 'write-failed');
    });
  });

  test('no sql and no DATABASE_URL: reports ledger-unavailable rather than throwing', async () => {
    const out = await recordServerSpend({
      route: '/api/watches/tick',
      model: 'claude-sonnet-5',
      inputTokens: 10,
      outputTokens: 10,
    });
    assert.strictEqual(out.recorded, false);
    assert.strictEqual(out.reason, 'ledger-unavailable');
  });
});
