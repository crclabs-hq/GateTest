'use strict';

// SALES PAUSE — Craig 2026-10-01: "we havent built the scan & repair tool
// properly yet … build the switch and pause sales." No customer may be
// charged until the paid tiers deliver what the site says. These tests pin:
//   - the switch fails CLOSED (only an explicit "0" reopens checkout);
//   - POST /api/checkout refuses before it reads the body or reaches Stripe;
//   - it is the ONLY place a Stripe Checkout Session is created, so no other
//     route can take money around the switch;
//   - every page that calls checkout says "not on sale" instead of selling.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'website', 'app');
const { salesPaused, salesPausedBody, SALES_PAUSED_MESSAGE } = require(path.join(APP, 'lib', 'sales-pause.js'));
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__') continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js)$/.test(name)) out.push(full);
  }
  return out;
}

describe('sales pause switch', () => {
  it('fails closed: unset, blank, "1", "false", "no" and typos all keep sales paused', () => {
    for (const v of [undefined, '', ' ', '1', 'true', 'false', 'no', 'off', 'O', '00', 'paused']) {
      assert.equal(salesPaused({ GATETEST_SALES_PAUSED: v }), true, `value ${JSON.stringify(v)} must keep sales paused`);
    }
    assert.equal(salesPaused({}), true);
  });

  it('only an explicit "0" reopens checkout (control)', () => {
    assert.equal(salesPaused({ GATETEST_SALES_PAUSED: '0' }), false);
    assert.equal(salesPaused({ GATETEST_SALES_PAUSED: ' 0\n' }), false);
  });

  it('the refusal says what is true and points to the free scan', () => {
    const body = salesPausedBody();
    assert.equal(body.code, 'sales_paused');
    assert.equal(body.error, SALES_PAUSED_MESSAGE);
    assert.match(SALES_PAUSED_MESSAGE, /not on sale/);
    assert.match(SALES_PAUSED_MESSAGE, /free scan/);
  });
});

describe('POST /api/checkout enforces it first', () => {
  const src = read('api/checkout/route.ts');
  const post = src.slice(src.indexOf('export async function POST'));

  it('the pause check is the first statement — before the Stripe key, the body and the rate limiter', () => {
    const pauseAt = post.indexOf('if (salesPaused())');
    assert.ok(pauseAt > 0, 'POST must check salesPaused()');
    for (const later of ['STRIPE_SECRET_KEY', 'req.json()', '_checkoutLimiter.guard', '/v1/checkout/sessions']) {
      assert.ok(post.indexOf(later) > pauseAt, `${later} must come after the pause check`);
    }
    assert.match(post.slice(pauseAt, pauseAt + 200), /salesPausedBody\(\), \{ status: 503/);
  });

  it('POST /api/checkout is the only place a Stripe Checkout Session is created', () => {
    const creators = [];
    for (const f of walk(APP)) {
      const s = fs.readFileSync(f, 'utf8');
      // A session is CREATED by POSTing to /v1/checkout/sessions with no id;
      // reading one back (/v1/checkout/sessions/${id}) is fine.
      if (/["'`](?:https:\/\/api\.stripe\.com)?\/v1\/checkout\/sessions["'`]/.test(s)) creators.push(path.relative(APP, f));
    }
    // lib/stripe-checkout.js is the test-only twin of the route; it is gated too.
    assert.deepEqual(creators.sort(), ['api/checkout/route.ts', 'lib/stripe-checkout.js'].sort(),
      'a new Checkout Session creator must go through lib/sales-pause.js');
    assert.match(read('lib/stripe-checkout.js'), /salesPaused\(/, 'the twin is gated as well');
  });
});

describe('pages say "not on sale" instead of selling', () => {
  it('GET /api/sales-status reports the switch and is never cached', () => {
    const src = read('api/sales-status/route.ts');
    assert.match(src, /salesPaused\(\)/);
    assert.match(src, /no-store/);
  });

  it('every page that calls /api/checkout reads the sales status or handles the refusal', () => {
    const callers = walk(APP).filter((f) => /\.tsx$/.test(f) && fs.readFileSync(f, 'utf8').includes('fetch("/api/checkout"') || fs.readFileSync(f, 'utf8').includes("fetch('/api/checkout'"));
    assert.ok(callers.length >= 4, `control: found ${callers.length} checkout callers`);
    for (const f of callers) {
      const s = fs.readFileSync(f, 'utf8');
      assert.ok(/useSalesStatus\(|sales_paused/.test(s), `${path.relative(APP, f)} must say when sales are paused`);
    }
  });

  it('every page that links to /checkout?tier= hides or replaces the link while paused', () => {
    const linkers = walk(APP).filter((f) => /\.tsx$/.test(f) && fs.readFileSync(f, 'utf8').includes('/checkout?tier='));
    assert.ok(linkers.length >= 1, 'control: the playground links to /checkout');
    for (const f of linkers) {
      // The /checkout page itself shows the server's sales_paused refusal.
      assert.match(fs.readFileSync(f, 'utf8'), /useSalesStatus\(|"sales_paused"/, `${path.relative(APP, f)} must read the sales status`);
    }
  });

  it('the price table (home + /pricing) carries the paused notice', () => {
    assert.match(read('components/v2/Pricing.tsx'), /<SalesPausedNotice \/>/);
    assert.match(read('components/v2/SalesPausedNotice.tsx'), /useSalesStatus\(/);
  });

  it('the switch is listed in the secrets catalogue and .env.example (closed)', () => {
    const cat = require(path.join(APP, 'lib', 'env-catalogue.js'));
    assert.ok(cat.OPTIONAL.includes('GATETEST_SALES_PAUSED'));
    assert.match(fs.readFileSync(path.join(ROOT, 'website', '.env.example'), 'utf8'), /^GATETEST_SALES_PAUSED=1$/m);
  });
});
