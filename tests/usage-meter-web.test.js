'use strict';

// =============================================================================
// The website usage meter — /dashboard/usage, <UsageMeter>, /api/dashboard/usage
// =============================================================================
// The route delegates to usage-ledger.js handleUsageRequest with the VERIFIED
// session e-mail as the identity, so the logic under test is the same one
// tests/usage-ledger.test.js already proves; this file pins the wiring
// (source contracts, the repo's pattern for Next route files) and runs the
// session-shaped call end to end against a fake tagged-template `sql`:
//   control  — a session e-mail reads exactly its own account key
//   control  — no `apikey:` key is ever queried for a session (there is none)
//   negative — the page and component never render zeros for a read that
//              did not happen: "not checked" and "No usage recorded yet" are
//              separate states, and both are present in the source.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Ledger = require('../website/app/lib/usage-ledger');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const route = read('website/app/api/dashboard/usage/route.ts');
const page = read('website/app/dashboard/usage/page.tsx');
const layout = read('website/app/dashboard/usage/layout.tsx');
const component = read('website/app/components/UsageMeter.tsx');
const dashboard = read('website/app/dashboard/page.tsx');
const v1Route = read('website/app/api/v1/usage/route.ts');

function fakeSql(results = []) {
  const queries = [];
  let i = 0;
  const sql = (strings, ...values) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    queries.push({ text, values });
    if (/^(CREATE TABLE|CREATE INDEX|ALTER TABLE)/i.test(text)) return Promise.resolve([]);
    const result = i < results.length ? results[i] : [];
    i += 1;
    return Promise.resolve(result);
  };
  sql.queries = queries;
  return sql;
}

const FORBIDDEN = /\b(claude|anthropic|fable|sonnet|opus|haiku|openai|gpt-?\d)\b/i;

describe('/api/dashboard/usage — identity is the verified session, the logic is the ledger\'s', () => {
  it('reads the customer session cookie the dashboard uses and fails closed with 401 before any query', () => {
    assert.match(route, /import \{\s*getOAuthConfig,\s*verifyCustomerSession,\s*CUSTOMER_COOKIE_NAME,?\s*\} from "@\/app\/lib\/customer-session"/);
    assert.ok(route.includes('verifyCustomerSession(token, oauth.config.sessionSecret)'));
    assert.ok(route.includes('{ status: 401, headers: NO_STORE }'));
    assert.ok(route.indexOf('verifyCustomerSession(') < route.indexOf('handleUsageRequest({'), 'session check precedes the query');
    assert.ok(route.includes('export async function GET('));
    assert.ok(!route.includes('export async function POST('), 'read-only endpoint');
  });

  it('never takes the e-mail from the request — no body read, no email query param', () => {
    assert.doesNotMatch(route, /req\.json\(\)/, 'no body');
    assert.doesNotMatch(route, /searchParams\.get\(\s*["']email["']\s*\)/, 'no client-supplied identity');
    assert.ok(route.includes('customer_email: session.e'), 'identity is the session payload');
  });

  it('delegates to the same handleUsageRequest as GET /api/v1/usage (one definition of the report)', () => {
    assert.ok(v1Route.includes('handleUsageRequest({'), 'control: the v1 route uses the helper');
    assert.ok(route.includes('require("@/app/lib/usage-ledger")'));
    assert.ok(route.includes('handleUsageRequest({'));
    assert.ok(route.includes('searchParams: req.nextUrl.searchParams'), 'from/to windows pass through unchanged');
    assert.ok(route.includes('"Cache-Control": "private, no-store"'), 'a customer\'s meter is never cached');
    assert.ok(route.includes('export const dynamic = "force-dynamic"'));
  });

  it('control: the session-shaped auth reads exactly the e-mail account key — and no apikey: key', async () => {
    const email = 'ada@example.com';
    const emKey = Ledger.accountKeyForEmail(email);
    const sql = fakeSql([
      [{ day: '2026-09-15', surface: 'cli', key_owner: 'gatetest', events: 2, modules_run: 10, findings_total: 8, findings_blocking: 1, ai_calls: 0, tokens_in: 0, tokens_out: 0, usd_estimated: 0 }],
      [{ id: 3, occurred_at: new Date('2026-09-15T08:00:00Z'), account_key: emKey, surface: 'cli', repo: 'acme/tool', suite: 'quick', modules_run: 5, findings_total: 4, findings_blocking: 0, ai_calls: 0, tokens_in: 0, tokens_out: 0, usd_estimated: 0, key_owner: 'gatetest', model_tier: null, scan_id: null, tier: null }],
    ]);
    // The exact shape the route builds from the verified session.
    const out = await Ledger.handleUsageRequest({
      auth: { ok: true, key: { id: '', customer_email: email } },
      searchParams: new URLSearchParams('from=2026-09-10&to=2026-09-16'),
      getSql: () => sql,
    });
    assert.equal(out.status, 200);
    assert.equal(out.body.summary.events, 2);
    assert.equal(out.body.summary.scans, 2);
    assert.equal(out.body.recent.length, 1);
    assert.equal(out.body.recent[0].keyOwner, 'gatetest');
    const selects = sql.queries.filter((q) => q.text.startsWith('SELECT'));
    assert.equal(selects.length, 2);
    for (const q of selects) {
      assert.deepEqual(q.values[0], [emKey], 'exactly the customer\'s e-mail key');
      assert.ok(!q.values[0].some((k) => k.startsWith('apikey:')), 'a session has no api-key fallback identity');
    }
    // Control: the same e-mail through a REST key reads the SAME em: key — the CLI and the page agree.
    const viaKey = Ledger.accountKeysForApiKey({ id: 'k1', customer_email: email });
    assert.equal(viaKey[0], emKey);
  });

  it('negative: a session whose e-mail cannot form a key is 403 NO_ACCOUNT, never another account\'s rows', async () => {
    const out = await Ledger.handleUsageRequest({
      auth: { ok: true, key: { id: '', customer_email: 'not-an-email' } },
      searchParams: null,
      getSql: () => fakeSql(),
    });
    assert.equal(out.status, 403);
    assert.equal(out.body.code, 'NO_ACCOUNT');
  });

  it('no database is 503 DB_UNAVAILABLE — the page renders that as "not checked", not as $0.00', async () => {
    const out = await Ledger.handleUsageRequest({
      auth: { ok: true, key: { id: '', customer_email: 'ada@example.com' } },
      searchParams: null,
      getSql: () => { throw new Error('DATABASE_URL is not set'); },
    });
    assert.equal(out.status, 503);
    assert.equal(out.body.code, 'DB_UNAVAILABLE');
    assert.ok(page.includes('kind: "unavailable"'), 'the page has a distinct unavailable state');
    assert.ok(page.includes('Not checked'));
    assert.ok(page.includes('No numbers are shown because none were verified'));
    assert.ok(page.includes('{state.kind === "report" && <UsageMeter report={state.report} />}'), 'the meter renders only for a real report');
  });
});

describe('/dashboard/usage page + <UsageMeter>', () => {
  it('is a signed-in page: same auth check and sign-in card as /dashboard, then fetches the dashboard usage route', () => {
    assert.ok(page.startsWith('"use client";'));
    assert.ok(page.includes('fetch("/api/auth/me")'));
    assert.ok(page.includes('href="/api/auth/github"'));
    assert.match(page, /fetch\(`\/api\/dashboard\/usage\?from=/);
    assert.ok(page.includes('cache: "no-store"'));
    assert.ok(layout.includes('title: "Usage — GateTest"'));
    assert.ok(layout.includes('robots: { index: false, follow: false }'), 'a customer\'s meter is not indexed');
  });

  it('the dashboard links to it (discoverable) and the page links back', () => {
    assert.ok(dashboard.includes('href="/dashboard/usage"'));
    assert.ok(page.includes('href="/dashboard"'));
  });

  it('empty state says "No usage recorded yet" and returns before any tile or table renders', () => {
    const emptyIdx = component.indexOf('No usage recorded yet');
    assert.ok(emptyIdx > 0);
    assert.ok(component.includes('if (events === 0) {'), 'the empty branch is a separate early return');
    assert.ok(component.indexOf('if (events === 0) {') < component.indexOf('Estimated cost'), 'no cost section before the guard');
    assert.ok(component.indexOf('if (events === 0) {') < component.indexOf('<Tile '), 'no tiles before the guard');
  });

  it('BYOK and metered are labelled separately, with the ledger fields behind each', () => {
    assert.ok(component.includes('BYOK — your own model API key'));
    assert.ok(component.includes('Metered — GateTest key'));
    assert.ok(component.includes('formatUsd(s.usdByok)'));
    assert.ok(component.includes('formatUsd(s.usdGatetestPaid)'));
    assert.ok(component.includes('formatUsd(s.usdEstimated)'));
    assert.ok(component.includes('<KeyPill owner={e.keyOwner} />'), 'every recent row shows who paid for the key');
    assert.ok(component.includes('This page is a meter, not an invoice.'));
  });

  it('renders a per-day list, a per-surface table and the recent runs — every column a ledger field', () => {
    for (const field of ['d.events', 'd.findingsTotal', 'd.tokensIn + d.tokensOut', 'd.usdEstimated', 'v.events', 'v.aiCalls', 'v.byokEvents', 'e.occurredAt', 'e.surface', 'e.repo', 'e.suite']) {
      assert.ok(component.includes(field), `component renders ${field}`);
    }
  });

  it('formats money without float arithmetic: the same integer-micros rule as the CLI', () => {
    assert.ok(component.includes('Math.round(n * 1e6)'));
    assert.doesNotMatch(component, /\.reduce\([^)]*usd/i, 'no client-side money summation — the ledger summed in micros');
    assert.doesNotMatch(component, /toFixed\(\d\)\}?\s*<\/p>/, 'no float toFixed rendering of money');
  });

  it('customer-facing copy names no AI vendor or model', () => {
    for (const [name, src] of [['route', route], ['page', page], ['layout', layout], ['component', component]]) {
      const strings = (src.match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`|>[^<{]+</g) || []).join('\n');
      assert.doesNotMatch(strings, FORBIDDEN, `${name} is vendor-neutral`);
    }
  });

  it('introduces no price: no dollar literal in the page or component', () => {
    for (const [name, src] of [['page', page], ['component', component]]) {
      // Comments are prose; the formatter's zero literal ("$0.00") is a format, not a price.
      // Everything that remains must come from the ledger, never be typed.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').split('"$0.00"').join('');
      assert.doesNotMatch(code, /\$\d/, `${name} types no price (Boss Rule #3)`);
    }
  });
});
