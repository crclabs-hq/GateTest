'use strict';
/**
 * Pins for the defects found by the end-to-end browser walk of production:
 * /pricing tier count, /scan/status unknown-id state, /modules at 320px, and
 * route metadata (client pages falling back to the generic title, canonicals
 * missing). Source-structure checks, because the pages are TSX.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));

describe('/pricing tier count is derived, not typed', () => {
  const src = read('website/app/pricing/page.tsx');
  it('counts one-time and subscription tiers from TIERS', () => {
    assert.match(src, /import \{ TIERS \} from "@\/app\/lib\/checkout-tiers"/);
    assert.match(src, /Object\.values\(TIERS\)\.filter\(\(t\) => !t\.recurring\)\.length/);
    assert.match(src, /countWord\(ONE_TIME_TIERS\)/);
  });
  it('no typed number word before "one-time scan tiers"', () => {
    assert.doesNotMatch(src, /\b(Four|Five|Six|Three)\s+one-time scan tiers/);
  });
});

describe('/scan/status — a missing or unknown id is not a failed paid run', () => {
  const src = read('website/app/scan/status/page.tsx');
  it('has a dedicated not-found state with no payment wording or progress bar', () => {
    const start = src.indexOf('if (noScan && !scanResult)');
    assert.ok(start > 0, 'noScan branch exists');
    const end = src.indexOf('return (', start + 40);
    const block = src.slice(start, src.indexOf('\n  }\n', start));
    assert.ok(end > start);
    assert.match(block, /find a scan for this link/);
    assert.match(block, /Start a scan/);
    assert.doesNotMatch(block, /payment/i);
    assert.doesNotMatch(block, /progress|%|modules/i);
  });
  it('the no-id and unknown-id paths set noScan instead of a failed result', () => {
    assert.doesNotMatch(src, /error: "No scan selected\./);
    assert.doesNotMatch(src, /error: "No repository URL found"/);
    assert.ok((src.match(/setNoScan\(true\)/g) || []).length >= 2);
  });
  it('real states are still rendered', () => {
    for (const s of ['Scan Complete', 'Scan Failed', 'Session Expired', 'Scanning...']) {
      assert.ok(src.includes(s), s);
    }
  });
});

describe('/modules grid children cannot overflow at 320px', () => {
  const src = read('website/app/modules/page.tsx');
  it('link and card carry min-w-0, long tokens wrap', () => {
    assert.match(src, /className="block min-w-0"/);
    assert.match(src, /<Card className="min-w-0 break-words">/);
    assert.match(src, /v2-mono[^"]*break-all/);
  });
});

describe('route metadata', () => {
  const layouts = {
    playground: '/playground',
    'scan/preview': '/scan/preview',
    'scan/status': '/scan/status',
    billing: '/billing',
    checkout: '/checkout',
    'checkout/success': '/checkout/success',
    'dashboard/intelligence': '/dashboard/intelligence',
    'account/notifications': '/account/notifications',
  };
  for (const [dir, route] of Object.entries(layouts)) {
    it(`${route} has a server layout with title, description and a helper-built canonical`, () => {
      const f = `website/app/${dir}/layout.tsx`;
      assert.ok(exists(f), `${f} exists`);
      const src = read(f);
      assert.doesNotMatch(src, /^["']use client["']/m);
      assert.match(src, /export const metadata/);
      assert.match(src, /title: "/);
      assert.match(src, /description:/);
      assert.ok(src.includes(`canonical: siteUrl("${route}")`), 'canonical via siteUrl');
      assert.ok(!/gatetest\.(io|ai)/.test(src), 'no origin literal');
    });
  }

  const pages = ['web', 'wp', 'mcp', 'quickstart', 'stack', 'trust', 'docs/api', 'badge', 'fixes', 'testing',
    'legal/acceptable-use', 'legal/cookies', 'legal/dpa', 'legal/privacy', 'legal/refunds', 'legal/sub-processors', 'legal/terms'];
  for (const dir of pages) {
    it(`/${dir} declares a canonical through siteUrl()`, () => {
      const src = read(`website/app/${dir}/page.tsx`);
      assert.ok(src.includes(`canonical: siteUrl("/${dir}")`), 'canonical via siteUrl');
    });
  }

  it('the score page gets a per-repo title and canonical', () => {
    const src = read('website/app/score/[owner]/[repo]/layout.tsx');
    assert.match(src, /generateMetadata/);
    assert.match(src, /canonical: siteUrl\(/);
  });
});
