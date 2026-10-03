'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { extractTitle } = require('../core/html-extract');

const UA = 'GateTest/1.0 (Quality Assurance Crawler)';

// Enough to see the `<html id="__next_error__">` root of a Next.js error
// shell, small enough that a hostile redirect body cannot balloon memory.
const REDIRECT_BODY_CAP = 64 * 1024;
const REDIRECT_ERROR_PAGE_MARKER = /id\s*=\s*["']__next_error__["']/;

function collectBody(res, cap) {
  return new Promise((resolve) => {
    let body = '';
    res.on('data', (chunk) => { if (body.length < cap) body += chunk; });
    res.on('end', () => resolve(body));
    res.on('error', () => resolve(body));
  });
}

function fetchPageOnce(url, timeout, extraHeaders, _originHost) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    // The origin THIS crawl entry started at — threaded through recursive
    // redirect-follows below so a later hop is judged against where the
    // chain began, not merely against the immediately previous hop (#634).
    const originHost = _originHost || parsedUrl.origin;
    const client = parsedUrl.protocol === 'https:' ? https : http;
    const startedAt = Date.now();

    const req = client.get(url, {
      timeout,
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,*/*',
        ...(extraHeaders || {}),
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl;
        let redirectOrigin;
        try {
          redirectUrl = new URL(res.headers.location, url).href;
          redirectOrigin = new URL(redirectUrl).origin;
        } catch {
          // Malformed Location header — nothing safe to follow; treat this
          // hop as terminal rather than let a broken redirect reject/hang.
          resolve({
            url, finalUrl: url, status: res.statusCode, statusText: res.statusMessage,
            contentType: res.headers['content-type'] || '', headers: res.headers, body: '',
            redirected: false, responseMs: Date.now() - startedAt,
          });
          res.resume();
          return;
        }

        if (redirectOrigin !== originHost) {
          // Off-site hop (#634): the site being crawled answered with a
          // perfectly ordinary redirect — 2xx/3xx from the target's OWN
          // origin is fine, and grading stops right there. The bug was
          // following the chain FURTHER once it left the target, ending up
          // on a page this crawl does not own and reporting THAT status
          // against the original URL (reproduced: gluecron.com/login/google
          // → Google's own OAuth redirect chain → a 404 on
          // accounts.google.com, reported as a broken link on gluecron.com).
          resolve({
            url, finalUrl: redirectUrl, status: res.statusCode, statusText: res.statusMessage,
            contentType: res.headers['content-type'] || '', headers: res.headers, body: '',
            redirected: true, redirectStatus: res.statusCode, originalUrl: url,
            offSiteRedirect: true, responseMs: Date.now() - startedAt,
          });
          res.resume();
          return;
        }

        // Auth headers only follow a redirect that stays on the same origin —
        // never leak session material to a third-party redirect target.
        const redirectHeaders =
          redirectOrigin === parsedUrl.origin ? extraHeaders : undefined;
        // A redirect is supposed to carry no page. Read this hop's body
        // (capped) so a 3xx that ships a rendered framework error page —
        // Next.js `<html id="__next_error__">` — is disclosed instead of
        // silently followed (#812: /docs answered 307 with a 16 KB one).
        collectBody(res, REDIRECT_BODY_CAP).then((hopBody) => {
          const hopIsErrorPage = REDIRECT_ERROR_PAGE_MARKER.test(hopBody);
          return fetchPageOnce(redirectUrl, timeout, redirectHeaders, originHost).then(redirectResult => {
            resolve({
              ...redirectResult,
              redirected: true,
              redirectStatus: res.statusCode,
              originalUrl: url,
              ...(hopIsErrorPage || redirectResult.redirectCarriesErrorPage
                ? { redirectCarriesErrorPage: true }
                : {}),
            });
          });
        }).catch(reject);
        return;
      }

      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        resolve({
          url,
          finalUrl: url,
          status: res.statusCode,
          statusText: res.statusMessage,
          contentType: res.headers['content-type'] || '',
          // The response headers, kept with the page so the page-level
          // modules can audit every crawled page's headers/cookies (#815).
          headers: res.headers,
          body,
          redirected: false,
          responseMs: Date.now() - startedAt,
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      // Flagged (not just worded) so a caller can tell "this page stalled"
      // apart from any other network failure without parsing message text.
      const err = new Error(`Timeout after ${timeout}ms`);
      err.isTimeout = true;
      err.elapsedMs = Date.now() - startedAt;
      reject(err);
    });
  });
}

function checkUrlOnce(url, timeout, extraHeaders) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : http;

    const req = client.request(url, {
      method: 'HEAD',
      timeout,
      headers: { 'User-Agent': UA, ...(extraHeaders || {}) },
    }, (res) => {
      resolve({ url, status: res.statusCode, statusText: res.statusMessage, headers: res.headers });
      res.resume();
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
    req.end();
  });
}

// Link (and image) extraction runs a flat regex over raw HTML, so it must
// never be shown text that only LOOKS like markup: `<script>`/`<style>`/
// `<template>` bodies and HTML comments can all contain a literal
// `href="..."` or `src="..."` that is not a real link (e.g. an inline
// templating script emitting anchor markup as a string — reproduced on
// gluecron.com, which 404'd on a URL lifted from its own markdown-preview
// script). One strip, imported by every raw-HTML extractor in this file.
function stripNonNavigableRegions(html) {
  let stripped = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, '');
  // Resource hints (<link rel="preconnect"|"dns-prefetch">, and
  // rel="preload"/"modulepreload" specifically for as="font") name an
  // origin or a URL the browser should warm up — they are never a page
  // navigation, so blank the whole tag out before the href regex runs.
  stripped = stripped.replace(/<link\b[^>]*>/gi, (tag) => (isResourceHintLinkTag(tag) ? '' : tag));
  return stripped;
}

function isResourceHintLinkTag(linkTag) {
  const relMatch = linkTag.match(/\brel\s*=\s*["']([^"']+)["']/i);
  if (!relMatch) return false;
  const rels = relMatch[1].toLowerCase().split(/\s+/);
  if (rels.includes('preconnect') || rels.includes('dns-prefetch')) return true;
  if (rels.includes('preload') || rels.includes('modulepreload')) {
    const asMatch = linkTag.match(/\bas\s*=\s*["']([^"']+)["']/i);
    return !!asMatch && asMatch[1].toLowerCase() === 'font';
  }
  return false;
}

// One definition of "which URL is this" for the crawl (#806). `new URL()`
// already gives an empty path its `/` and drops a default port, but the
// queue was seeded with the raw target string (`https://tallrig.com`) while
// every discovered link was resolved (`https://tallrig.com/`), so the apex
// was fetched twice and its title reported as a duplicate. Every URL that
// enters `visited`, the queue or a link list goes through here: empty path
// becomes `/`, default ports and the fragment are dropped.
function normaliseCrawlUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch { return url; }
}

// The href of the page's own <link rel="canonical">, whatever the attribute
// order, or null. Commented-out and templated markup is ignored.
function extractCanonicalHref(html) {
  const navigableHtml = stripNonNavigableRegions(html || '');
  const linkRe = /<link\b[^>]*>/gi;
  let m;
  while ((m = linkRe.exec(navigableHtml)) !== null) {
    const rel = m[0].match(/\brel\s*=\s*["']([^"']+)["']/i);
    if (!rel || !rel[1].toLowerCase().split(/\s+/).includes('canonical')) continue;
    const href = m[0].match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (href && href[1].trim()) return href[1].trim();
  }
  return null;
}

// What a crawled page is, once its canonical is honoured (#806). Returns the
// normalised canonical URL when it is a DIFFERENT page on the same host —
// the page is then an alias that both engines skip recording (the canonical
// is queued and recorded once, so pages, titles and links de-duplicate under
// it) — or null when the page stands for itself: no canonical, self-
// canonical, cross-host canonical (a syndicated copy is not this site's
// duplicate), unparseable, or a canonical cycle (the target was itself an
// alias, so honouring it would drop both).
function aliasTarget({ url, canonicalHref, aliasOf }) {
  if (!canonicalHref) return null;
  let target;
  let self;
  try {
    self = new URL(url);
    target = new URL(canonicalHref, url);
  } catch { return null; }
  if (target.host !== self.host || target.protocol !== self.protocol) return null;
  const key = normaliseCrawlUrl(target.href);
  if (key === normaliseCrawlUrl(self.href)) return null;
  if (aliasOf.has(key)) return null;
  return key;
}

function extractLinks(html, baseUrl, pageUrl) {
  const internal = [];
  const external = [];
  const hrefRegex = /href\s*=\s*["']([^"'#]+)/gi;
  let match;
  const navigableHtml = stripNonNavigableRegions(html);

  while ((match = hrefRegex.exec(navigableHtml)) !== null) {
    const href = match[1].trim();
    if (href.startsWith('mailto:') || href.startsWith('tel:') ||
        href.startsWith('javascript:') || href.startsWith('data:')) continue;

    try {
      const resolved = normaliseCrawlUrl(new URL(href, pageUrl).href);
      if (resolved.startsWith(baseUrl)) {
        internal.push({ href: resolved, source: pageUrl });
      } else if (href.startsWith('http')) {
        external.push({ href: resolved, source: pageUrl });
      }
    } catch { /* error-ok — malformed href — nothing to crawl */ }
  }

  return { internal, external };
}

// "What is this page's <title>" — imported by the HTTP engine's
// missing-title check, whose finding feeds the duplicate-title grouping in
// live-crawler.js (titlesByUrl). A bare `/<title>/` requires an
// attribute-free tag; framework-rendered pages commonly emit
// `<title data-sm="...">` and were reported as missing a title they plainly
// had (tallrig.com, #641). The browser engine reads `page.title()` off the
// real DOM instead of this regex, so it never had this bug and doesn't call
// this helper — but if it's ever changed to parse raw HTML for a title, this
// is the one function to reach for. The one definition now lives in
// `src/core/html-extract.js` (#653: also shared with `src/modules/seo.js`
// and the website's quick URL scan) — re-exported here for backward
// compatibility with existing callers of this module.

// One definition of "what icon does this page declare" — <link rel="icon">,
// the legacy "shortcut icon" (splits into the tokens ['shortcut','icon'], so
// checking for the 'icon' token alone covers it) and apple-touch-icon are
// all "the site has a favicon" as far as a user/browser is concerned (#641:
// live-crawler.js previously only ever probed /favicon.ico and flagged
// tallrig.com despite its declared <link rel="icon" href="/favicon.svg">).
// Reuses stripNonNavigableRegions so a <link> sitting inside a commented-out
// or templated block is never mistaken for a live declaration.
function extractDeclaredIconHref(html) {
  const navigableHtml = stripNonNavigableRegions(html);
  const linkRe = /<link\b[^>]*>/gi;
  let m;
  while ((m = linkRe.exec(navigableHtml)) !== null) {
    const tag = m[0];
    const relMatch = tag.match(/\brel\s*=\s*["']([^"']+)["']/i);
    if (!relMatch) continue;
    const rels = relMatch[1].toLowerCase().split(/\s+/);
    if (!rels.includes('icon') && !rels.includes('apple-touch-icon')) continue;
    const hrefMatch = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (hrefMatch && hrefMatch[1].trim()) return hrefMatch[1].trim();
  }
  return null;
}

function extractImages(html, baseUrl, pageUrl) {
  const images = [];
  const srcRegex = /<img[^>]+src\s*=\s*["']([^"']+)/gi;
  let match;
  const navigableHtml = stripNonNavigableRegions(html);

  while ((match = srcRegex.exec(navigableHtml)) !== null) {
    // An inline data:/blob: image is part of the page; there is nothing to
    // fetch, so it cannot be broken or time out (gatetest.io badge, 2026-10-03).
    if (/^\s*(?:data|blob):/i.test(match[1])) continue;
    try {
      const resolved = new URL(match[1].trim(), pageUrl).href;
      images.push(resolved);
    } catch { /* error-ok — malformed img src — nothing to fetch */ }
  }

  return images;
}

function getSuggestion(errorType) {
  const suggestions = {
    'http-error': 'Check server routes and ensure all pages return 200 status',
    'empty-page': 'Page is rendering blank — check component rendering and data loading',
    'missing-title': 'Add a <title> tag to every page for SEO and usability',
    'app-error': 'Application error displayed to users — check error boundaries and server logs',
    'server-error': 'Internal server error — check server logs and API endpoints',
    '404-content': 'Page displays 404 content — fix routing or remove dead links',
    'generic-error': 'Error message visible to users — fix the underlying issue',
    'js-error-in-html': 'JavaScript error rendered in page — check console and error boundaries',
    'js-runtime-error': 'JavaScript runtime error — check for null/undefined access patterns',
    'module-error': 'Module not found error — check imports and build configuration',
    'hydration-error': 'React hydration mismatch — ensure server and client render match',
    'runtime-error': 'Unhandled runtime error — add error boundaries and fix root cause',
    'mixed-content': 'HTTP resources on HTTPS page — update all resource URLs to HTTPS',
    'fetch-error': 'Page could not be loaded — check if the server is running',
    'redirect-error-page': 'A redirect answered with a rendered error page — the route throws before it redirects; make it a next.config redirect or fix the exception',
  };
  return suggestions[errorType] || 'Investigate and fix the issue';
}

// ── Error-page content: one definition for both crawl engines ───────────
// A page is an error page when it states an error where a visitor sees it:
// its <title> or a top heading, or anywhere on a page with little else on
// it. A full page whose copy MENTIONS "something went wrong" or "page not
// found" (product copy, docs), and a framework's serialized not-found
// component inside a <script>, are not error pages (gatetest.io
// 2026-10-03: 52 healthy pages flagged as 404-content).
const ERROR_PATTERNS = [
  { regex: /application error/i, type: 'app-error' },
  { regex: /internal server error/i, type: 'server-error' },
  { regex: /page not found|page could not be found/i, type: '404-content' },
  { regex: /something went wrong/i, type: 'generic-error' },
  { regex: /uncaught (type)?error/i, type: 'js-error-in-html' },
  { regex: /cannot read propert/i, type: 'js-runtime-error' },
  { regex: /module not found/i, type: 'module-error' },
  { regex: /hydration failed/i, type: 'hydration-error' },
  { regex: /unhandled runtime error/i, type: 'runtime-error' },
];
const ERROR_PAGE_MAX_TEXT = 600;

/** Error-pattern types a page shows, judged by where they appear. */
function errorContentTypes({ title = '', headings = [], visibleText = '' }) {
  const prominent = [title || '', ...(headings || [])].join('\n');
  const shortPage = String(visibleText || '').trim().length < ERROR_PAGE_MAX_TEXT;
  return ERROR_PATTERNS
    .filter(({ regex }) => regex.test(prominent) || (shortPage && regex.test(visibleText || '')))
    .map(({ type }) => type);
}

// ── One check, and one finding, per external URL ─────────────────────────
// A footer link appears on every page. Checking it per page re-requested the
// same URL ~105 times on gatetest.io and reported it 105 times (2026-10-03).
// The result is cached for the crawl, and a broken URL is ONE entry that
// lists the pages linking to it.
function createExternalLinkChecker(timeout, check = checkUrl) {
  const cache = new Map(); // href -> Promise<{status, rateLimited?} | {error}>
  return function checkExternal(href) {
    if (!cache.has(href)) {
      cache.set(href, check(href, timeout).then((r) => r, (err) => ({ error: err && err.message ? err.message : 'error' })));
    }
    return cache.get(href);
  };
}

/** Add a broken link, merging repeats of the same URL into one entry with a `pages` list. */
function recordBrokenLink(brokenLinks, entry) {
  const existing = brokenLinks.find((b) => b.link === entry.link && b.type === entry.type);
  if (existing) {
    existing.pages = existing.pages || [existing.page];
    if (!existing.pages.includes(entry.page)) existing.pages.push(entry.page);
    existing.occurrences = existing.pages.length;
    return;
  }
  brokenLinks.push({ ...entry, pages: [entry.page], occurrences: 1 });
}

// ── Rate limiting is the site's answer to OUR request rate ───────────────
// A 429 (or a 503 that carries Retry-After) says "slow down", not "this
// page is broken". The crawler fetches a page plus its scripts, styles and
// images back to back, and over 100 pages that burst tripped gluecron.com's
// limiter: ~35 pages reported as HTTP 429 failures, while 120 parallel
// requests from a browser drew none (2026-10-03). So: honour Retry-After
// (capped), back off this host for the rest of the crawl, retry twice, and
// if it is still limiting, return the response marked `rateLimited` —
// callers report that page as "not checked", never as a broken page.
const RATE_LIMIT_MAX_WAIT_MS = 10000;
const RATE_LIMIT_RETRIES = 2;
const hostDelayMs = new Map(); // host -> politeness delay after a 429, for this process's crawl
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRateLimited(res) {
  if (!res) return false;
  if (res.status === 429) return true;
  const h = res.headers || {};
  return res.status === 503 && (h['retry-after'] !== undefined || h['Retry-After'] !== undefined);
}

function retryAfterMs(res, attempt) {
  const h = (res && res.headers) || {};
  const raw = h['retry-after'] !== undefined ? h['retry-after'] : h['Retry-After'];
  let ms = NaN;
  if (raw !== undefined) {
    const secs = Number(raw);
    ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(raw) - Date.now();
  }
  if (!Number.isFinite(ms) || ms < 0) ms = 1000 * 2 ** attempt;
  return Math.min(ms, RATE_LIMIT_MAX_WAIT_MS);
}

async function withRateLimitRetry(url, once) {
  let host = '';
  try { host = new URL(url).host; } catch { /* malformed: the request itself reports it */ }
  let res;
  for (let attempt = 0; ; attempt += 1) {
    const delay = hostDelayMs.get(host) || 0;
    if (delay) await sleep(delay);
    res = await once();
    if (!isRateLimited(res)) return res;
    const wait = retryAfterMs(res, attempt);
    hostDelayMs.set(host, Math.min(Math.max(delay * 2, 250), 2000));
    if (attempt >= RATE_LIMIT_RETRIES) return { ...res, rateLimited: true };
    await sleep(wait);
  }
}

function fetchPage(url, timeout, extraHeaders) {
  return withRateLimitRetry(url, () => fetchPageOnce(url, timeout, extraHeaders));
}

function checkUrl(url, timeout, extraHeaders) {
  return withRateLimitRetry(url, () => checkUrlOnce(url, timeout, extraHeaders));
}

module.exports = {
  fetchPage, checkUrl, extractLinks, extractImages, getSuggestion,
  extractTitle, extractDeclaredIconHref,
  normaliseCrawlUrl, extractCanonicalHref, aliasTarget,
  isRateLimited, retryAfterMs, _hostDelayMs: hostDelayMs,
  errorContentTypes, ERROR_PATTERNS,
  createExternalLinkChecker, recordBrokenLink,
};
