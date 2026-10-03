// Crawler false positives found walking gatetest.io / gluecron.com
// (2026-10-03), each with the real shape beside it that must still fire.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const h = require('../src/modules/live-crawler-http-helpers');
const { extractVisibleText, extractTopHeadings } = require('../src/core/html-extract');

const judge = (html) => h.errorContentTypes({
  title: (/<title>([^<]*)<\/title>/i.exec(html) || [])[1] || '',
  headings: extractTopHeadings(html),
  visibleText: extractVisibleText(html),
});
const long = '<p>' + 'GateTest scans every push across 122 modules. '.repeat(30) + '</p>';

describe('error-page content is judged where a visitor sees it', () => {
  it('a framework not-found payload inside <script> on a healthy page is not a 404', () => {
    const html = `<html><head><title>Pricing — GateTest</title></head><body><h1>Pricing</h1>${long}<script>self.__next_f.push([1,"This page could not be found. Page not found"])</script></body></html>`;
    assert.deepStrictEqual(judge(html), []);
  });
  it('product copy that mentions an error on a full page is not an error page', () => {
    const html = `<html><head><title>Trust</title></head><body><h1>Trust</h1><p>We catch "Application error" and "something went wrong" pages before your users do.</p>${long}</body></html>`;
    assert.deepStrictEqual(judge(html), []);
  });
  it('control: a short page that says page not found is a 404', () => {
    assert.deepStrictEqual(judge('<html><head><title>Oops</title></head><body><p>Page not found</p></body></html>'), ['404-content']);
  });
  it('control: an error in the title or h1 of a long page still fires', () => {
    assert.deepStrictEqual(judge(`<html><head><title>Application error</title></head><body><h1>Dashboard</h1>${long}</body></html>`), ['app-error']);
    assert.deepStrictEqual(judge(`<html><head><title>x</title></head><body><h1>Something went wrong</h1>${long}</body></html>`), ['generic-error']);
  });
});

describe('inline images and #top', () => {
  it('data: and blob: images are not fetched (cannot be broken or time out)', () => {
    const imgs = h.extractImages('<img src="data:image/svg+xml;base64,AAAA"><img src="blob:https://x/1"><img src="/real.png">', 'https://example.test/', 'https://example.test/');
    assert.deepStrictEqual(imgs, ['https://example.test/real.png']);
  });
});

describe('one finding per broken external URL', () => {
  it('repeats of the same broken link merge into one entry listing its pages', () => {
    const list = [];
    for (let i = 0; i < 105; i += 1) h.recordBrokenLink(list, { page: `https://example.test/p${i}`, link: 'https://market.example/x', status: 404, type: 'external' });
    h.recordBrokenLink(list, { page: 'https://example.test/p0', link: 'https://other.example/y', status: 404, type: 'external' });
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].occurrences, 105);
    assert.strictEqual(list[0].pages.length, 105);
  });
  it('the checker requests each external URL once per crawl', async () => {
    let calls = 0;
    const check = h.createExternalLinkChecker(1000, async () => { calls += 1; return { status: 200 }; });
    await Promise.all([check('https://a.example/'), check('https://a.example/'), check('https://b.example/')]);
    assert.strictEqual(calls, 2);
  });
});
