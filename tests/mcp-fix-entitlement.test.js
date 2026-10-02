'use strict';

// HOSTED MCP fix_issue — the subscription key is the payment proof.
// Audit 2026-10-02: the $29/mo hosted MCP's flagship tool POSTed to
// /api/scan/fix with no sessionId and no auth, and the route answered 402
// "Missing sessionId" to every paying subscriber.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { verifyMcpFixEntitlement } = require('../website/app/lib/mcp-fix-entitlement');
const { createMcpCore } = require('../website/app/lib/mcp-remote-core.cjs');

const KEY = `gtmcp_${'a'.repeat(64)}`;
const sql = () => {};
const store = (row) => async (_sql, key) => (key === KEY ? row : null);

describe('verifyMcpFixEntitlement', () => {
  it('no gtmcp_ key → none (the checkout-session path decides)', async () => {
    assert.deepEqual(await verifyMcpFixEntitlement({ headers: new Headers(), sql, findByApiKey: store(null) }), { state: 'none' });
    assert.deepEqual(await verifyMcpFixEntitlement({ headers: new Headers({ authorization: 'Bearer ghp_x' }), sql, findByApiKey: store(null) }), { state: 'none' });
  });

  it('an active subscription → active, with the e-mail for the usage ledger', async () => {
    const r = await verifyMcpFixEntitlement({
      headers: new Headers({ authorization: `Bearer ${KEY}` }),
      sql,
      findByApiKey: store({ status: 'active', stripeSubscriptionId: 'sub_1', customerEmail: 'a@b.co' }),
    });
    assert.deepEqual(r, { state: 'active', customerEmail: 'a@b.co', subscriptionId: 'sub_1' });
  });

  it('control: cancelled, unknown and malformed keys are inactive — never "paid"', async () => {
    const h = new Headers({ authorization: `Bearer ${KEY}` });
    assert.equal((await verifyMcpFixEntitlement({ headers: h, sql, findByApiKey: store({ status: 'canceled' }) })).state, 'inactive');
    assert.equal((await verifyMcpFixEntitlement({ headers: h, sql, findByApiKey: store(null) })).state, 'inactive');
    assert.equal((await verifyMcpFixEntitlement({ headers: new Headers({ authorization: 'Bearer gtmcp_short' }), sql, findByApiKey: store({ status: 'active' }) })).state, 'inactive');
  });

  it('an unreadable store is not_checked with the reason (not inactive, not active)', async () => {
    const h = new Headers({ authorization: `Bearer ${KEY}` });
    const r = await verifyMcpFixEntitlement({ headers: h, sql, findByApiKey: async () => { throw new Error('neon down'); } });
    assert.deepEqual(r, { state: 'not_checked', reason: 'neon down' });
    assert.equal((await verifyMcpFixEntitlement({ headers: h, sql: null, findByApiKey: store({ status: 'active' }) })).state, 'not_checked');
  });
});

describe('hosted MCP fix_issue forwards the key', () => {
  it('POSTs /api/scan/fix with Authorization: Bearer <the caller\'s gtmcp_ key>', async () => {
    const seen = [];
    const fetchImpl = async (url, init = {}) => {
      seen.push({ url, init });
      if (String(url).includes('/api/mcp/validate')) return { ok: true, status: 200, json: async () => ({ valid: true }) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ prUrl: 'https://github.com/o/r/pull/1' }) };
    };
    const core = createMcpCore({ apiBase: 'https://gt.example', fetchImpl });
    const res = await core.handleRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fix_issue', arguments: { repoUrl: 'https://github.com/o/r', file: 'a.js', issue: 'x' } } },
      { headers: { authorization: `Bearer ${KEY}` } },
    );
    const fix = seen.find((s) => String(s.url).endsWith('/api/scan/fix'));
    assert.ok(fix, JSON.stringify(seen.map((s) => s.url)));
    assert.equal(fix.init.headers.Authorization, `Bearer ${KEY}`);
    assert.match(JSON.stringify(res), /pull\/1/);
  });
});

describe('/api/scan/fix honours the entitlement before the checkout-session check', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'website', 'app', 'api', 'scan', 'fix', 'route.ts'), 'utf8');
  it('asks verifyMcpFixEntitlement first, refuses inactive (402) and unverifiable (503), and caps the tier at full', () => {
    const ent = src.indexOf('await verifyMcpFixEntitlement(');
    const pay = src.indexOf('await verifyFixPayment(input.sessionId)');
    assert.ok(ent > 0 && pay > ent, 'entitlement is checked before the Stripe session');
    assert.match(src, /mcpEntitlement\.state === "inactive"[\s\S]{0,200}status: 402/);
    assert.match(src, /mcpEntitlement\.state === "not_checked"[\s\S]{0,300}status: 503/);
    assert.match(src, /mcpEntitlement\.state === "active"\) \{[\s\S]{0,200}input\.tier = "full";/);
  });
});
