'use strict';
/**
 * Billing portal — self-serve subscription management (Craig-authorized
 * 2026-07-25). Covers the lib (email validation, cross-store customer
 * lookup, Stripe portal-session creation, the full email-link flow) and
 * the route's enumeration-safety contract (source-text).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const Portal = require('../website/app/lib/billing-portal');

/** Fake Neon tagged-template sql — same recorder pattern as the store tests. */
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

describe('billing-portal — isValidEmail', () => {
  it('accepts normal emails, rejects garbage', () => {
    assert.ok(Portal.isValidEmail('craig@example.com'));
    assert.ok(Portal.isValidEmail('  padded@example.com  '));
    assert.ok(!Portal.isValidEmail('not-an-email'));
    assert.ok(!Portal.isValidEmail('a@b'));
    assert.ok(!Portal.isValidEmail(''));
    assert.ok(!Portal.isValidEmail(null));
    assert.ok(!Portal.isValidEmail('x'.repeat(250) + '@a.com'));
  });
});

describe('billing-portal — findStripeCustomersByEmail', () => {
  it('collects customers from BOTH stores, deduped, lowercased lookup', async () => {
    const sql = fakeSql([
      [{ stripe_customer_id: 'cus_A', status: 'active' }],
      [{ stripe_customer_id: 'cus_A', status: 'active' }, { stripe_customer_id: 'cus_B', status: 'past_due' }],
    ]);
    const customers = await Portal.findStripeCustomersByEmail(sql, 'Craig@Example.COM');
    assert.deepStrictEqual(customers.map((c) => c.customerId), ['cus_A', 'cus_B']);
    assert.deepStrictEqual(customers.map((c) => c.source), ['continuous', 'mcp']);
    const dataQueries = sql.queries.filter((q) => q.text.startsWith('SELECT'));
    assert.strictEqual(dataQueries.length, 2);
    for (const q of dataQueries) {
      assert.match(q.text, /LOWER\(customer_email\)/);
      assert.ok(q.values.includes('craig@example.com'), 'email must be lowercased before the query');
    }
  });

  it('returns [] for an invalid email without touching the database', async () => {
    const sql = fakeSql();
    const customers = await Portal.findStripeCustomersByEmail(sql, 'nope');
    assert.deepStrictEqual(customers, []);
    assert.strictEqual(sql.queries.length, 0);
  });
});

describe('billing-portal — createPortalSession', () => {
  it('POSTs to /v1/billing_portal/sessions and returns the url', async () => {
    const calls = [];
    const stripeStub = async (method, p, body) => {
      calls.push({ method, path: p, body });
      return { url: 'https://billing.stripe.com/p/session_x' };
    };
    const { url } = await Portal.createPortalSession('cus_A', 'https://gatetest.ai/billing', stripeStub);
    assert.strictEqual(url, 'https://billing.stripe.com/p/session_x');
    assert.strictEqual(calls[0].method, 'POST');
    assert.strictEqual(calls[0].path, '/v1/billing_portal/sessions');
    const params = new URLSearchParams(calls[0].body);
    assert.strictEqual(params.get('customer'), 'cus_A');
    assert.strictEqual(params.get('return_url'), 'https://gatetest.ai/billing');
  });

  it('rejects when Stripe returns no url', async () => {
    await assert.rejects(
      () => Portal.createPortalSession('cus_A', 'https://gatetest.ai/billing', async () => ({})),
      /missing url/
    );
  });
});

describe('billing-portal — requestPortalLink flow', () => {
  it('no match → {matched:0, sent:false} and no Stripe call, no email', async () => {
    const sql = fakeSql([[], []]);
    let stripeCalls = 0, emails = 0;
    const result = await Portal.requestPortalLink('nobody@example.com', {
      sql,
      stripeRequestFn: async () => { stripeCalls += 1; return {}; },
      sendEmailFn: async () => { emails += 1; return { ok: true }; },
      baseUrl: 'https://gatetest.ai',
    });
    assert.deepStrictEqual(result, { matched: 0, sent: false });
    assert.strictEqual(stripeCalls, 0);
    assert.strictEqual(emails, 0);
  });

  it('match → creates portal session and EMAILS the link (never returns it)', async () => {
    const sql = fakeSql([[{ stripe_customer_id: 'cus_A', status: 'active' }], []]);
    const sentEmails = [];
    const result = await Portal.requestPortalLink('craig@example.com', {
      sql,
      stripeRequestFn: async () => ({ url: 'https://billing.stripe.com/p/s1' }),
      sendEmailFn: async (opts) => { sentEmails.push(opts); return { ok: true }; },
      baseUrl: 'https://gatetest.ai',
    });
    assert.strictEqual(result.matched, 1);
    assert.strictEqual(result.sent, true);
    assert.strictEqual(sentEmails.length, 1);
    assert.strictEqual(sentEmails[0].to, 'craig@example.com');
    assert.strictEqual(sentEmails[0].links[0].url, 'https://billing.stripe.com/p/s1');
    assert.ok(!('links' in result) && !('url' in result), 'portal URL must never be in the flow result');
  });

  it('caps portal sessions per request', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ stripe_customer_id: `cus_${i}`, status: 'active' }));
    const sql = fakeSql([many, []]);
    let stripeCalls = 0;
    await Portal.requestPortalLink('craig@example.com', {
      sql,
      stripeRequestFn: async () => { stripeCalls += 1; return { url: `https://billing.stripe.com/p/s${stripeCalls}` }; },
      sendEmailFn: async () => ({ ok: true }),
      baseUrl: 'https://gatetest.ai',
    });
    assert.strictEqual(stripeCalls, Portal.MAX_PORTAL_SESSIONS_PER_REQUEST);
  });

  it('one failing Stripe customer does not block the rest', async () => {
    const sql = fakeSql([
      [{ stripe_customer_id: 'cus_bad', status: 'active' }, { stripe_customer_id: 'cus_good', status: 'active' }],
      [],
    ]);
    const sentEmails = [];
    const result = await Portal.requestPortalLink('craig@example.com', {
      sql,
      stripeRequestFn: async (m, p, body) => {
        if (String(body).includes('cus_bad')) throw new Error('No such customer');
        return { url: 'https://billing.stripe.com/p/good' };
      },
      sendEmailFn: async (opts) => { sentEmails.push(opts); return { ok: true }; },
      baseUrl: 'https://gatetest.ai',
    });
    assert.strictEqual(result.sent, true);
    assert.strictEqual(sentEmails[0].links.length, 1);
  });
});

describe('billing-portal — route enumeration-safety contract (source text)', () => {
  const routeSrc = fs.readFileSync(
    path.join(__dirname, '../website/app/api/billing/portal/route.ts'), 'utf8');

  it('response is generic regardless of match (no subscription-existence oracle)', () => {
    assert.match(routeSrc, /GENERIC_RESPONSE/);
    // The generic response must be the only 200-path return.
    const okReturns = routeSrc.match(/NextResponse\.json\(GENERIC_RESPONSE\)/g) || [];
    assert.ok(okReturns.length >= 1);
    assert.ok(!/NextResponse\.json\(\{[^}]*matched/.test(routeSrc), 'match count must never reach the response');
  });

  it('is rate-limited with the billingPortal preset', () => {
    assert.match(routeSrc, /PRESETS\.billingPortal/);
  });

  it('never puts the portal url in the HTTP response', () => {
    assert.ok(!/portalUrl|session\.url|links/.test(routeSrc.replace(/links: Array<\{ url: string; source: string \}>/g, '')),
      'portal links must travel by email only');
  });

  it('billingPortal preset exists in lib/rate-limit.js', () => {
    const rl = fs.readFileSync(path.join(__dirname, '../lib/rate-limit.js'), 'utf8');
    assert.match(rl, /billingPortal:\s*\{\s*windowMs:\s*60_000,\s*maxRequests:\s*3\s*\}/);
  });
});
