/**
 * Tests for website/app/lib/continuous-subscription-store.js — the $49/mo
 * Continuous tier's persistence layer (Craig green-light 2026-06-12).
 *
 * Uses a fake Neon tagged-template `sql` recorder, same approach as the
 * scan-queue-store tests: queries are captured as flattened strings and
 * canned row sets are returned in order.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const Store = require('../website/app/lib/continuous-subscription-store');

/**
 * Fake sql tagged-template: records queries, returns queued results.
 * Schema statements (CREATE TABLE / CREATE INDEX / ALTER) always return []
 * without consuming the queue, so tests only queue results for data queries.
 */
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

// ---------------------------------------------------------------------------
// normalizeRepoUrl
// ---------------------------------------------------------------------------

describe('normalizeRepoUrl', () => {
  test('lowercases and strips protocol, .git, trailing slash', () => {
    assert.strictEqual(
      Store.normalizeRepoUrl('https://GitHub.com/Acme/Widgets.git/'),
      'github.com/acme/widgets'
    );
  });

  test('converts ssh form', () => {
    assert.strictEqual(
      Store.normalizeRepoUrl('git@github.com:acme/widgets.git'),
      'github.com/acme/widgets'
    );
  });

  test('accepts gluecron URLs', () => {
    assert.strictEqual(
      Store.normalizeRepoUrl('https://gluecron.com/acme/widgets'),
      'gluecron.com/acme/widgets'
    );
  });

  test('rejects garbage', () => {
    assert.strictEqual(Store.normalizeRepoUrl(''), null);
    assert.strictEqual(Store.normalizeRepoUrl('   '), null);
    assert.strictEqual(Store.normalizeRepoUrl('no-slash'), null);
    assert.strictEqual(Store.normalizeRepoUrl(null), null);
    assert.strictEqual(Store.normalizeRepoUrl(42), null);
  });
});

// ---------------------------------------------------------------------------
// monthKey + budget
// ---------------------------------------------------------------------------

describe('monthKey / monthlyAiBudgetUsd', () => {
  test('formats UTC month', () => {
    assert.strictEqual(Store.monthKey(new Date(Date.UTC(2026, 5, 12))), '2026-06');
    assert.strictEqual(Store.monthKey(new Date(Date.UTC(2026, 11, 1))), '2026-12');
  });

  test('default budget is 10 USD', () => {
    const prev = process.env.CONTINUOUS_AI_BUDGET_USD;
    delete process.env.CONTINUOUS_AI_BUDGET_USD;
    assert.strictEqual(Store.monthlyAiBudgetUsd(), 10);
    if (prev !== undefined) process.env.CONTINUOUS_AI_BUDGET_USD = prev;
  });

  test('env override wins, garbage env falls back', () => {
    const prev = process.env.CONTINUOUS_AI_BUDGET_USD;
    process.env.CONTINUOUS_AI_BUDGET_USD = '25';
    assert.strictEqual(Store.monthlyAiBudgetUsd(), 25);
    process.env.CONTINUOUS_AI_BUDGET_USD = 'banana';
    assert.strictEqual(Store.monthlyAiBudgetUsd(), 10);
    if (prev !== undefined) process.env.CONTINUOUS_AI_BUDGET_USD = prev;
    else delete process.env.CONTINUOUS_AI_BUDGET_USD;
  });
});

// ---------------------------------------------------------------------------
// upsertSubscription
// ---------------------------------------------------------------------------

describe('upsertSubscription', () => {
  test('writes normalised repo and returns the row', async () => {
    const sql = fakeSql([[{ id: 1, stripe_subscription_id: 'sub_1', repo_url: 'github.com/acme/widgets', status: 'active' }]]);
    const row = await Store.upsertSubscription(sql, {
      stripeSubscriptionId: 'sub_1',
      stripeCustomerId: 'cus_1',
      repoUrl: 'https://GitHub.com/Acme/Widgets.git',
      status: 'active',
    });
    assert.strictEqual(row.stripe_subscription_id, 'sub_1');
    const insert = sql.queries.find((q) => q.text.includes('INSERT INTO continuous_subscriptions'));
    assert.ok(insert, 'insert query issued');
    assert.ok(insert.values.includes('github.com/acme/widgets'), 'repo url normalised');
    assert.ok(insert.text.includes('ON CONFLICT (stripe_subscription_id)'), 'idempotent upsert');
  });

  test('invalid status coerces to active', async () => {
    const sql = fakeSql([[{ id: 1 }]]);
    await Store.upsertSubscription(sql, {
      stripeSubscriptionId: 'sub_2',
      repoUrl: 'github.com/a/b',
      status: 'weird',
    });
    const insert = sql.queries.find((q) => q.text.includes('INSERT INTO continuous_subscriptions'));
    assert.ok(insert.values.includes('active'));
  });

  test('rejects missing subscription id / bad repo', async () => {
    const sql = fakeSql();
    await assert.rejects(() => Store.upsertSubscription(sql, { repoUrl: 'github.com/a/b' }), /stripeSubscriptionId/);
    await assert.rejects(
      () => Store.upsertSubscription(sql, { stripeSubscriptionId: 'sub_3', repoUrl: 'garbage' }),
      /valid repoUrl/
    );
  });
});

// ---------------------------------------------------------------------------
// setSubscriptionStatus
// ---------------------------------------------------------------------------

describe('setSubscriptionStatus', () => {
  test('updates status', async () => {
    const sql = fakeSql([[{ id: 1, stripe_subscription_id: 'sub_1', status: 'canceled' }]]);
    const row = await Store.setSubscriptionStatus(sql, 'sub_1', 'canceled');
    assert.strictEqual(row.status, 'canceled');
  });

  test('rejects unknown status', async () => {
    const sql = fakeSql();
    await assert.rejects(() => Store.setSubscriptionStatus(sql, 'sub_1', 'paused'), /invalid status/);
  });
});

// ---------------------------------------------------------------------------
// findActiveByRepo
// ---------------------------------------------------------------------------

describe('findActiveByRepo', () => {
  test('returns the active subscription', async () => {
    const sql = fakeSql([[{ stripe_subscription_id: 'sub_1', repo_url: 'github.com/acme/widgets', status: 'active' }]]);
    const row = await Store.findActiveByRepo(sql, 'https://github.com/Acme/Widgets');
    assert.strictEqual(row.stripe_subscription_id, 'sub_1');
    const select = sql.queries.find((q) => q.text.includes('FROM continuous_subscriptions'));
    assert.ok(select.text.includes("status = 'active'"));
  });

  test('returns null for no match or bad url', async () => {
    const sql = fakeSql([[]]);
    assert.strictEqual(await Store.findActiveByRepo(sql, 'github.com/none/here'), null);
    assert.strictEqual(await Store.findActiveByRepo(fakeSql(), 'garbage'), null);
  });
});

// ---------------------------------------------------------------------------
// AI ledger
// ---------------------------------------------------------------------------

describe('AI allowance ledger', () => {
  test('getMonthUsage returns zeros for empty ledger', async () => {
    const sql = fakeSql([[]]);
    const usage = await Store.getMonthUsage(sql, 'sub_1', '2026-06');
    assert.deepStrictEqual(usage, { spentUsd: 0, aiScans: 0 });
  });

  test('recordAiSpend issues an upsert with the amount', async () => {
    const sql = fakeSql([[]]);
    await Store.recordAiSpend(sql, 'sub_1', 1.25, '2026-06');
    const insert = sql.queries.find((q) => q.text.includes('INSERT INTO continuous_ai_ledger'));
    assert.ok(insert, 'ledger upsert issued');
    assert.ok(insert.values.includes(1.25));
    assert.ok(insert.text.includes('ON CONFLICT (subscription_id, month)'));
  });

  test('recordAiSpend clamps negative/NaN to 0', async () => {
    const sql = fakeSql([[]]);
    await Store.recordAiSpend(sql, 'sub_1', -5, '2026-06');
    const insert = sql.queries.find((q) => q.text.includes('INSERT INTO continuous_ai_ledger'));
    assert.ok(insert.values.includes(0));
  });

  test('checkAiAllowance allows under budget, blocks at budget', async () => {
    const under = fakeSql([[{ spent_usd: 4.5, ai_scans: 9 }]]);
    const ok = await Store.checkAiAllowance(under, 'sub_1', { budgetUsd: 10, month: '2026-06' });
    assert.strictEqual(ok.allowed, true);
    assert.strictEqual(ok.spentUsd, 4.5);
    assert.strictEqual(ok.remainingUsd, 5.5);
    assert.strictEqual(ok.budgetUsd, 10);

    const over = fakeSql([[{ spent_usd: 10.01, ai_scans: 22 }]]);
    const blocked = await Store.checkAiAllowance(over, 'sub_1', { budgetUsd: 10, month: '2026-06' });
    assert.strictEqual(blocked.allowed, false);
    assert.strictEqual(blocked.remainingUsd, 0);
  });

  test('checkAiAllowance uses the env/default budget when none supplied', async () => {
    const prev = process.env.CONTINUOUS_AI_BUDGET_USD;
    delete process.env.CONTINUOUS_AI_BUDGET_USD;
    const sql = fakeSql([[{ spent_usd: 9.99, ai_scans: 1 }]]);
    const res = await Store.checkAiAllowance(sql, 'sub_1', { month: '2026-06' });
    assert.strictEqual(res.budgetUsd, 10);
    assert.strictEqual(res.allowed, true);
    if (prev !== undefined) process.env.CONTINUOUS_AI_BUDGET_USD = prev;
  });
});
