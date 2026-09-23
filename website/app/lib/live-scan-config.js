'use strict';

/**
 * One shared definition (Doctrine #4) of how a hosted web-URL scan builds
 * its live-scan config — issue #681 item 1.
 *
 * Before this file existed, `/api/web/scan` (JSON) and
 * `/api/web/scan/stream` (SSE) each carried their OWN copy of the "fetch
 * the page once, then wire targetUrl/webUrl/config.livePage onto the
 * engine" logic. Two independent copies can silently drift — a fix landed
 * in one route's copy is not automatically present in the other's — with
 * no test able to catch that the JSON route and the SSE route quietly
 * disagree about the same URL. A live scan of tallrig.com on 2026-09-22
 * showed exactly that: the non-streaming route reported 6 of 20 web-suite
 * modules "not checked" (webHeaders, tlsSecurity, cookieSecurity,
 * accessibility, seo, links) where the streaming route's equivalent
 * config-wiring left only the two modules that are honestly not-checked
 * even WITH a live page (tlsSecurity needs a raw socket; links needs its
 * own crawl — issue #681 item 4 gives links a crawl-backed live mode too).
 *
 * Both routes now call `fetchLivePage` + `applyLiveScanConfig` from here —
 * one definition, imported — so they cannot independently regress.
 */

const DEFAULT_FETCH_TIMEOUT_MS = 15000;

/**
 * Fetch the target page ONCE. webHeaders, seo, accessibility and
 * cookieSecurity all read the result via `config.livePage` instead of each
 * re-fetching the page (issue #643). Never throws: a failed fetch resolves
 * to `null` and the affected modules report themselves `not-checked` with
 * their own reason rather than fabricating a pass.
 *
 * @param {string} targetUrl
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ url: string, status: number, headers: Headers, html: string } | null>}
 */
async function fetchLivePage(targetUrl, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_FETCH_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl || fetch;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(targetUrl, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'GateTest/1.0 Web Scanner (gatetest.io)' },
      });
    } finally {
      clearTimeout(timer);
    }
    const html = await res.text().catch(() => '');
    return { url: res.url || targetUrl, status: res.status, headers: res.headers, html };
  } catch {
    // error-ok — livePage stays null; affected modules report not-checked with a reason
    return null;
  }
}

/**
 * Wire targetUrl/webUrl, the optional authed-crawl headers/cookie, and the
 * shared livePage fetch onto a freshly `init()`'d GateTest instance — the
 * EXACT config every hosted web-scan route must build so they check the
 * same modules for the same URL (issue #681 item 1).
 *
 * @param {{ config: ({ set?: (k: string, v: unknown) => void, data?: Record<string, unknown> } & Record<string, unknown>) | undefined | null }} gt
 * @param {{
 *   targetUrl: string,
 *   livePage?: { url: string, status: number, headers: unknown, html: string } | null,
 *   sanitizedAuth?: { headers?: Record<string, string>, cookie?: string } | null,
 * }} args
 */
function applyLiveScanConfig(gt, { targetUrl, livePage, sanitizedAuth } = {}) {
  const cfg = gt && gt.config;
  if (!cfg) return;

  if (typeof cfg.set === 'function') {
    cfg.set('targetUrl', targetUrl);
    cfg.set('webUrl', targetUrl);
    if (sanitizedAuth) {
      // Same-origin gating happens engine-side (live-crawler-auth.js):
      // these values only ever reach the scan target's own origin.
      if (sanitizedAuth.headers) cfg.set('modules.liveCrawler.headers', sanitizedAuth.headers);
      if (sanitizedAuth.cookie) cfg.set('modules.liveCrawler.cookie', sanitizedAuth.cookie);
    }
  } else if (cfg.data) {
    cfg.data.targetUrl = targetUrl;
    cfg.data.webUrl = targetUrl;
  }

  // Direct property, not `.set()` — `.set()` nests under
  // `config.config.livePage`, but every module reads `config.livePage`
  // directly (see src/modules/base-module.js `_isUrlOnlyScan`).
  if (livePage) cfg.livePage = livePage;
}

module.exports = { fetchLivePage, applyLiveScanConfig, DEFAULT_FETCH_TIMEOUT_MS };
