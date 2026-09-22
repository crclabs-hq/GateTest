'use strict';

/**
 * #653 — website/app/lib/html-extract.ts is a documented DUPLICATE of
 * src/core/html-extract.js (Turbopack locks the website to its own
 * directory tree, so no website `.ts` file imports `src/core/*` directly
 * today — see the header comment in html-extract.ts). This test is the
 * drift guard that comment promises: it runs the same fixed set of cases
 * through both implementations and fails if they ever disagree.
 *
 * It also stands in for a direct scanWebsite() integration test.
 * website-scanner.ts cannot be `require()`'d under Node's native
 * TypeScript loader — even before this change — because it imports sibling
 * modules by extensionless specifier (`from "./platform-detector"`), which
 * Node's loader (unlike a bundler) does not resolve:
 *   `ERR_MODULE_NOT_FOUND: Cannot find module '.../platform-detector'`
 * That is a pre-existing limitation of website-scanner.ts's own imports,
 * unrelated to this fix, and out of this brief's scope (seo.js and
 * website-scanner.ts only). html-extract.ts itself has no relative
 * imports and loads cleanly, so it is tested directly here — the same
 * approach tests/extraction-regex.test.js uses for issue-extractor.ts.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const coreExtract = require('../src/core/html-extract.js');

let websiteExtract;
try {
  websiteExtract = require('../website/app/lib/html-extract.ts');
} catch {
  test('website-html-extract-parity suite skipped — runtime cannot require .ts (needs Node >= 22.18 type-stripping)', { skip: true }, () => {});
  return;
}

const TITLE_CASES = [
  '<title lang="en">Tallrig — Automated Quality Gate</title>',
  '<title>\n  Multi\n  Line\n  Title\n</title>',
  '<title data-sm="1" class="x">Deploy — Tallrig</title>',
  '<svg viewBox="0 0 10 10"><title>Icon</title></svg>',
  '<title></title>',
  '<title lang="en">   </title>',
  '<html><head></head><body>hi</body></html>',
  '<title>Home</title><svg><title>Icon</title></svg>',
];

const DESCRIPTION_CASES = [
  '<meta name="description" content="A page.">',
  '<meta content="A page." name="description">',
  '<meta name="description" lang="en" content="A page.">',
  '<meta content="A page." lang="en" name="description">',
  '<meta charset="utf-8">',
  '<meta name="description" content="">',
];

test('extractTitle() agrees between src/core/html-extract.js and website/app/lib/html-extract.ts', () => {
  for (const html of TITLE_CASES) {
    assert.equal(
      websiteExtract.extractTitle(html),
      coreExtract.extractTitle(html),
      `extractTitle drifted on: ${html}`,
    );
  }
});

test('extractMetaDescription() agrees between src/core/html-extract.js and website/app/lib/html-extract.ts', () => {
  for (const html of DESCRIPTION_CASES) {
    assert.equal(
      websiteExtract.extractMetaDescription(html),
      coreExtract.extractMetaDescription(html),
      `extractMetaDescription drifted on: ${html}`,
    );
  }
});

test('CONTROL — website/app/lib/html-extract.ts reads a <title lang="en"> tag', () => {
  assert.equal(websiteExtract.extractTitle('<title lang="en">Home</title>'), 'Home');
});

test('CONTROL — website/app/lib/html-extract.ts reads a multi-line <title>', () => {
  assert.equal(websiteExtract.extractTitle('<title>\nHome\n</title>'), 'Home');
});

test('POSITIVE CONTROL — website/app/lib/html-extract.ts: a <title> only inside <svg> still counts as missing', () => {
  assert.equal(websiteExtract.extractTitle('<svg><title>Icon</title></svg>'), null);
});

test('CONTROL — website/app/lib/html-extract.ts reads a meta description with an attribute between name and content, either order', () => {
  assert.equal(
    websiteExtract.extractMetaDescription('<meta name="description" lang="en" content="A page.">'),
    'A page.',
  );
  assert.equal(
    websiteExtract.extractMetaDescription('<meta content="A page." lang="en" name="description">'),
    'A page.',
  );
});

test('a fixture reproducing the tallrig.com false positive: both title and description are read', () => {
  const html = '<html lang="en"><head>\n' +
    '<title data-sm="00000001">\n  Tallrig — Automated Quality Gate\n</title>\n' +
    '<meta name="description" data-sm="00000002" content="Automated quality gating for every push, catching regressions before they ship.">\n' +
    '</head><body>hi</body></html>';
  assert.equal(websiteExtract.extractTitle(html), 'Tallrig — Automated Quality Gate');
  assert.equal(
    websiteExtract.extractMetaDescription(html),
    'Automated quality gating for every push, catching regressions before they ship.',
  );
});
