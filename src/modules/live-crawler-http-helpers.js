'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const UA = 'GateTest/1.0 (Quality Assurance Crawler)';

function fetchPage(url, timeout, extraHeaders) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
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
        const redirectUrl = new URL(res.headers.location, url).href;
        // Auth headers only follow a redirect that stays on the same origin —
        // never leak session material to a third-party redirect target.
        const redirectHeaders =
          new URL(redirectUrl).origin === parsedUrl.origin ? extraHeaders : undefined;
        fetchPage(redirectUrl, timeout, redirectHeaders).then(redirectResult => {
          resolve({
            ...redirectResult,
            redirected: true,
            redirectStatus: res.statusCode,
            originalUrl: url,
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

function checkUrl(url, timeout, extraHeaders) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : http;

    const req = client.request(url, {
      method: 'HEAD',
      timeout,
      headers: { 'User-Agent': UA, ...(extraHeaders || {}) },
    }, (res) => {
      resolve({ url, status: res.statusCode, statusText: res.statusMessage });
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
      const resolved = new URL(href, pageUrl).href;
      if (resolved.startsWith(baseUrl)) {
        internal.push({ href: resolved, source: pageUrl });
      } else if (href.startsWith('http')) {
        external.push({ href: resolved, source: pageUrl });
      }
    } catch { /* error-ok — malformed href — nothing to crawl */ }
  }

  return { internal, external };
}

function extractImages(html, baseUrl, pageUrl) {
  const images = [];
  const srcRegex = /<img[^>]+src\s*=\s*["']([^"']+)/gi;
  let match;
  const navigableHtml = stripNonNavigableRegions(html);

  while ((match = srcRegex.exec(navigableHtml)) !== null) {
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
  };
  return suggestions[errorType] || 'Investigate and fix the issue';
}

module.exports = { fetchPage, checkUrl, extractLinks, extractImages, getSuggestion };
