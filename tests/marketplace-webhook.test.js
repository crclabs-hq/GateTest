// ============================================================================
// MARKETPLACE-WEBHOOK TEST — Coverage for POST /api/marketplace/webhook
// ============================================================================
// Verifies website/app/lib/marketplace-webhook.js (the pure handler the thin
// route at website/app/api/marketplace/webhook/route.ts delegates to — same
// shape as processGitHubEvent in github-events.js, which
// tests/github-events.test.js covers the same way; a .ts route file cannot be
// loaded from node:test, so the logic lives in a plain module instead) and
// website/app/lib/marketplace-purchase-store.js (the persistence layer).
//
// This is a DISTINCT webhook from the GitHub App's push/PR webhook at
// /api/webhook — different secret (GITHUB_MARKETPLACE_WEBHOOK_SECRET),
// different event (marketplace_purchase), no scan_queue involvement.
//
// Covered:
//   - missing secret -> 503, zero inserts
//   - tampered / missing signature -> 401, zero inserts
//   - ping -> 200, database never touched
//   - an event that is neither marketplace_purchase nor ping -> 202 ignored
//   - valid signature + purchased -> 200, exactly one INSERT with exactly
//     the documented columns, and no e-mail anywhere in the stored values
//   - a redelivered X-GitHub-Delivery id is idempotent (ON CONFLICT DO
//     NOTHING) -- one row, not two
//   - ensureSchema issues the documented CREATE TABLE
// ============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const path = require('path');

const { processMarketplaceWebhookEvent } = require(path.resolve(
  __dirname, '..', 'website', 'app', 'lib', 'marketplace-webhook.js',
));
const purchaseStore = require(path.resolve(
  __dirname, '..', 'website', 'app', 'lib', 'marketplace-purchase-store.js',
));

const SECRET = 'test-marketplace-webhook-secret-0123456789abcdef';
const DELIVERY = '11111111-2222-3333-4444-555555555555';

function hmacHeader(body, secret = SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/** A realistic GitHub `marketplace_purchase` payload — carries a sender AND
 * an account e-mail on purpose, so the "never store an e-mail" assertion has
 * something real to catch. */
function purchasePayload(overrides = {}) {
  return {
    action: 'purchased',
    effective_date: '2026-09-19T00:00:00+00:00',
    sender: { login: 'alice', email: 'alice@example.com', type: 'User' },
    marketplace_purchase: {
      account: { type: 'Organization', id: 24596500, login: 'alice-org', email: 'alice-org@example.com' },
      plan: { id: 435, name: 'Free' },
      on_free_trial: false,
    },
    ...overrides,
  };
}

/** Fake tagged-template SQL — reproduces the Neon tagged-template signature,
 * same helper shape as tests/scan-queue-store.test.js. */
function makeFakeSql(responses = []) {
  const calls = [];
  const queue = [...responses];
  const fakeSql = (strings, ...values) => {
    const text = strings.join('?');
    calls.push({ text, values });
    const next = queue.length > 0 ? queue.shift() : [];
    return Promise.resolve(next);
  };
  fakeSql.calls = calls;
  return fakeSql;
}

function baseArgs(overrides = {}) {
  const payload = overrides.payload || purchasePayload();
  const rawBody = overrides.rawBody || JSON.stringify(payload);
  return {
    rawBody,
    eventType: 'marketplace_purchase',
    delivery: DELIVERY,
    signatureHeader: overrides.signatureHeader !== undefined ? overrides.signatureHeader : hmacHeader(rawBody),
    env: { GITHUB_MARKETPLACE_WEBHOOK_SECRET: SECRET },
    purchaseStore,
    getSql: () => makeFakeSql(),
    ...overrides,
  };
}

describe('processMarketplaceWebhookEvent — fails closed on secret / signature', () => {
  it('missing GITHUB_MARKETPLACE_WEBHOOK_SECRET -> 503, database never touched', async () => {
    const sql = makeFakeSql();
    const result = await processMarketplaceWebhookEvent(baseArgs({ env: {}, getSql: () => sql }));
    assert.strictEqual(result.status, 503);
    assert.deepStrictEqual(result.body, { error: 'marketplace webhook not configured' });
    assert.strictEqual(sql.calls.length, 0, 'zero inserts when unconfigured');
  });

  it('tampered body -> 401, zero inserts', async () => {
    const sql = makeFakeSql();
    const payload = purchasePayload();
    const rawBody = JSON.stringify(payload);
    const result = await processMarketplaceWebhookEvent(baseArgs({
      payload,
      rawBody: rawBody + 'tampered-suffix',
      signatureHeader: hmacHeader(rawBody), // signed over the ORIGINAL, unmodified body
      getSql: () => sql,
    }));
    assert.strictEqual(result.status, 401);
    assert.strictEqual(sql.calls.length, 0);
  });

  it('missing signature header -> 401, zero inserts', async () => {
    const sql = makeFakeSql();
    const result = await processMarketplaceWebhookEvent(baseArgs({ signatureHeader: null, getSql: () => sql }));
    assert.strictEqual(result.status, 401);
    assert.strictEqual(sql.calls.length, 0);
  });
});

describe('processMarketplaceWebhookEvent — ping and unhandled events', () => {
  it('ping -> 200 { ok: true, event: "ping" }, database never touched', async () => {
    const sql = makeFakeSql();
    const rawBody = JSON.stringify({ zen: 'hello' });
    const result = await processMarketplaceWebhookEvent(baseArgs({
      rawBody,
      eventType: 'ping',
      signatureHeader: hmacHeader(rawBody),
      getSql: () => sql,
    }));
    assert.strictEqual(result.status, 200);
    assert.deepStrictEqual(result.body, { ok: true, event: 'ping' });
    assert.strictEqual(sql.calls.length, 0);
  });

  it('any event other than marketplace_purchase/ping -> 202 { ignored: true }, database never touched', async () => {
    const sql = makeFakeSql();
    const rawBody = JSON.stringify({ action: 'created' });
    const result = await processMarketplaceWebhookEvent(baseArgs({
      rawBody,
      eventType: 'installation',
      signatureHeader: hmacHeader(rawBody),
      getSql: () => sql,
    }));
    assert.strictEqual(result.status, 202);
    assert.deepStrictEqual(result.body, { ignored: true });
    assert.strictEqual(sql.calls.length, 0);
  });
});

describe('processMarketplaceWebhookEvent — marketplace_purchase persists exactly the allowed columns', () => {
  it('valid signature + purchased -> 200, exactly one INSERT, no e-mail anywhere in the stored values', async () => {
    const sql = makeFakeSql([[], [{ id: 1 }]]); // ensureSchema's CREATE, then the INSERT
    const payload = purchasePayload();
    const result = await processMarketplaceWebhookEvent(baseArgs({ payload, getSql: () => sql }));

    assert.strictEqual(result.status, 200);
    assert.deepStrictEqual(result.body, { ok: true, event: 'marketplace_purchase' });

    const inserts = sql.calls.filter((c) => /INSERT INTO\s+marketplace_purchases/i.test(c.text));
    assert.strictEqual(inserts.length, 1, 'exactly one insert');
    const insert = inserts[0];
    assert.match(
      insert.text,
      /\(\s*delivery_id,\s*action,\s*account_login,\s*account_type,\s*account_id,\s*plan_name,\s*plan_id,\s*on_free_trial,\s*effective_date\s*\)/i,
      'the INSERT column list must be exactly the documented, allowed columns',
    );
    assert.match(insert.text, /ON CONFLICT \(delivery_id\) DO NOTHING/i);
    assert.deepStrictEqual(insert.values, [
      DELIVERY,
      'purchased',
      'alice-org',
      'Organization',
      24596500,
      'Free',
      435,
      false,
      '2026-09-19T00:00:00+00:00',
    ]);

    assert.ok(
      !insert.values.some((v) => typeof v === 'string' && v.includes('@')),
      'no e-mail address (sender or account) is ever bound into the stored record',
    );
  });
});

describe('recordPurchaseEvent — idempotent on delivery_id (GitHub redelivery-safe)', () => {
  it('a redelivered X-GitHub-Delivery id is a no-op the second time — one row, not two', async () => {
    // Call order: ensureSchema (CREATE) + INSERT, twice.
    const sql = makeFakeSql([[], [{ id: 7 }], [], []]);
    const payload = purchasePayload();

    const first = await purchaseStore.recordPurchaseEvent(sql, { deliveryId: DELIVERY, payload });
    const second = await purchaseStore.recordPurchaseEvent(sql, { deliveryId: DELIVERY, payload });

    assert.strictEqual(first.inserted, true);
    assert.strictEqual(first.id, 7);
    assert.strictEqual(second.inserted, false, 'ON CONFLICT DO NOTHING -> no second row');
    assert.strictEqual(second.id, null);

    const inserts = sql.calls.filter((c) => /INSERT INTO\s+marketplace_purchases/i.test(c.text));
    assert.strictEqual(inserts.length, 2, 'both attempts issue the same idempotent statement');
    for (const c of inserts) assert.match(c.text, /ON CONFLICT \(delivery_id\) DO NOTHING/i);
  });

  it('rejects when sql or deliveryId is missing', async () => {
    await assert.rejects(
      () => purchaseStore.recordPurchaseEvent(undefined, { deliveryId: DELIVERY, payload: {} }),
      /sql tagged-template is required/,
    );
    await assert.rejects(
      () => purchaseStore.recordPurchaseEvent(makeFakeSql(), { payload: {} }),
      /deliveryId is required/,
    );
  });
});

describe('ensureSchema', () => {
  it('issues CREATE TABLE IF NOT EXISTS with exactly the documented columns', async () => {
    const sql = makeFakeSql();
    await purchaseStore.ensureSchema(sql);
    const joined = sql.calls.map((c) => c.text).join('\n');
    assert.match(joined, /CREATE TABLE IF NOT EXISTS marketplace_purchases/);
    assert.match(joined, /delivery_id TEXT UNIQUE/);
    assert.match(joined, /account_id BIGINT/);
    assert.match(joined, /plan_id BIGINT/);
    assert.match(joined, /on_free_trial BOOLEAN/);
    assert.match(joined, /effective_date TIMESTAMPTZ/);
    assert.match(joined, /received_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
  });
});

describe('extractPurchaseFields — never returns the sender or an e-mail', () => {
  it('reduces a realistic payload to exactly the stored fields', () => {
    const fields = purchaseStore.extractPurchaseFields(purchasePayload());
    assert.deepStrictEqual(fields, {
      action: 'purchased',
      account_login: 'alice-org',
      account_type: 'Organization',
      account_id: 24596500,
      plan_name: 'Free',
      plan_id: 435,
      on_free_trial: false,
      effective_date: '2026-09-19T00:00:00+00:00',
    });
    assert.ok(!('sender' in fields) && !('email' in fields));
  });
});
