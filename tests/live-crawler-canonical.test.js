'use strict';

// #806 — the crawler counted https://tallrig.com and https://tallrig.com/ as
// two pages (the queue was seeded with the raw target string, every link was
// resolved) and reported the apex's own title as a duplicate, on a site with
// no duplicate. `normaliseCrawlUrl` and `aliasTarget` (live-crawler-http-
// helpers.js) are the one definition both engines import.

const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const LiveCrawlerModule = require('../src/modules/live-crawler');
const { normaliseCrawlUrl, extractCanonicalHref, aliasTarget } = require('../src/modules/live-crawler-http-helpers');

const servers = [];
const fetched = [];
after(() => { for (const s of servers) s.close(); });

const FILLER = 'plenty of visible text here so the blank-page check stays quiet, and then some more of it';

function page(title, body, canonical) {
  const link = canonical ? `<link rel="canonical" href="${canonical}">` : '';
  return `<html><head><title>${title}</title>${link}</head><body>${FILLER} ${body}</body></html>`;
}

/** Serve `routes(port)` (path -> html) and crawl it over HTTP; resolves to the checks the run raised. */
async function crawl(routes, { seedWithoutSlash = false } = {}) {
  let port;
  const server = http.createServer((req, res) => {
    fetched.push(req.url);
    const html = routes(port)[req.url];
    res.writeHead(html ? 200 : 404, { 'Content-Type': 'text/html' });
    res.end(html || page('Not found', ''));
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  fetched.length = 0;
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
  const config = {
    projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'gt-crawl-canonical-')),
    getModuleConfig: () => ({
      url: seedWithoutSlash ? `http://127.0.0.1:${port}` : `http://127.0.0.1:${port}/`,
      maxPages: 10, timeout: 5000, browser: false,
      checkExternal: false, checkSitemap: false, checkRobotsTxt: false, checkFavicon: false,
    }),
    get: () => undefined,
  };
  await new LiveCrawlerModule().run(result, config);
  return checks;
}

const duplicateTitles = (checks) => checks.find((c) => c.name === 'crawl:duplicate-titles');
const crawledPages = (checks) => {
  const c = checks.find((x) => x.name === 'crawl:pages-scanned');
  return Number(/Crawled (\d+) page/.exec(c.details.message)[1]);
};

describe('normaliseCrawlUrl — one definition (#806)', () => {
  it('CONTROL — empty path becomes /, default ports and fragments drop', () => {
    assert.strictEqual(normaliseCrawlUrl('https://tallrig.com'), 'https://tallrig.com/');
    assert.strictEqual(normaliseCrawlUrl('https://tallrig.com:443/a#x'), 'https://tallrig.com/a');
    assert.strictEqual(normaliseCrawlUrl('http://tallrig.com:80/'), 'http://tallrig.com/');
  });
  it('POSITIVE CONTROL — distinct paths, queries and non-default ports stay distinct', () => {
    assert.notStrictEqual(normaliseCrawlUrl('https://tallrig.com/a'), normaliseCrawlUrl('https://tallrig.com/b'));
    assert.notStrictEqual(normaliseCrawlUrl('https://tallrig.com/a?x=1'), normaliseCrawlUrl('https://tallrig.com/a'));
    assert.notStrictEqual(normaliseCrawlUrl('https://tallrig.com:8443/'), normaliseCrawlUrl('https://tallrig.com/'));
  });
  it('an unparseable value is returned untouched, never thrown on', () => {
    assert.strictEqual(normaliseCrawlUrl('not a url'), 'not a url');
  });
});

describe('aliasTarget / extractCanonicalHref (#806)', () => {
  it('CONTROL — a same-host canonical to another page is an alias; self, cross-host, none and cycles are not', () => {
    const aliasOf = new Map();
    assert.strictEqual(aliasTarget({ url: 'https://a.com/x', canonicalHref: '/y', aliasOf }), 'https://a.com/y');
    assert.strictEqual(aliasTarget({ url: 'https://a.com/', canonicalHref: 'https://a.com', aliasOf }), null);
    assert.strictEqual(aliasTarget({ url: 'https://a.com/x', canonicalHref: 'https://other.com/x', aliasOf }), null);
    assert.strictEqual(aliasTarget({ url: 'https://a.com/x', canonicalHref: null, aliasOf }), null);
    aliasOf.set('https://a.com/x', 'https://a.com/y');
    assert.strictEqual(aliasTarget({ url: 'https://a.com/y', canonicalHref: '/x', aliasOf }), null,
      'a canonical cycle must not drop both pages');
  });
  it('reads rel/href in either attribute order, and ignores a commented-out link', () => {
    assert.strictEqual(extractCanonicalHref('<link href="/a" rel="canonical">'), '/a');
    assert.strictEqual(extractCanonicalHref('<link rel="canonical" href="/b">'), '/b');
    assert.strictEqual(extractCanonicalHref('<!-- <link rel="canonical" href="/c"> -->'), null);
    assert.strictEqual(extractCanonicalHref('<link rel="stylesheet" href="/s.css">'), null);
  });
});

describe('liveCrawler — apex and canonical de-duplication end-to-end (#806)', () => {
  it('apex seeded without the slash, linked both ways, plus a canonical alias -> the apex is one page, no duplicate-title finding', async () => {
    const checks = await crawl((p) => ({
      '/': page('Home', `<a href="http://127.0.0.1:${p}">apex</a> <a href="/">slash</a> <a href="/index.html">index</a> <a href="/about">about</a>`, `http://127.0.0.1:${p}/`),
      '/index.html': page('Home', '<a href="/about">about</a>', `http://127.0.0.1:${p}/`),
      '/about': page('About', '', `http://127.0.0.1:${p}/about`),
    }), { seedWithoutSlash: true });
    assert.strictEqual(duplicateTitles(checks), undefined, 'apex + its canonical alias must not read as a duplicate title');
    assert.strictEqual(crawledPages(checks), 2, 'the apex and /about — the alias is not a third page');
    assert.strictEqual(fetched.filter((u) => u === '/').length, 1, 'the apex is fetched once');
  });

  it('POSITIVE CONTROL — two distinct paths, same title, no canonical -> the duplicate-title finding still fires', async () => {
    const checks = await crawl(() => ({
      '/': page('Site', '<a href="/a">a</a> <a href="/b">b</a>'),
      '/a': page('Same title', ''),
      '/b': page('Same title', ''),
    }));
    const dup = duplicateTitles(checks);
    assert.ok(dup, 'a real duplicate title must still be reported');
    assert.strictEqual(dup.details.details[0].title, 'Same title');
    assert.strictEqual(dup.details.details[0].count, 2);
    assert.strictEqual(crawledPages(checks), 3);
  });

  it('a page whose canonical points at another crawled URL is counted once, under the canonical', async () => {
    const checks = await crawl((p) => ({
      '/': page('Home', '<a href="/copy">copy</a> <a href="/real">real</a>'),
      '/copy': page('Real page', '', `http://127.0.0.1:${p}/real`),
      '/real': page('Real page', '', `http://127.0.0.1:${p}/real`),
    }));
    assert.strictEqual(duplicateTitles(checks), undefined, 'the alias and its canonical are one page');
    assert.strictEqual(crawledPages(checks), 2, 'the home page and /real; /copy folds into /real');
  });

  it('POSITIVE CONTROL — a canonical to another host does not fold the page away', async () => {
    const checks = await crawl(() => ({
      '/': page('Home', '<a href="/syndicated">s</a>'),
      '/syndicated': page('Syndicated', '', 'https://elsewhere.example/original'),
    }));
    assert.strictEqual(crawledPages(checks), 2);
  });
});
