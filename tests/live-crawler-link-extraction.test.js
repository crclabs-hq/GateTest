'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { extractLinks, extractImages } = require('../src/modules/live-crawler-http-helpers');

const BASE = 'https://gluecron.com';

describe('live-crawler-http-helpers — extractLinks ignores non-navigable markup', () => {
  // Reproduces the false positive found crawling gluecron.com: an inline
  // markdown-preview script does
  // `.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')`, which
  // leaves the literal text `href="$2"` sitting inside a <script> block.
  // The crawler read that as a real link and reported
  // `http-error at https://gluecron.com/$2 HTTP 404`.
  it('CONTROL PAIR — a real <a href> in the body fires; the same-looking text inside <script> does not', () => {
    const html = `
      <html><body>
        <a href="/real">real link</a>
        <script>
          const md = text.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>');
          const fake = '<a href="/fake">also fake</a>';
        </script>
      </body></html>
    `;
    const { internal } = extractLinks(html, BASE, BASE);
    assert.deepStrictEqual(internal.map((l) => l.href), [`${BASE}/real`]);
  });

  it('ignores hrefs inside <style>, <template>, and HTML comments', () => {
    const html = `
      <html><body>
        <a href="/real2">real</a>
        <style>/* background: url(href="/style-fake") */</style>
        <template><a href="/template-fake">templated, not rendered</a></template>
        <!-- <a href="/comment-fake">commented out</a> -->
      </body></html>
    `;
    const { internal } = extractLinks(html, BASE, BASE);
    assert.deepStrictEqual(internal.map((l) => l.href), [`${BASE}/real2`]);
  });

  it('extractImages also ignores <img> markup that only appears inside <script>', () => {
    const html = `
      <html><body>
        <img src="/real.png">
        <script>document.write('<img src="/script-fake.png">');</script>
      </body></html>
    `;
    const images = extractImages(html, BASE, BASE);
    assert.deepStrictEqual(images, [`${BASE}/real.png`]);
  });

  // Reproduces the second false positive: <link rel="preconnect"> /
  // rel="dns-prefetch" name an origin to warm up, not a navigation, and were
  // being checked as page links — 36 false [404]s against
  // fonts.googleapis.com on a page that never actually links there.
  it('CONTROL PAIR — resource hints (preconnect/dns-prefetch/font-preload) are skipped; a real stylesheet link is not', () => {
    const html = `
      <html><head>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="dns-prefetch" href="https://cdn.example.com">
        <link rel="preload" href="/font.woff2" as="font" crossorigin>
        <link rel="modulepreload" href="/chunk.js" as="font">
        <link rel="stylesheet" href="/style.css">
      </head><body></body></html>
    `;
    const { internal, external } = extractLinks(html, BASE, BASE);
    const allHrefs = [...internal, ...external].map((l) => l.href);
    assert.ok(!allHrefs.includes('https://fonts.googleapis.com/'), 'preconnect href must not be extracted as a link');
    assert.ok(!allHrefs.some((h) => h.includes('cdn.example.com')), 'dns-prefetch href must not be extracted as a link');
    assert.ok(!allHrefs.some((h) => h.includes('font.woff2')), 'font preload href must not be extracted as a link');
    assert.ok(!allHrefs.some((h) => h.includes('chunk.js')), 'font modulepreload href must not be extracted as a link');
    assert.ok(allHrefs.includes(`${BASE}/style.css`), 'a real stylesheet link must still be extracted (and so still checked)');
  });

  it('a non-font preload/modulepreload is NOT treated as a resource hint (still extracted)', () => {
    const html = `<link rel="preload" href="/script.js" as="script">`;
    const { internal } = extractLinks(html, BASE, BASE);
    assert.ok(internal.map((l) => l.href).includes(`${BASE}/script.js`));
  });
});
