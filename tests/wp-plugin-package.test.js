'use strict';

// =============================================================================
// WORDPRESS PLUGIN PACKAGE — what wp.org's reviewers and WordPress's uploader
// check, pinned before either of them sees it.
// =============================================================================
// 2026-09-14 audit of wp-plugin/: the readme sold a $29/month "Starter" tier
// with auto-fix that checkout-tiers.ts has never had (the only WordPress tier
// is wp_health, $19 one-time); every i18n call passed a constant text domain
// (Plugin Check: NonSingularStringLiteralDomain); the header said Tested up
// to 6.7 against a 7.1 current release; and there was no zip at all. These
// pins keep the package honest and installable: the readme agrees with the
// header and with the live tier table, the strings are translatable, and
// the zip unpacks to one plugin folder.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildPluginZip, collectPluginFiles, listZipEntries, PLUGIN_DIR, PLUGIN_SLUG } = require('../scripts/build-wp-plugin-zip');

const read = (rel) => fs.readFileSync(path.join(PLUGIN_DIR, rel), 'utf8');
const header = (text, key) => (new RegExp(`^ \\* ${key}:\\s*(.+?)\\s*$`, 'm').exec(text) || [])[1];
const readmeField = (text, key) => (new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm').exec(text) || [])[1];

describe('wp-plugin readme.txt and plugin header agree', () => {
  const main = read(`${PLUGIN_SLUG}.php`);
  const readme = read('readme.txt');

  it('Stable tag == header Version == GATETEST_HC_VERSION', () => {
    const version = header(main, 'Version');
    assert.match(version, /^\d+\.\d+\.\d+$/, 'header Version must be semver');
    assert.equal(readmeField(readme, 'Stable tag'), version, 'readme Stable tag must match the header Version');
    const constant = /define\('GATETEST_HC_VERSION',\s*'([^']+)'\)/.exec(main);
    assert.ok(constant, 'GATETEST_HC_VERSION define missing');
    assert.equal(constant[1], version, 'GATETEST_HC_VERSION must match the header Version (it is the asset cache-buster)');
  });

  it('Tested up to / Requires at least / Requires PHP are present and identical in both files', () => {
    for (const key of ['Tested up to', 'Requires at least', 'Requires PHP']) {
      const h = header(main, key);
      const r = readmeField(readme, key);
      assert.ok(h, `header ${key} missing`);
      assert.ok(r, `readme ${key} missing`);
      assert.equal(r, h, `${key} differs between readme.txt (${r}) and the header (${h})`);
    }
    const [major, minor] = readmeField(readme, 'Tested up to').split('.').map(Number);
    assert.ok(major > 6 || (major === 6 && minor >= 8), 'Tested up to must not lag the 2026 WordPress line (6.7 was the stale value)');
  });

  it('at most five tags, a Text Domain equal to the slug, and no Domain Path (wp.org ships translations)', () => {
    const tags = readmeField(readme, 'Tags').split(',').map((t) => t.trim()).filter(Boolean);
    assert.ok(tags.length >= 1 && tags.length <= 5, `readme Tags has ${tags.length} entries; the directory reads at most 5`);
    assert.equal(header(main, 'Text Domain'), PLUGIN_SLUG);
    assert.equal(header(main, 'Domain Path'), undefined, 'Domain Path points at a /languages directory that does not exist');
  });
});

describe('wp-plugin copy describes the offer that exists', () => {
  const files = collectPluginFiles(PLUGIN_DIR);
  const all = files.map((f) => `${f}\n${read(f)}`).join('\n');

  it('no tier, price or capability the tier table does not sell', () => {
    // checkout-tiers.ts: wp_health is the ONLY WordPress tier — $19, one-time.
    for (const stale of ['$29', 'Starter', 'auto-fix', 'Continuous tier', '/account', 'gatetest.io/pricing']) {
      assert.ok(!all.includes(stale), `"${stale}" is back in the plugin — nothing like that is for sale to WordPress users (see website/app/lib/checkout-tiers.ts wp_health)`);
    }
    assert.ok(/\$19/.test(all), 'the plugin must quote the real full-report price ($19, one-time)');
    assert.ok(all.includes('/checkout?tier=wp_health'), 'the paywall link must be the wp_health checkout');
  });

  it("the module count the admin page quotes is the engine's wp suite (minus the internal memory module)", () => {
    // src/core/config.js suites.wp is what /api/wp/scan runs (runSuite("wp")).
    // `memory` is the internal always-on module every suite carries and no
    // public count includes (Quick is sold as "4 modules" with it present).
    const { suites } = require('../src/core/config').DEFAULT_CONFIG;
    const publicCount = suites.wp.filter((m) => m !== 'memory').length;
    const quoted = /(\d+) modules, plain-language report/.exec(read('includes/admin-page.php'));
    assert.ok(quoted, 'admin-page.php must quote the module count');
    assert.equal(Number(quoted[1]), publicCount, `admin-page.php says ${quoted[1]} modules; the wp suite has ${publicCount} (said 18 while the suite had 29, 2026-09-15)`);
  });

  it('every translation call uses the literal text domain, and no internal note is in the public header', () => {
    assert.ok(!all.includes('GATETEST_HC_TEXT_DOMAIN'), 'Plugin Check fails NonSingularStringLiteralDomain on a constant text domain');
    const i18nCalls = all.match(/\b(?:__|_e|esc_html__|esc_html_e|esc_attr__|esc_attr_e)\(\s*'[^']*(?:\\'[^']*)*'\s*,\s*([^)]+?)\)/g) || [];
    assert.ok(i18nCalls.length > 20, `expected the plugin's i18n calls to be found (${i18nCalls.length})`);
    for (const call of i18nCalls) {
      assert.match(call, /,\s*'gatetest-health-check'\s*\)$/, `text domain must be the literal slug: ${call}`);
    }
    assert.ok(!all.includes('Pre-authorisation'), 'internal authorisation notes do not ship in the plugin header');
  });
});

describe('the plugin zip unpacks to one plugin folder', () => {
  it('every entry is under gatetest-health-check/, the main file is at its root, and no dev files ride along', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-wp-zip-'));
    try {
      const outFile = path.join(dir, `${PLUGIN_SLUG}.zip`);
      const { entries } = buildPluginZip({ outFile });
      const listed = listZipEntries(outFile).map((e) => e.name);
      assert.deepEqual(listed, entries, 'the central directory must list exactly what was written');
      assert.ok(listed.length >= 5, `too few files in the zip: ${listed.join(', ')}`);
      for (const name of listed) {
        assert.ok(name.startsWith(`${PLUGIN_SLUG}/`), `${name} is not under the plugin folder — WordPress would install a nameless plugin`);
        assert.ok(!/(^|\/)\./.test(name), `${name}: dotfiles do not ship`);
      }
      assert.ok(listed.includes(`${PLUGIN_SLUG}/${PLUGIN_SLUG}.php`), 'main plugin file must sit at the folder root');
      assert.ok(listed.includes(`${PLUGIN_SLUG}/readme.txt`), 'readme.txt must ship');
      assert.ok(listed.includes(`${PLUGIN_SLUG}/uninstall.php`), 'uninstall.php must ship');
      // A wp.org build must be small; the readme says "less than 50KB".
      assert.ok(fs.statSync(outFile).size < 50 * 1024, 'zip must stay under 50KB');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
