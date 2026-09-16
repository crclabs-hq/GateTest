/**
 * Tests for website/app/lib/usage-ledger.js — the customer usage meter's
 * ledger (Craig 2026-09-16), its writers, and the GET /api/v1/usage logic.
 *
 * Same fake Neon tagged-template recorder as the continuous-subscription
 * store tests: queries are captured as flattened strings, canned row sets
 * are returned in order, schema statements never consume the queue.
 *
 * Control pairs throughout: the row that must be written / the row that
 * must not; the caller that may read / the caller that may not; the
 * ledger that fails / the scan that still succeeds.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const Ledger = require('../website/app/lib/usage-ledger');
const { runWorkerTick } = require('../website/app/lib/scan-worker');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

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

function throwingSql() {
  const sql = () => Promise.reject(new Error('connection refused'));
  return sql;
}

/** Capture console.warn for one async block; returns the warnings. */
async function withWarnCapture(fn) {
  const warnings = [];
  const orig = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.warn = orig;
  }
  return warnings;
}

const EMAIL_KEY = Ledger.accountKeyForEmail('ada@example.com');

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe('accountKeyForEmail / resolveAccountKey / accountKeysForApiKey', () => {
  test('is stable, case- and whitespace-insensitive, and never contains the e-mail', () => {
    assert.strictEqual(Ledger.accountKeyForEmail('Ada@Example.com '), EMAIL_KEY);
    assert.match(EMAIL_KEY, /^em:[0-9a-f]{64}$/);
    assert.ok(!EMAIL_KEY.includes('ada'), 'no raw e-mail in the key');
    // Control: a different e-mail is a different customer.
    assert.notStrictEqual(Ledger.accountKeyForEmail('bob@example.com'), EMAIL_KEY);
  });

  test('rejects non-e-mails', () => {
    assert.strictEqual(Ledger.accountKeyForEmail(''), null);
    assert.strictEqual(Ledger.accountKeyForEmail('not-an-email'), null);
    assert.strictEqual(Ledger.accountKeyForEmail(null), null);
    assert.strictEqual(Ledger.accountKeyForEmail(42), null);
  });

  test('e-mail wins over every fallback; fallbacks are namespaced', () => {
    assert.strictEqual(
      Ledger.resolveAccountKey({ email: 'ada@example.com', stripeCustomerId: 'cus_1', apiKeyId: 'k1' }),
      EMAIL_KEY
    );
    assert.strictEqual(Ledger.resolveAccountKey({ stripeCustomerId: 'cus_1', apiKeyId: 'k1' }), 'stripe:cus_1');
    assert.strictEqual(Ledger.resolveAccountKey({ apiKeyId: 'k1' }), 'apikey:k1');
    assert.strictEqual(Ledger.resolveAccountKey({ checkoutSessionId: 'cs_test_1' }), 'checkout:cs_test_1');
    assert.strictEqual(Ledger.resolveAccountKey({ org: 'github.com/acme' }), 'org:github.com/acme');
    assert.strictEqual(Ledger.resolveAccountKey({ fallback: 'admin' }), 'admin');
    assert.strictEqual(Ledger.resolveAccountKey({}), null);
  });

  test('an API key reads its e-mail identity and its own id — nothing else', () => {
    assert.deepStrictEqual(
      Ledger.accountKeysForApiKey({ id: 'key_1', customer_email: 'ada@example.com' }),
      [EMAIL_KEY, 'apikey:key_1']
    );
    // Control: a key with no e-mail reads only its own rows.
    assert.deepStrictEqual(Ledger.accountKeysForApiKey({ id: 'key_2', customer_email: null }), ['apikey:key_2']);
  });
});

// ---------------------------------------------------------------------------
// Row shaping
// ---------------------------------------------------------------------------

describe('redactRepo / normalizeUsageEvent / modelTierFor', () => {
  test('redactRepo keeps owner/name only', () => {
    assert.strictEqual(Ledger.redactRepo('https://github.com/Acme/Widgets.git?token=abc'), 'Acme/Widgets');
    assert.strictEqual(Ledger.redactRepo('git@gluecron.com:acme/widgets.git'), 'acme/widgets');
    assert.strictEqual(Ledger.redactRepo('acme/widgets'), 'acme/widgets');
    assert.strictEqual(Ledger.redactRepo('github.com/acme/widgets/'), 'acme/widgets');
    assert.strictEqual(Ledger.redactRepo('widgets'), null);
    assert.strictEqual(Ledger.redactRepo(''), null);
    assert.strictEqual(Ledger.redactRepo(null), null);
  });

  test('normalizeUsageEvent coerces numbers and flags BYOK', () => {
    const row = Ledger.normalizeUsageEvent({
      accountKey: EMAIL_KEY,
      surface: 'Hosted-Fix',
      repo: 'https://github.com/acme/widgets',
      suite: 'scan_fix',
      modulesRun: '3',
      findingsTotal: 12.4,
      aiCalls: 4,
      tokensIn: 1000,
      tokensOut: 250,
      usdEstimated: 0.1234567,
      keyOwner: 'byok',
      modelTier: 'deep',
    });
    assert.strictEqual(row.surface, 'hosted-fix');
    assert.strictEqual(row.repo, 'acme/widgets');
    assert.strictEqual(row.modules_run, 3);
    assert.strictEqual(row.findings_total, 12);
    assert.strictEqual(row.findings_blocking, 0);
    assert.strictEqual(row.tokens_in, 1000);
    assert.strictEqual(row.usd_estimated, 0.123457);
    assert.strictEqual(row.key_owner, 'byok');
    assert.strictEqual(row.model_tier, 'deep');
    // Control: the GateTest-paid default.
    assert.strictEqual(Ledger.normalizeUsageEvent({ accountKey: 'x', surface: 'web' }).key_owner, 'gatetest');
  });

  test('normalizeUsageEvent rejects a missing identity and an unknown surface', () => {
    assert.throws(() => Ledger.normalizeUsageEvent({ surface: 'web' }), /accountKey/);
    assert.throws(() => Ledger.normalizeUsageEvent({ accountKey: 'x', surface: 'carrier-pigeon' }), /invalid surface/);
    for (const s of Ledger.SURFACES) {
      assert.strictEqual(Ledger.normalizeUsageEvent({ accountKey: 'x', surface: s }).surface, s);
    }
  });

  test('modelTierFor never returns a model id', () => {
    const { CHEAP_MODEL, FIX_MODEL } = require('../website/app/lib/engine-models');
    assert.strictEqual(Ledger.modelTierFor(CHEAP_MODEL), 'standard');
    assert.strictEqual(Ledger.modelTierFor(FIX_MODEL), 'deep');
    assert.strictEqual(Ledger.modelTierFor(''), null);
    assert.strictEqual(Ledger.modelTierFor(undefined), null);
  });

  test('aiTotalsFromModules: deterministic scans have zero AI usage; AI modules are summed', () => {
    assert.deepStrictEqual(
      Ledger.aiTotalsFromModules([{ name: 'lint', issues: 0 }, { name: 'secrets', issues: 2 }]),
      { aiCalls: 0, tokensIn: 0, tokensOut: 0, usd: 0 }
    );
    assert.deepStrictEqual(
      Ledger.aiTotalsFromModules([{ name: 'lint' }, { name: 'aiReview', costUsd: 0.05, tokensIn: 9000, tokensOut: 800 }]),
      { aiCalls: 1, tokensIn: 9000, tokensOut: 800, usd: 0.05 }
    );
  });

  test('countBlockingFindings uses the gate definition', () => {
    const withRegistry = {
      status: 'complete',
      findings: [{ blocking: true, severity: 'error' }, { blocking: false, severity: 'warning' }, { blocking: true, duplicateOf: 'x' }],
      findingSummary: {},
    };
    assert.strictEqual(Ledger.countBlockingFindings(withRegistry), 1);
    assert.strictEqual(Ledger.countBlockingFindings({ status: 'complete', modules: [] }), 0);
    assert.strictEqual(Ledger.countBlockingFindings(null), 0);
  });
});

// ---------------------------------------------------------------------------
// recordUsage
// ---------------------------------------------------------------------------

describe('recordUsage', () => {
  test('creates the table idempotently and inserts the row', async () => {
    const sql = fakeSql([[{ id: 7 }]]);
    const out = await Ledger.recordUsage(sql, {
      accountKey: EMAIL_KEY,
      surface: 'hosted-fix',
      repo: 'https://github.com/acme/widgets',
      suite: 'scan_fix',
      tier: 'scan_fix',
      aiCalls: 3,
      tokensIn: 1200,
      tokensOut: 300,
      usdEstimated: 0.5,
      keyOwner: 'byok',
      modelTier: 'deep',
    });
    assert.strictEqual(out.id, 7);
    const create = sql.queries.find((q) => q.text.startsWith('CREATE TABLE IF NOT EXISTS usage_events'));
    assert.ok(create, 'CREATE TABLE IF NOT EXISTS usage_events issued');
    assert.ok(sql.queries.some((q) => q.text.startsWith('CREATE INDEX IF NOT EXISTS idx_usage_events_account_time')));
    assert.ok(sql.queries.some((q) => q.text.startsWith('ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS')));
    const insert = sql.queries.find((q) => q.text.startsWith('INSERT INTO usage_events'));
    assert.ok(insert, 'insert issued');
    assert.ok(insert.values.includes(EMAIL_KEY));
    assert.ok(insert.values.includes('hosted-fix'));
    assert.ok(insert.values.includes('acme/widgets'), 'repo redacted to owner/name');
    assert.ok(!insert.values.some((v) => typeof v === 'string' && v.includes('https://')), 'no URL stored');
    assert.ok(insert.values.includes(1200) && insert.values.includes(300) && insert.values.includes(0.5));
    assert.ok(insert.values.includes('byok'));
    assert.ok(insert.values.includes('deep'));
  });

  test('rejects a bad event before touching the database', async () => {
    const sql = fakeSql();
    await assert.rejects(Ledger.recordUsage(sql, { surface: 'web' }), /accountKey/);
    assert.strictEqual(sql.queries.length, 0);
    await assert.rejects(Ledger.recordUsage(null, { accountKey: 'x', surface: 'web' }), /sql is required/);
  });
});

// ---------------------------------------------------------------------------
// recordUsageIfConfigured — the writers' contract
// ---------------------------------------------------------------------------

describe('recordUsageIfConfigured (best-effort writer)', () => {
  test('returns null without a database and never throws', async () => {
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      assert.strictEqual(await Ledger.recordUsageIfConfigured({ accountKey: 'x', surface: 'web' }), null);
    } finally {
      if (prev !== undefined) process.env.DATABASE_URL = prev;
    }
  });

  test('swallows a database failure with one warning', async () => {
    let result;
    const warnings = await withWarnCapture(async () => {
      result = await Ledger.recordUsageIfConfigured({ accountKey: 'x', surface: 'web' }, { sql: throwingSql() });
    });
    assert.strictEqual(result, null);
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /usage-ledger.*connection refused/);
  });

  test('swallows a bad event (programming error) the same way', async () => {
    let result;
    const warnings = await withWarnCapture(async () => {
      result = await Ledger.recordUsageIfConfigured({ accountKey: null, surface: 'web' }, { sql: fakeSql() });
    });
    assert.strictEqual(result, null);
    assert.strictEqual(warnings.length, 1);
  });

  test('control: with a working database it returns the id and warns nothing', async () => {
    let result;
    const warnings = await withWarnCapture(async () => {
      result = await Ledger.recordUsageIfConfigured({ accountKey: 'x', surface: 'web' }, { sql: fakeSql([[{ id: 3 }]]) });
    });
    assert.strictEqual(result, 3);
    assert.deepStrictEqual(warnings, []);
  });
});

// ---------------------------------------------------------------------------
// Aggregation + summarizeUsage
// ---------------------------------------------------------------------------

const WINDOW = { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-09-03T23:59:59Z') };

const RAW_ROWS = [
  { occurred_at: '2026-09-01T10:00:00Z', surface: 'web', key_owner: 'gatetest', modules_run: 121, findings_total: 10, findings_blocking: 2, ai_calls: 0, tokens_in: 0, tokens_out: 0, usd_estimated: 0 },
  { occurred_at: '2026-09-01T12:00:00Z', surface: 'hosted-fix', key_owner: 'gatetest', modules_run: 3, findings_total: 6, findings_blocking: 1, ai_calls: 4, tokens_in: 10000, tokens_out: 2000, usd_estimated: 0.5 },
  { occurred_at: '2026-09-03T09:00:00Z', surface: 'hosted-fix', key_owner: 'byok', modules_run: 2, findings_total: 3, findings_blocking: 0, ai_calls: 2, tokens_in: 5000, tokens_out: 1000, usd_estimated: 0.25 },
];

describe('aggregateUsageRows', () => {
  test('totals tokens, USD, scans vs fixes, and BYOK share', () => {
    const { totals } = Ledger.aggregateUsageRows(RAW_ROWS, WINDOW);
    assert.strictEqual(totals.events, 3);
    assert.strictEqual(totals.scans, 1);
    assert.strictEqual(totals.fixes, 2);
    assert.strictEqual(totals.modulesRun, 126);
    assert.strictEqual(totals.findingsTotal, 19);
    assert.strictEqual(totals.findingsBlocking, 3);
    assert.strictEqual(totals.aiCalls, 6);
    assert.strictEqual(totals.tokensIn, 15000);
    assert.strictEqual(totals.tokensOut, 3000);
    assert.strictEqual(totals.tokensTotal, 18000);
    assert.strictEqual(totals.usdEstimated, 0.75);
    // BYOK rows are INCLUDED in the total and flagged separately.
    assert.strictEqual(totals.usdByok, 0.25);
    assert.strictEqual(totals.usdGatetestPaid, 0.5);
    assert.strictEqual(totals.byokEvents, 1);
  });

  test('breaks down per surface', () => {
    const { bySurface } = Ledger.aggregateUsageRows(RAW_ROWS, WINDOW);
    assert.deepStrictEqual(Object.keys(bySurface).sort(), ['hosted-fix', 'web']);
    assert.strictEqual(bySurface.web.events, 1);
    assert.strictEqual(bySurface.web.aiCalls, 0);
    assert.strictEqual(bySurface['hosted-fix'].events, 2);
    assert.strictEqual(bySurface['hosted-fix'].tokensIn, 15000);
    assert.strictEqual(bySurface['hosted-fix'].usdEstimated, 0.75);
    assert.strictEqual(bySurface['hosted-fix'].usdByok, 0.25);
    assert.strictEqual(bySurface['hosted-fix'].byokEvents, 1);
  });

  test('builds a per-day series with quiet days filled in', () => {
    const { series } = Ledger.aggregateUsageRows(RAW_ROWS, WINDOW);
    assert.deepStrictEqual(series.map((d) => d.day), ['2026-09-01', '2026-09-02', '2026-09-03']);
    assert.strictEqual(series[0].events, 2);
    assert.strictEqual(series[0].tokensIn, 10000);
    assert.strictEqual(series[0].usdEstimated, 0.5);
    assert.strictEqual(series[1].events, 0, 'quiet day is present as zeros');
    assert.strictEqual(series[2].events, 1);
    assert.strictEqual(series[2].usdEstimated, 0.25);
  });

  test('grouped rows (with an events count) give the same answer as raw rows', () => {
    const grouped = [
      { day: '2026-09-01', surface: 'web', key_owner: 'gatetest', events: 1, modules_run: 121, findings_total: 10, findings_blocking: 2, ai_calls: 0, tokens_in: 0, tokens_out: 0, usd_estimated: 0 },
      { day: '2026-09-01', surface: 'hosted-fix', key_owner: 'gatetest', events: 1, modules_run: 3, findings_total: 6, findings_blocking: 1, ai_calls: 4, tokens_in: '10000', tokens_out: '2000', usd_estimated: 0.5 },
      { day: '2026-09-03', surface: 'hosted-fix', key_owner: 'byok', events: 1, modules_run: 2, findings_total: 3, findings_blocking: 0, ai_calls: 2, tokens_in: '5000', tokens_out: '1000', usd_estimated: 0.25 },
    ];
    assert.deepStrictEqual(Ledger.aggregateUsageRows(grouped, WINDOW), Ledger.aggregateUsageRows(RAW_ROWS, WINDOW));
  });

  test('empty input is an honest zero, not an error', () => {
    const { totals, bySurface, series } = Ledger.aggregateUsageRows([], WINDOW);
    assert.strictEqual(totals.events, 0);
    assert.deepStrictEqual(bySurface, {});
    assert.strictEqual(series.length, 3);
  });
});

describe('summarizeUsage', () => {
  test('queries only the caller\'s keys inside the window and returns the shape', async () => {
    const sql = fakeSql([[
      { day: '2026-09-01', surface: 'web', key_owner: 'gatetest', events: 2, modules_run: 242, findings_total: 4, findings_blocking: 0, ai_calls: 0, tokens_in: 0, tokens_out: 0, usd_estimated: 0 },
    ]]);
    const out = await Ledger.summarizeUsage(sql, [EMAIL_KEY, 'apikey:k1'], WINDOW);
    const select = sql.queries.find((q) => q.text.startsWith('SELECT'));
    assert.ok(select.text.includes('FROM usage_events WHERE account_key = ANY(?)'), select.text);
    assert.deepStrictEqual(select.values[0], [EMAIL_KEY, 'apikey:k1']);
    assert.strictEqual(select.values[1], WINDOW.from.toISOString());
    assert.strictEqual(select.values[2], WINDOW.to.toISOString());
    assert.ok(select.text.includes('GROUP BY 1, 2, 3'));
    assert.strictEqual(out.totals.events, 2);
    assert.strictEqual(out.totals.scans, 2);
    assert.strictEqual(out.bySurface.web.modulesRun, 242);
    assert.strictEqual(out.series.length, 3);
    assert.strictEqual(out.window.from, WINDOW.from.toISOString());
  });

  test('rejects an empty identity', async () => {
    await assert.rejects(Ledger.summarizeUsage(fakeSql(), [], WINDOW), /accountKey is required/);
    await assert.rejects(Ledger.summarizeUsage(fakeSql(), '', WINDOW), /accountKey is required/);
  });
});

// ---------------------------------------------------------------------------
// listUsage — pagination
// ---------------------------------------------------------------------------

function eventRow(id, extra = {}) {
  return {
    id, occurred_at: `2026-09-0${(id % 9) + 1}T00:00:00Z`, account_key: EMAIL_KEY, surface: 'web', repo: 'acme/widgets',
    suite: 'full', modules_run: 1, findings_total: 0, findings_blocking: 0, ai_calls: 0, tokens_in: 0, tokens_out: 0,
    usd_estimated: 0, key_owner: 'gatetest', model_tier: null, scan_id: null, tier: 'full', ...extra,
  };
}

describe('listUsage', () => {
  test('first page: fetches limit+1, returns limit, and a cursor when more exist', async () => {
    const sql = fakeSql([[eventRow(10), eventRow(9), eventRow(8)]]);
    const out = await Ledger.listUsage(sql, EMAIL_KEY, { limit: 2 });
    const select = sql.queries.find((q) => q.text.startsWith('SELECT'));
    assert.ok(select.text.includes('WHERE account_key = ANY(?)'));
    assert.deepStrictEqual(select.values[0], [EMAIL_KEY]);
    assert.ok(!select.text.includes('id < ?'), 'no cursor clause on the first page');
    assert.strictEqual(select.values[select.values.length - 1], 3, 'LIMIT is limit + 1');
    assert.strictEqual(out.events.length, 2);
    assert.deepStrictEqual(out.events.map((e) => e.id), [10, 9]);
    assert.strictEqual(out.nextCursor, 9);
    // Public shape, camelCase, no account_key leak.
    assert.strictEqual(out.events[0].surface, 'web');
    assert.strictEqual(out.events[0].keyOwner, 'gatetest');
    assert.ok(!('account_key' in out.events[0]) && !('accountKey' in out.events[0]));
  });

  test('next page: applies the cursor and ends with a null cursor', async () => {
    const sql = fakeSql([[eventRow(8), eventRow(7)]]);
    const out = await Ledger.listUsage(sql, EMAIL_KEY, { limit: 2, cursor: '9' });
    const select = sql.queries.find((q) => q.text.startsWith('SELECT'));
    assert.ok(select.text.includes('AND id < ?'), select.text);
    assert.ok(select.values.includes(9));
    assert.deepStrictEqual(out.events.map((e) => e.id), [8, 7]);
    assert.strictEqual(out.nextCursor, null);
  });

  test('clamps the limit and ignores a garbage cursor', async () => {
    const sql = fakeSql([[]]);
    await Ledger.listUsage(sql, EMAIL_KEY, { limit: 10000, cursor: 'banana' });
    const select = sql.queries.find((q) => q.text.startsWith('SELECT'));
    assert.strictEqual(select.values[select.values.length - 1], Ledger.MAX_LIST_LIMIT + 1);
    assert.ok(!select.text.includes('id < ?'));
  });
});

// ---------------------------------------------------------------------------
// parseUsageWindow
// ---------------------------------------------------------------------------

describe('parseUsageWindow', () => {
  const NOW = new Date('2026-09-16T12:00:00Z');

  test('defaults to the last 30 days ending now', () => {
    const w = Ledger.parseUsageWindow(new URLSearchParams(''), NOW);
    assert.strictEqual(w.ok, true);
    assert.strictEqual(w.to.toISOString(), NOW.toISOString());
    assert.strictEqual(w.from.toISOString(), '2026-08-18T00:00:00.000Z');
  });

  test('accepts ISO dates; a bare `to` date covers the whole day', () => {
    const w = Ledger.parseUsageWindow(new URLSearchParams('from=2026-09-01&to=2026-09-10'), NOW);
    assert.strictEqual(w.ok, true);
    assert.strictEqual(w.from.toISOString(), '2026-09-01T00:00:00.000Z');
    assert.strictEqual(w.to.toISOString(), '2026-09-10T23:59:59.999Z');
  });

  test('rejects garbage, inverted and oversized windows', () => {
    assert.strictEqual(Ledger.parseUsageWindow({ from: 'yesterday' }, NOW).ok, false);
    assert.strictEqual(Ledger.parseUsageWindow({ to: '2026-13-40' }, NOW).ok, false);
    assert.strictEqual(Ledger.parseUsageWindow({ from: '2026-09-10', to: '2026-09-01' }, NOW).ok, false);
    assert.strictEqual(Ledger.parseUsageWindow({ from: '2024-01-01', to: '2026-09-01' }, NOW).ok, false);
  });
});

// ---------------------------------------------------------------------------
// handleUsageRequest — the GET /api/v1/usage logic
// ---------------------------------------------------------------------------

describe('handleUsageRequest', () => {
  test('rejects an unauthenticated request with 401 and never touches the database', async () => {
    let dbTouched = false;
    const out = await Ledger.handleUsageRequest({
      auth: { ok: false, status: 401, error: 'Missing API key — pass Authorization: Bearer <key> or X-API-Key header' },
      searchParams: new URLSearchParams(''),
      getSql: () => { dbTouched = true; return fakeSql(); },
    });
    assert.strictEqual(out.status, 401);
    assert.strictEqual(out.body.code, 'AUTH_FAILED');
    assert.strictEqual(dbTouched, false);
  });

  test('a revoked key keeps its 403; a missing auth object is 401', async () => {
    const revoked = await Ledger.handleUsageRequest({
      auth: { ok: false, status: 403, error: 'API key is revoked' },
      searchParams: null,
      getSql: () => fakeSql(),
    });
    assert.strictEqual(revoked.status, 403);
    const missing = await Ledger.handleUsageRequest({ auth: undefined, searchParams: null, getSql: () => fakeSql() });
    assert.strictEqual(missing.status, 401);
  });

  test('a bad window is 400 before any query', async () => {
    let dbTouched = false;
    const out = await Ledger.handleUsageRequest({
      auth: { ok: true, key: { id: 'k1', customer_email: 'ada@example.com' } },
      searchParams: new URLSearchParams('from=nope'),
      getSql: () => { dbTouched = true; return fakeSql(); },
    });
    assert.strictEqual(out.status, 400);
    assert.strictEqual(out.body.code, 'BAD_REQUEST');
    assert.strictEqual(dbTouched, false);
  });

  test('control: an authenticated key gets { summary, series, bySurface, recent } scoped to its own keys', async () => {
    const sql = fakeSql([
      [{ day: '2026-09-15', surface: 'hosted-fix', key_owner: 'byok', events: 1, modules_run: 2, findings_total: 3, findings_blocking: 1, ai_calls: 2, tokens_in: 500, tokens_out: 100, usd_estimated: 0.02 }],
      [eventRow(5, { surface: 'hosted-fix', key_owner: 'byok', ai_calls: 2, tokens_in: 500, tokens_out: 100, usd_estimated: 0.02 })],
    ]);
    const out = await Ledger.handleUsageRequest({
      auth: { ok: true, key: { id: 'k1', customer_email: 'ada@example.com' } },
      searchParams: new URLSearchParams('from=2026-09-10&to=2026-09-16'),
      getSql: () => sql,
    });
    assert.strictEqual(out.status, 200);
    assert.deepStrictEqual(Object.keys(out.body).sort(), ['bySurface', 'nextCursor', 'recent', 'series', 'summary']);
    assert.strictEqual(out.body.summary.events, 1);
    assert.strictEqual(out.body.summary.byokEvents, 1);
    assert.strictEqual(out.body.summary.tokensTotal, 600);
    assert.strictEqual(out.body.series.length, 7);
    assert.strictEqual(out.body.recent.length, 1);
    assert.strictEqual(out.body.recent[0].keyOwner, 'byok');
    // Every data query is scoped to exactly this caller's keys.
    const selects = sql.queries.filter((q) => q.text.startsWith('SELECT'));
    assert.strictEqual(selects.length, 2);
    for (const q of selects) {
      assert.deepStrictEqual(q.values[0], [EMAIL_KEY, 'apikey:k1']);
    }
    // Control: another customer's key is never among them.
    const other = Ledger.accountKeyForEmail('bob@example.com');
    assert.ok(!selects.some((q) => q.values[0].includes(other)));
  });

  test('a key with no account link is 403, not another customer\'s data', async () => {
    const out = await Ledger.handleUsageRequest({
      auth: { ok: true, key: { id: '', customer_email: null } },
      searchParams: null,
      getSql: () => fakeSql(),
    });
    assert.strictEqual(out.status, 403);
    assert.strictEqual(out.body.code, 'NO_ACCOUNT');
  });

  test('no database is 503, not a crash', async () => {
    const out = await Ledger.handleUsageRequest({
      auth: { ok: true, key: { id: 'k1', customer_email: 'ada@example.com' } },
      searchParams: null,
      getSql: () => { throw new Error('DATABASE_URL is not set'); },
    });
    assert.strictEqual(out.status, 503);
    assert.strictEqual(out.body.code, 'DB_UNAVAILABLE');
  });
});

// ---------------------------------------------------------------------------
// Writer: the worker tick
// ---------------------------------------------------------------------------

function makeQueueStore(job) {
  const calls = { markDone: [], markFailed: [] };
  return {
    calls,
    reclaimStuck: async () => 0,
    claimNextJob: async () => job,
    markDone: async (id, result) => { calls.markDone.push({ id, result }); },
    markFailed: async (id, err, willRetry) => { calls.markFailed.push({ id, err: String(err), willRetry }); },
  };
}

const JOB = { id: 42, event_id: 'evt-1', repository: 'acme/webapp', sha: 'a'.repeat(40), ref: 'refs/heads/main', pull_request_number: null, host: 'github', attempts: 1 };

function completeScan(extra = {}) {
  return {
    status: 'complete',
    modules: [{ name: 'lint', status: 'passed', checks: 10, issues: 0, duration: 100 }, { name: 'secrets', status: 'failed', checks: 3, issues: 2, duration: 50 }],
    totalModules: 2, completedModules: 2, totalIssues: 2, totalFixed: 0, duration: 1234,
    ...extra,
  };
}

describe('scan-worker usage writer', () => {
  test('records a completed deterministic push scan with ai_calls 0 under the org fallback', async () => {
    const recorded = [];
    const usageStore = {
      ...Ledger,
      recordUsage: async (_sql, event) => { recorded.push(Ledger.normalizeUsageEvent(event)); return { id: 1 }; },
    };
    const queueStore = makeQueueStore(JOB);
    const out = await runWorkerTick({
      sql: () => [],
      queueStore,
      runScan: async () => completeScan(),
      sendCallback: async () => {},
      usageStore,
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(queueStore.calls.markDone.length, 1);
    assert.strictEqual(recorded.length, 1);
    const row = recorded[0];
    assert.strictEqual(row.account_key, 'org:github.com/acme');
    assert.strictEqual(row.surface, 'push');
    assert.strictEqual(row.repo, 'acme/webapp');
    assert.strictEqual(row.suite, 'deterministic');
    assert.strictEqual(row.scan_id, 'evt-1');
    assert.strictEqual(row.modules_run, 2);
    assert.strictEqual(row.findings_total, 2);
    assert.strictEqual(row.ai_calls, 0);
    assert.strictEqual(row.usd_estimated, 0);
    assert.strictEqual(row.key_owner, 'gatetest');
  });

  test('a Continuous subscriber\'s push scan is keyed on their e-mail and carries the AI module cost', async () => {
    const recorded = [];
    const usageStore = {
      ...Ledger,
      recordUsage: async (_sql, event) => { recorded.push(Ledger.normalizeUsageEvent(event)); return { id: 1 }; },
    };
    const continuousStore = {
      findActiveByRepo: async () => ({ stripe_subscription_id: 'sub_1', stripe_customer_id: 'cus_1', customer_email: 'ada@example.com', repo_url: 'github.com/acme/webapp', status: 'active' }),
      checkAiAllowance: async () => ({ allowed: true }),
      recordAiSpend: async () => {},
    };
    await runWorkerTick({
      sql: () => [],
      queueStore: makeQueueStore(JOB),
      runScan: async () => completeScan({ modules: [{ name: 'lint', status: 'passed', checks: 1, issues: 0, duration: 1 }, { name: 'aiReview', status: 'passed', checks: 5, issues: 0, duration: 900, costUsd: 0.04, tokensIn: 8000, tokensOut: 600 }] }),
      sendCallback: async () => {},
      continuousStore,
      usageStore,
    });
    assert.strictEqual(recorded.length, 1);
    assert.strictEqual(recorded[0].account_key, EMAIL_KEY);
    assert.strictEqual(recorded[0].suite, 'full');
    assert.strictEqual(recorded[0].tier, 'continuous');
    assert.strictEqual(recorded[0].ai_calls, 1);
    assert.strictEqual(recorded[0].tokens_in, 8000);
    assert.strictEqual(recorded[0].tokens_out, 600);
    assert.strictEqual(recorded[0].usd_estimated, 0.04);
  });

  test('a ledger failure is one warning; the tick still succeeds and the callback still fires', async () => {
    const usageStore = { ...Ledger, recordUsage: async () => { throw new Error('ledger down'); } };
    const queueStore = makeQueueStore(JOB);
    let callbacks = 0;
    let out;
    const warnings = await withWarnCapture(async () => {
      out = await runWorkerTick({
        sql: () => [],
        queueStore,
        runScan: async () => completeScan(),
        sendCallback: async () => { callbacks += 1; },
        usageStore,
      });
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.ran, 42);
    assert.strictEqual(queueStore.calls.markDone.length, 1);
    assert.strictEqual(callbacks, 1);
    assert.strictEqual(warnings.filter((w) => /usage ledger/.test(w)).length, 1);
  });

  test('control: a failed scan writes no usage row; no usageStore writes nothing', async () => {
    const recorded = [];
    const usageStore = { ...Ledger, recordUsage: async (_sql, event) => { recorded.push(event); return { id: 1 }; } };
    await runWorkerTick({
      sql: () => [],
      queueStore: makeQueueStore(JOB),
      runScan: async () => completeScan({ status: 'failed', error: 'boom' }),
      sendCallback: async () => {},
      usageStore,
    });
    assert.strictEqual(recorded.length, 0);
    const out = await runWorkerTick({
      sql: () => [],
      queueStore: makeQueueStore(JOB),
      runScan: async () => completeScan(),
      sendCallback: async () => {},
    });
    assert.strictEqual(out.ok, true);
  });
});

// ---------------------------------------------------------------------------
// Source contracts — the TS routes cannot be require()d (next/server), so the
// wiring is pinned by text: same auth helper, best-effort writer, no PII.
// ---------------------------------------------------------------------------

describe('route wiring (source contracts)', () => {
  const usageRoute = read('website/app/api/v1/usage/route.ts');
  const scansRoute = read('website/app/api/v1/scans/route.ts');
  const fixRoute = read('website/app/api/scan/fix/route.ts');
  const runRoute = read('website/app/api/scan/run/route.ts');
  const executor = read('website/app/lib/scan-executor.ts');
  const tickRoute = read('website/app/api/scan/worker/tick/route.ts');

  test('GET /api/v1/usage authenticates with the same helper as /api/v1/scans and fails closed', () => {
    assert.ok(scansRoute.includes('authenticateApiKey(req)'), 'control: /api/v1/scans uses the helper');
    assert.ok(usageRoute.includes('import { authenticateApiKey, recordApiCall } from "@/app/lib/api-key"'));
    assert.ok(usageRoute.includes('const auth = await authenticateApiKey(req);'));
    assert.ok(usageRoute.includes('{ status: auth.status }'), 'auth failure status is passed through');
    assert.ok(usageRoute.includes('handleUsageRequest({'), 'delegates to the tested helper');
    assert.ok(usageRoute.indexOf('authenticateApiKey(req)') < usageRoute.indexOf('handleUsageRequest({'), 'auth precedes any query');
    assert.ok(usageRoute.includes('export async function GET('));
    assert.ok(!usageRoute.includes('export async function POST('), 'read-only endpoint');
    assert.ok(usageRoute.includes('"Cache-Control": "private, no-store"'));
  });

  test('the hosted fix route records usage from the budget tracker, inside try/catch, on both outcomes', () => {
    assert.ok(fixRoute.includes('require("@/app/lib/usage-ledger")'));
    const writes = fixRoute.split('await recordUsageIfConfigured({').length - 1;
    assert.strictEqual(writes, 2, 'one write after budgetSummary, one on the 402 budget-exceeded path');
    assert.ok(fixRoute.includes('surface: "hosted-fix"'));
    assert.ok(fixRoute.includes('keyOwner: trackerSnap.byok ? "byok" : "gatetest"'));
    assert.ok(fixRoute.includes('tokensIn: trackerSnap.inputTokens'));
    assert.ok(fixRoute.includes('usdEstimated: trackerSnap.estimatedUsd'));
    assert.ok(fixRoute.includes('usage ledger write failed (scan/fix, continuing)'));
    assert.ok(fixRoute.includes('customerEmail: existing.customer_details?.email || existing.customer_email || null'), 'checkout e-mail resolved for identity');
    assert.ok(!fixRoute.includes('anthropicApiKey: input.anthropicApiKey') || !/recordUsageIfConfigured\([\s\S]{0,800}anthropicApiKey/.test(fixRoute), 'the BYOK key never reaches the ledger');
  });

  test('the hosted scan routes record usage best-effort with ai totals from the modules', () => {
    for (const [name, src] of [['scan/run', runRoute], ['scan-executor', executor]]) {
      assert.ok(src.includes('recordUsageIfConfigured({'), `${name} writes usage`);
      assert.ok(src.includes('surface: "web"'), `${name} surface`);
      assert.ok(src.includes('aiTotalsFromModules(result.modules)'), `${name} ai totals`);
      assert.ok(src.includes('countBlockingFindings(result)'), `${name} blocking count`);
      assert.ok(src.includes('usage ledger write failed'), `${name} warns, never throws`);
    }
    assert.ok(tickRoute.includes('const usageStore = require("@/app/lib/usage-ledger")'));
    assert.ok(tickRoute.includes('usageStore,'), 'worker tick injects the ledger');
  });

  test('the ledger module names no AI vendor in customer-facing output', () => {
    const src = read('website/app/lib/usage-ledger.js');
    const strings = (src.match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) || []).join('\n');
    assert.ok(!/\b(claude|anthropic|fable|sonnet|opus|haiku|openai)\b/i.test(strings), 'no vendor or model name in any string literal');
  });
});
