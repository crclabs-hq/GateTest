/**
 * Pricing-consistency tripwire (Bible Forbidden #17).
 *
 * Tier prices are intentionally defined in more than one file:
 *   1. website/app/api/checkout/route.ts      — TIERS (source of truth, cents)
 *   2. website/app/components/Pricing.tsx     — UI display strings ("$29")
 *   3. website/app/api/stripe-webhook/route.ts — tierPrices (USD, DB logging)
 *   4. website/app/lib/stripe-checkout.js     — test-helper mirror (cents)
 *
 * This test parses all four and fails the suite the moment any of them
 * disagree — a price change that doesn't touch every surface can't ship.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** First `priceInCents: N` after `<tierKey>: {` in the given source. */
function centsFor(source, tierKey) {
  const re = new RegExp(`${tierKey}:\\s*\\{[\\s\\S]*?priceInCents:\\s*(\\d+)`);
  const m = source.match(re);
  return m ? Number(m[1]) : null;
}

const checkoutSrc = read('website/app/api/checkout/route.ts');
const pricingSrc = read('website/app/components/Pricing.tsx');
const webhookSrc = read('website/app/api/stripe-webhook/route.ts');
const helperSrc = read('website/app/lib/stripe-checkout.js');

// Source of truth — parsed, not hand-written, so this test tracks route.ts.
const TIER_KEYS = ['quick', 'full', 'scan_fix', 'nuclear', 'continuous', 'mcp'];
const truth = Object.fromEntries(TIER_KEYS.map((k) => [k, centsFor(checkoutSrc, k)]));

describe('checkout TIERS (source of truth)', () => {
  test('defines a price for all six tiers', () => {
    for (const key of TIER_KEYS) {
      assert.ok(
        Number.isInteger(truth[key]) && truth[key] > 0,
        `checkout/route.ts is missing priceInCents for tier "${key}"`
      );
    }
  });
});

describe('Pricing.tsx display strings match checkout cents', () => {
  // UI tier name → checkout tier key
  const UI_TIERS = [
    ['Quick Scan', 'quick'],
    ['Full Scan', 'full'],
    ['Scan + Fix', 'scan_fix'],
    ['Forensic Scan', 'nuclear'],
    ['Continuous Guard', 'continuous'],
    ['MCP Integration', 'mcp'],
  ];

  for (const [uiName, tierKey] of UI_TIERS) {
    test(`${uiName} shows $${truth[tierKey] / 100}`, () => {
      const re = new RegExp(
        `name:\\s*"${uiName.replace(/[+]/g, '\\+')}"[\\s\\S]{0,200}?price:\\s*"\\$(\\d+)"`
      );
      const m = pricingSrc.match(re);
      assert.ok(m, `Pricing.tsx has no price string for "${uiName}"`);
      assert.strictEqual(
        Number(m[1]) * 100,
        truth[tierKey],
        `Pricing.tsx shows $${m[1]} for "${uiName}" but checkout charges ${truth[tierKey]}¢`
      );
    });
  }
});

describe('stripe-webhook tierPrices (DB logging) match checkout cents', () => {
  test('one-time tiers agree', () => {
    const m = webhookSrc.match(/tierPrices[\s\S]{0,300}?\{([\s\S]*?)\}/);
    assert.ok(m, 'stripe-webhook/route.ts has no tierPrices map');
    const map = m[1];
    for (const key of ['quick', 'full', 'scan_fix', 'nuclear']) {
      const entry = map.match(new RegExp(`${key}:\\s*(\\d+)`));
      assert.ok(entry, `tierPrices is missing "${key}"`);
      assert.strictEqual(
        Number(entry[1]) * 100,
        truth[key],
        `tierPrices logs $${entry[1]} for "${key}" but checkout charges ${truth[key]}¢`
      );
    }
  });
});

describe('stripe-checkout.js test helper matches checkout cents', () => {
  // The helper intentionally mirrors only the tiers it validates.
  for (const key of ['quick', 'full']) {
    test(`helper "${key}" agrees`, () => {
      const cents = centsFor(helperSrc, key);
      assert.strictEqual(
        cents,
        truth[key],
        `stripe-checkout.js has ${cents}¢ for "${key}" but checkout charges ${truth[key]}¢`
      );
    });
  }
});
