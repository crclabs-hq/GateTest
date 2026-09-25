'use strict';

// =============================================================================
// PLATFORM CONFIG — the platform GateTest runs on has ONE definition
// =============================================================================
// The platform is being renamed Vapron → Tallrig and every hostname moves
// (announced 2026-09-13; nothing moved yet). Before this file, GateTest
// pinned vapron.ai in seven runtime places and the product name in a dozen
// copy components plus the legal sub-processor table — a rename would have
// been a scavenger hunt with a stale legal page at the end of it.
//
// Now: website/app/lib/platform-config.js holds today's Vapron values as
// DEFAULTS, every consumer imports from it, and the flip is an env change.
// These tests pin (1) the precedence order the platform's own SDK uses,
// (2) that the defaults are exactly today's values so this PR changes nothing
// visible, and (3) that no guarded file carries its own vapron.* literal.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const cfg = require('../website/app/lib/platform-config');

describe('platform-config — env precedence (TALLRIG_ → VAPRON_ → CRONTECH_)', () => {
  it('reads TALLRIG_<name> first when set', () => {
    assert.equal(cfg.platformEnv('BASE_URL', { TALLRIG_BASE_URL: 'https://api.tallrig.com', VAPRON_BASE_URL: 'https://api.vapron.ai', CRONTECH_BASE_URL: 'x' }), 'https://api.tallrig.com');
  });
  it('falls back to VAPRON_<name>, then CRONTECH_<name>', () => {
    assert.equal(cfg.platformEnv('API_TOKEN', { VAPRON_API_TOKEN: 'v', CRONTECH_API_TOKEN: 'c' }), 'v');
    assert.equal(cfg.platformEnv('API_TOKEN', { CRONTECH_API_TOKEN: 'c' }), 'c');
    assert.equal(cfg.platformEnv('API_TOKEN', {}), undefined);
  });
  it('a blank TALLRIG_ value does not shadow a set VAPRON_ value', () => {
    assert.equal(cfg.platformEnv('DISPATCH_SECRET', { TALLRIG_DISPATCH_SECRET: '   ', VAPRON_DISPATCH_SECRET: 's' }), 's');
  });
  it('platformEnvNames lists every alias, most-preferred first', () => {
    assert.deepEqual(cfg.platformEnvNames('STATUS_URL'), ['TALLRIG_STATUS_URL', 'VAPRON_STATUS_URL', 'CRONTECH_STATUS_URL']);
  });
});

describe('platform-config — defaults are exactly today\'s Vapron values (this PR changes nothing visible)', () => {
  it('server-side URLs', () => {
    assert.equal(cfg.platformMailUrl({}), 'https://tallrig.com/api/platform/email/send');
    assert.equal(cfg.platformStatusUrl({}), 'https://tallrig.com/api/health/status');
    assert.equal(cfg.platformServicePrefix({}), 'tallrig');
    assert.equal(cfg.platformCanonicalHost({}), 'tallrig.com');
  });
  it('server-side overrides, in order', () => {
    assert.equal(cfg.platformMailUrl({ TALLRIG_MAIL_URL: 'https://api.tallrig.com/api/platform/email/send', VAPRON_MAIL_URL: 'https://vapron.ai/x' }), 'https://api.tallrig.com/api/platform/email/send');
    assert.equal(cfg.platformStatusUrl({ VAPRON_STATUS_URL: 'https://staging.example/s' }), 'https://staging.example/s');
    assert.equal(cfg.platformServicePrefix({ PLATFORM_SERVICE_PREFIX: 'vapron' }), 'vapron', 'a box whose units are not yet renamed can keep the old prefix');
    assert.equal(cfg.platformServicePrefix({ PLATFORM_SERVICE_PREFIX: 'rm -rf /' }), 'tallrig', 'an unsafe prefix never reaches a shell command');
    assert.equal(cfg.platformCanonicalHost({ PLATFORM_CANONICAL_HOST: 'next-name.example' }), 'next-name.example');
    assert.equal(cfg.platformCanonicalHost({ NEXT_PUBLIC_PLATFORM_URL: 'https://next-name.example' }), 'next-name.example', 'derived from the site URL when not set explicitly');
  });
  it('client-visible values (read from process.env at load — unset in this test run)', () => {
    if (!process.env.NEXT_PUBLIC_PLATFORM_NAME) assert.equal(cfg.PLATFORM_NAME, 'Tallrig');
    if (!process.env.NEXT_PUBLIC_PLATFORM_URL) {
      assert.equal(cfg.PLATFORM_SITE_URL, 'https://tallrig.com');
      assert.equal(cfg.PLATFORM_HOST, 'tallrig.com');
    }
    if (!process.env.NEXT_PUBLIC_PLATFORM_API_URL) assert.equal(cfg.PLATFORM_API_URL, 'https://api.tallrig.com');
    if (!process.env.NEXT_PUBLIC_PLATFORM_ENTITY) assert.equal(cfg.PLATFORM_ENTITY, 'Tallrig Labs LLC');
    if (!process.env.NEXT_PUBLIC_PLATFORM_ID) assert.equal(cfg.PLATFORM_ID, 'tallrig');
  });
  it('the defaults table is frozen — the sunset is an explicit edit, never a drift', () => {
    assert.ok(Object.isFrozen(cfg.PLATFORM_DEFAULTS));
  });
});

describe('platform-config — every consumer imports it; no guarded file pins a vapron.* host or the name', () => {
  // Runtime files that used to carry their own literal. A `vapron.ai` /
  // `api.vapron.ai` / `"Vapron"`-as-copy literal reappearing in any of them
  // is the rename breaking silently in one place.
  const GUARDED = [
    'website/app/lib/vapron-dispatch.js',
    'website/app/lib/mail-transport.js',
    'website/app/lib/platform-siblings.js',
    'website/app/api/heal/ssh/route.ts',
    'website/app/admin/tabs/NuclearScanTab.tsx',
    'website/app/components/site-nav.ts',
    'website/app/components/Footer.tsx',
    'website/app/components/HomeStack.tsx',
    'website/app/components/HomeTrust.tsx',
    'website/app/components/SiblingProducts.tsx',
    'website/app/components/StackBar.tsx',
    'website/app/stack/page.tsx',
    'website/app/legal/_facts.js',
    'integrations/smoke/empire-smoke.js',
    'scripts/ops/vapron-link-check.js',
  ];

  for (const rel of GUARDED) {
    it(`${rel} imports platform-config and carries no vapron hostname literal in code`, () => {
      const src = read(rel);
      assert.match(src, /platform-config/, 'must import from platform-config');
      // Strip comments (a dated comment may legitimately say vapron.ai) and check code only.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
      assert.doesNotMatch(code, /https?:\/\/(?:api\.)?vapron\.ai/, 'a vapron.* URL literal is back in code');
      assert.doesNotMatch(code, /["'`]vapron\.ai["'`]/, 'a bare vapron.ai host literal is back in code');
    });
  }

  it('the dispatch reads TALLRIG_* before VAPRON_* before CRONTECH_*', () => {
    const src = read('website/app/lib/vapron-dispatch.js');
    assert.match(src, /platformEnv\('BASE_URL'\)/);
    assert.match(src, /platformEnv\('API_TOKEN'\)/);
    assert.match(src, /platformEnv\('DISPATCH_SECRET'\)/);
    assert.doesNotMatch(src, /getEnv\('VAPRON_/, 'no direct VAPRON_ read remains');
  });

  it('/api/status lists TALLRIG_* as canonical and counts VAPRON_*/CRONTECH_* as "set" for each dispatch variable', () => {
    const src = read('website/app/api/status/route.ts');
    assert.match(src, /TALLRIG_BASE_URL: \["VAPRON_BASE_URL", "CRONTECH_BASE_URL"\]/);
    assert.match(src, /TALLRIG_API_TOKEN: \["VAPRON_API_TOKEN", "CRONTECH_API_TOKEN"\]/);
    assert.match(src, /TALLRIG_DISPATCH_SECRET: \["VAPRON_DISPATCH_SECRET", "CRONTECH_DISPATCH_SECRET"\]/);
    // The canonical names are what /api/status lists as missing_important.
    assert.match(src, /name: "TALLRIG_BASE_URL"/);
    assert.doesNotMatch(src, /name: "VAPRON_(?:BASE_URL|API_TOKEN|DISPATCH_SECRET)"/, 'the old name is an alias, not the headline');
  });

  it('the legal sub-processor row reads name, entity and site from the config (Sync Rule: same commit as the copy)', () => {
    const src = read('website/app/legal/_facts.js');
    assert.match(src, /name: PLATFORM_NAME, entity: PLATFORM_ENTITY, purpose: 'Live-URL scanning dispatch'/);
    assert.match(src, /terms: PLATFORM_SITE_URL/);
  });

  it('.env.example documents every new variable', () => {
    const env = read('website/.env.example');
    for (const name of ['TALLRIG_BASE_URL', 'TALLRIG_API_TOKEN', 'TALLRIG_DISPATCH_SECRET', 'TALLRIG_MAIL_URL', 'TALLRIG_STATUS_URL', 'PLATFORM_SERVICE_PREFIX', 'PLATFORM_CANONICAL_HOST', 'NEXT_PUBLIC_PLATFORM_NAME', 'NEXT_PUBLIC_PLATFORM_ENTITY', 'NEXT_PUBLIC_PLATFORM_ID', 'NEXT_PUBLIC_PLATFORM_URL', 'NEXT_PUBLIC_PLATFORM_API_URL']) {
      assert.match(env, new RegExp(`^${name}=`, 'm'), `${name} missing from .env.example`);
    }
  });
});

describe('platformPointing — /api/status shows which brand the box is pointed at (names only)', () => {
  it('unset → every dispatch var null, pointed_at unset, urls default', () => {
    const p = cfg.platformPointing({});
    assert.deepEqual(p.dispatch, { BASE_URL: null, API_TOKEN: null, DISPATCH_SECRET: null });
    assert.equal(p.pointed_at, 'unset');
    assert.equal(p.mail_url, 'default');
    assert.equal(p.status_url, 'default');
  });
  it('all three from VAPRON_ → vapron; all three from TALLRIG_ → tallrig (VAPRON_ still set does not matter)', () => {
    assert.equal(cfg.platformPointing({ VAPRON_BASE_URL: 'u', VAPRON_API_TOKEN: 't', VAPRON_DISPATCH_SECRET: 's' }).pointed_at, 'legacy');
    const flipped = cfg.platformPointing({ TALLRIG_BASE_URL: 'u', TALLRIG_API_TOKEN: 't', TALLRIG_DISPATCH_SECRET: 's', VAPRON_BASE_URL: 'u', VAPRON_API_TOKEN: 't', VAPRON_DISPATCH_SECRET: 's' });
    assert.equal(flipped.pointed_at, 'tallrig');
    assert.deepEqual(flipped.dispatch, { BASE_URL: 'tallrig', API_TOKEN: 'tallrig', DISPATCH_SECRET: 'tallrig' });
  });
  it('a half-flipped box reads mixed, and says which var is behind', () => {
    const p = cfg.platformPointing({ TALLRIG_BASE_URL: 'u', VAPRON_API_TOKEN: 't', VAPRON_DISPATCH_SECRET: 's', TALLRIG_MAIL_URL: 'm' });
    assert.equal(p.pointed_at, 'mixed');
    assert.deepEqual(p.dispatch, { BASE_URL: 'tallrig', API_TOKEN: 'legacy', DISPATCH_SECRET: 'legacy' });
    assert.ok(!JSON.stringify(p).toLowerCase().includes('vapron'), 'customer-visible pointing output never names the pre-rename brand');
    assert.equal(p.mail_url, 'tallrig');
  });
  it('never returns a value — only brand names', () => {
    const p = cfg.platformPointing({ TALLRIG_BASE_URL: 'https://api.tallrig.com', TALLRIG_API_TOKEN: 'super-secret-token', TALLRIG_DISPATCH_SECRET: 'hmac-secret' });
    assert.doesNotMatch(JSON.stringify(p), /super-secret|hmac-secret|api\.tallrig/);
  });
  it('/api/status carries it as `platform`', () => {
    const src = read('website/app/api/status/route.ts');
    assert.match(src, /platform: platformPointing\(process\.env\)/);
  });
});

describe('platform siblings honour the TALLRIG_STATUS_URL override ahead of VAPRON_STATUS_URL', () => {
  const { SIBLING_REGISTRY, resolveSiblingUrl } = require('../website/app/lib/platform-siblings');
  const platform = SIBLING_REGISTRY.find((s) => s.id === cfg.PLATFORM_ID);
  it('registry entry exists under the configured id', () => {
    assert.ok(platform, `no sibling with id ${cfg.PLATFORM_ID}`);
    assert.equal(platform.name, cfg.PLATFORM_NAME);
  });
  it('precedence', () => {
    assert.equal(resolveSiblingUrl(platform, { TALLRIG_STATUS_URL: 'https://api.tallrig.com/api/health/status', VAPRON_STATUS_URL: 'https://vapron.ai/api/health/status' }), 'https://api.tallrig.com/api/health/status');
    assert.equal(resolveSiblingUrl(platform, { VAPRON_STATUS_URL: 'https://staging.example/s' }), 'https://staging.example/s');
    assert.equal(resolveSiblingUrl(platform, {}), 'https://tallrig.com/api/health/status');
  });
});
