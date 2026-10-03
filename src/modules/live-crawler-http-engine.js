'use strict';

const { URL } = require('url');
const {
  fetchPage, checkUrl, extractLinks, extractImages, extractTitle,
  normaliseCrawlUrl, extractCanonicalHref, aliasTarget, errorContentTypes,
  createExternalLinkChecker, recordBrokenLink,
} = require('./live-crawler-http-helpers');
const { authHeadersFor } = require('./live-crawler-auth');
const { extractVisibleText, extractTopHeadings } = require('../core/html-extract');



async function crawlWithHttp(ctx) {
  const {
    baseUrl, maxPages, timeout, pageTimeout, checkExternal,
    visited, pages, errors, brokenLinks, brokenImages, redirects, queue,
    // Phase-2 collectors (closure-bug fix: explicit pass-through)
    brokenScripts, brokenStylesheets,
    missingMetaDescription, missingCanonical,
    slowPages, slowThresholdMs, anchorMissingId, titlesByUrl,
    timedOutPages, offSiteRedirects, crawlDeadlineTs,
    // URLs the site rate-limited (429 / 503+Retry-After) after backing off:
    // NOT checked, never "broken" (live-crawler-http-helpers.js).
    rateLimited = [],
    auth,
    // #806: canonical alias URL -> the canonical it was folded into
    aliasOf = new Map(),
  } = ctx;

  let budgetExhausted = false;
  const checkExternalLink = createExternalLinkChecker(timeout);

  while (queue.length > 0 && visited.size < maxPages) {
    // Crawl-wide wall-clock budget (#640): stop taking new pages once there
    // is no longer time to safely attempt one more (worst case: pageTimeout)
    // before the deadline this run was allotted (live-crawler.js's
    // crawlDeadlineTs, derived from the module's own assigned timeout).
    // Whatever is already in `pages` ships as a partial report instead of
    // the runner's outer race timeout discarding it entirely. The very
    // first page is always attempted regardless — an assigned budget
    // smaller than a single page's own timeout is a misconfiguration the
    // runner's own race timer remains the safety net for, not something to
    // fake a deadline for here.
    if (crawlDeadlineTs && visited.size > 0 && Date.now() + pageTimeout > crawlDeadlineTs) {
      budgetExhausted = true;
      break;
    }

    const rawUrl = queue.shift();
    const url = rawUrl && normaliseCrawlUrl(rawUrl);
    if (!url || visited.has(url)) continue;
    visited.add(url);

    try {
      // The main page fetch uses its OWN budget (pageTimeout), separate from
      // `timeout` (used below for per-asset/per-link HEAD checks) — a page
      // that stalls must cost at most one bounded slot in the queue, not an
      // unbounded share of the module's overall wall-clock ceiling.
      const pageResult = await fetchPage(url, pageTimeout, authHeadersFor(url, auth));

      // #806: a page whose <link rel="canonical"> names a DIFFERENT page on
      // this host is that page's alias (`/index.html`, `/?utm=…`, a trailing-
      // slash twin). It is not recorded as a page of its own — pages, titles
      // and per-page findings de-duplicate under the canonical, which is
      // queued next and recorded once. The alias's links are still followed.
      if (pageResult.status < 400 && pageResult.body && pageResult.contentType?.includes('text/html')) {
        const canonical = aliasTarget({ url, canonicalHref: extractCanonicalHref(pageResult.body), aliasOf });
        if (canonical) {
          aliasOf.set(url, canonical);
          if (!visited.has(canonical) && !queue.includes(canonical)) queue.unshift(canonical);
          for (const link of extractLinks(pageResult.body, baseUrl, url).internal) {
            if (!visited.has(link.href) && !queue.includes(link.href)) queue.push(link.href);
          }
          continue;
        }
      }

      pages.push(pageResult);

      if (pageResult.offSiteRedirect) {
        // #634: the target's own first hop was a normal redirect (fine) —
        // it left the target's origin, so it's disclosed, not graded as a
        // finding against this site.
        offSiteRedirects.push({
          page: url,
          redirectTo: pageResult.finalUrl,
          status: pageResult.status,
          message: 'third-party redirect chain, terminal host ≠ target',
        });
      } else if (pageResult.rateLimited) {
        rateLimited.push({ url, status: pageResult.status, kind: 'page' });
        continue;
      } else if (pageResult.status >= 400) {
        errors.push({ url, status: pageResult.status, type: 'http-error',
          message: `HTTP ${pageResult.status} ${pageResult.statusText}` });
      }

      if (pageResult.redirected) {
        redirects.push({ from: url, to: pageResult.finalUrl, status: pageResult.redirectStatus });
      }

      if (pageResult.redirectCarriesErrorPage) {
        errors.push({ url, status: pageResult.redirectStatus, type: 'redirect-error-page',
          message: `redirect carries an error page (HTTP ${pageResult.redirectStatus} with an __next_error__ body)` });
      }

      if (!pageResult.contentType?.includes('text/html')) continue;
      if (!pageResult.body) continue;

      const body = pageResult.body;
      const textContent = body.replace(/<[^>]*>/g, '').trim();
      if (textContent.length < 50 && !url.includes('api')) {
        errors.push({ url, type: 'empty-page',
          message: `Page appears blank or nearly empty (${textContent.length} chars of text)` });
      }

      const title = extractTitle(body);
      if (!title) {
        errors.push({ url, type: 'missing-title', message: 'Page has no <title> or title is empty' });
      } else {
        titlesByUrl.set(url, title);
      }

      const metaDescMatch = body.match(/<meta\s+[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["']/i);
      if (!metaDescMatch || metaDescMatch[1].trim().length === 0) {
        missingMetaDescription.push({ url, message: 'No meta description tag' });
      }

      const canonicalMatch = body.match(/<link\s+[^>]*rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["']([^"']+)["']/i);
      if (!canonicalMatch) {
        missingCanonical.push({ url, message: 'No <link rel="canonical"> tag' });
      }

      if (pageResult.responseMs && pageResult.responseMs > slowThresholdMs) {
        slowPages.push({ url, responseMs: pageResult.responseMs,
          message: `Page took ${pageResult.responseMs}ms (threshold ${slowThresholdMs}ms)` });
      }

      const idsOnPage = new Set();
      const idRegex = /\bid\s*=\s*["']([^"'\s]+)["']/gi;
      let idMatch;
      while ((idMatch = idRegex.exec(body)) !== null) {
        idsOnPage.add(idMatch[1]);
      }
      const anchorRegex = /<a\s+[^>]*href\s*=\s*["']#([^"'\s]+)["']/gi;
      let anchorMatch;
      while ((anchorMatch = anchorRegex.exec(body)) !== null) {
        const targetId = anchorMatch[1];
        // HTML: a fragment of "top" (any case) scrolls to the top of the
        // document when no element has that id — it is never broken.
        if (/^top$/i.test(targetId)) continue;
        if (!idsOnPage.has(targetId)) {
          anchorMissingId.push({ page: url, anchor: `#${targetId}`,
            message: `<a href="#${targetId}"> targets a non-existent id` });
        }
      }

      // Judged where a visitor sees it (errorContentTypes, the one rule).
      for (const type of errorContentTypes({
        title: extractTitle(body) || '',
        headings: extractTopHeadings(body),
        visibleText: extractVisibleText(body),
      })) {
        errors.push({ url, type, message: `Error pattern detected on page: "${type}"` });
      }

      const links = extractLinks(body, baseUrl, url);
      for (const link of links.internal) {
        if (!visited.has(link.href) && !queue.includes(link.href)) queue.push(link.href);
      }

      const images = extractImages(body, baseUrl, url);
      for (const imgUrl of images) {
        try {
          // authHeadersFor is same-origin gated — external images get no auth
          const imgResult = await checkUrl(imgUrl, timeout, authHeadersFor(imgUrl, auth));
          if (imgResult.rateLimited) {
            rateLimited.push({ url: imgResult.url, status: imgResult.status, kind: 'image' });
          } else if (imgResult.status >= 400) {
            brokenImages.push({ page: url, image: imgUrl, status: imgResult.status });
          }
        } catch {
          brokenImages.push({ page: url, image: imgUrl, status: 'timeout/error' });
        }
      }

      await collectAssetStatuses(body, url, timeout, brokenScripts, brokenStylesheets, auth, rateLimited);

      if (checkExternal) {
        for (const link of links.external.slice(0, 20)) {
          const linkResult = await checkExternalLink(link.href);
          if (linkResult.error) {
            recordBrokenLink(brokenLinks, { page: url, link: link.href, status: 'timeout/error', type: 'external' });
          } else if (linkResult.rateLimited) {
            if (!rateLimited.some((r) => r.url === link.href)) rateLimited.push({ url: link.href, status: linkResult.status, kind: 'external-link' });
          } else if (linkResult.status >= 400) {
            recordBrokenLink(brokenLinks, { page: url, link: link.href, status: linkResult.status, type: 'external' });
          }
        }
      }

      if (url.startsWith('https://')) {
        const httpResources = body.match(/(?:src|href|action)\s*=\s*["']http:\/\//gi);
        if (httpResources && httpResources.length > 0) {
          errors.push({ url, type: 'mixed-content',
            message: `${httpResources.length} HTTP resource(s) on HTTPS page (mixed content)` });
        }
      }

    } catch (err) {
      if (err && err.isTimeout) {
        const elapsedMs = err.elapsedMs || pageTimeout;
        timedOutPages.push({ url, elapsedMs, message: `Page fetch timed out after ${elapsedMs}ms (budget ${pageTimeout}ms)` });
      } else {
        errors.push({ url, type: 'fetch-error', message: `Failed to fetch: ${err.message}` });
      }
    }
  }

  return { budgetExhausted };
}

async function collectAssetStatuses(body, url, timeout, brokenScripts, brokenStylesheets, auth, rateLimited = []) {
  const scriptRegex = /<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  const scriptUrls = new Set();
  let scriptMatch;
  while ((scriptMatch = scriptRegex.exec(body)) !== null) {
    try {
      const resolved = new URL(scriptMatch[1].trim(), url).href;
      scriptUrls.add(resolved);
    } catch { /* error-ok — malformed script src — nothing to fetch */ }
  }
  for (const scriptUrl of scriptUrls) {
    try {
      const r = await checkUrl(scriptUrl, timeout, authHeadersFor(scriptUrl, auth));
      if (r.rateLimited) rateLimited.push({ url: r.url, status: r.status, kind: 'script' });
      else if (r.status >= 400) brokenScripts.push({ page: url, script: scriptUrl, status: r.status });
    } catch {
      brokenScripts.push({ page: url, script: scriptUrl, status: 'timeout/error' });
    }
  }

  const styleRegex = /<link\s+[^>]*rel\s*=\s*["'](?:stylesheet|preload)["'][^>]*href\s*=\s*["']([^"']+)["']/gi;
  const styleUrls = new Set();
  let styleMatch;
  while ((styleMatch = styleRegex.exec(body)) !== null) {
    try {
      const resolved = new URL(styleMatch[1].trim(), url).href;
      styleUrls.add(resolved);
    } catch { /* error-ok — malformed stylesheet href — nothing to fetch */ }
  }
  for (const styleUrl of styleUrls) {
    try {
      const r = await checkUrl(styleUrl, timeout, authHeadersFor(styleUrl, auth));
      if (r.rateLimited) rateLimited.push({ url: r.url, status: r.status, kind: 'stylesheet' });
      else if (r.status >= 400) brokenStylesheets.push({ page: url, stylesheet: styleUrl, status: r.status });
    } catch {
      brokenStylesheets.push({ page: url, stylesheet: styleUrl, status: 'timeout/error' });
    }
  }
}

module.exports = { crawlWithHttp };
