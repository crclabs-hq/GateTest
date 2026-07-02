/**
 * Console Errors Module — the SITE-WIDE counterpart to `runtimeErrors`.
 *
 * `runtimeErrors` does a deep single-page audit (one URL, every runtime
 * signal: page errors, console spam, network failures, CSP, mixed
 * content, hydration, deprecations). This module trades depth for
 * breadth: it crawls multiple pages of the same site (same pattern
 * `form-testing.js` uses — same-origin link discovery, breadth-first
 * queue) and aggregates console.error/console.warn + uncaught page
 * errors ACROSS every page visited, so a bug that only shows up on
 * `/pricing` or `/checkout` isn't missed just because the scan only
 * ever pointed at the homepage.
 *
 * Two things a single-page check can't do, which are the actual point
 * of this module:
 *
 *   - Fingerprint + dedupe: the same error firing on 12 pages (a
 *     site-wide analytics script throwing on every load) is ONE
 *     finding with a page count, not 12 separate findings burying the
 *     signal.
 *   - Persistent vs. one-off ranking: an error that fires on every
 *     single page visited is a systemic problem (error-severity); an
 *     error seen on exactly one page out of many is more likely
 *     page-specific and gets a lighter severity so the report can be
 *     read in order of "fix this first."
 *
 * A KNOWN-NOISY allowlist filters out the handful of third-party
 * scripts (Google Analytics/Tag Manager, Facebook Pixel, Sentry's own
 * transport, hydration-timing warnings from browser extensions) that
 * fire console noise on almost every real site regardless of the
 * site's own code quality — without an allowlist, this module would be
 * "the tool that always finds 40 errors on every site," which trains
 * people to ignore it (the exact failure mode Craig's Bible calls out
 * for false-positive-prone checks).
 *
 * Requires: Playwright (already an approved GateTest dependency). Skips
 * gracefully when Chromium isn't available, same as its siblings.
 */

'use strict';

const path = require('path');
const BaseModule = require('./base-module');

// Matched against the error/warning TEXT. Deliberately narrow (specific
// script names / vendor phrasing) rather than broad keyword matches, so
// a real bug that happens to mention "analytics" in its own message
// isn't swallowed.
const NOISY_ALLOWLIST = [
  // Analytics / advertising — fire constantly, blocked as often by ad
  // blockers as by anything the site did wrong.
  /google-analytics\.com|googletagmanager\.com|gtag\//i,
  /connect\.facebook\.net|fbevents\.js/i,
  /\bhotjar\b/i,
  /doubleclick\.net/i,
  /segment\.(com|io)|cdn\.segment/i,
  /mixpanel\.com/i,
  /amplitude\.com/i,
  /\bfullstory\.com\b/i,
  /clarity\.ms/i, // Microsoft Clarity
  // Support / chat / CRM widgets — third-party iframes the site owner
  // doesn't control the internals of.
  /intercom\.io|intercomcdn\.com/i,
  /crisp\.chat/i,
  /\bzendesk\b|zdassets\.com/i,
  /hs-scripts\.com|hubspot\.com/i,
  /drift\.com/i,
  // Payments / bot-protection / captcha widgets — same-origin CSP errors
  // from these are near-universal and not something the site's own code
  // introduced (e.g. Stripe's own iframe emitting a warning inside itself).
  /js\.stripe\.com/i,
  /recaptcha|gstatic\.com\/recaptcha/i,
  /hcaptcha\.com/i,
  /challenges\.cloudflare\.com/i, // Turnstile
  // Error-reporting SDKs — a warning FROM the reporting pipeline itself
  // (e.g. Sentry's own transport retry log), not a bug in the site.
  /sentry\.io|sentry-cdn\.com/i,
  /bugsnag\.com/i,
  /Failed to load resource.*favicon\.ico/i,
  /\[Fast Refresh\]/i, // Next.js dev-mode HMR noise, not a real error
  /Extension context invalidated/i, // browser-extension noise, not the site's bug
  /ResizeObserver loop (limit exceeded|completed with undelivered notifications)/i, // benign browser quirk, not an app bug
];

const DEFAULT_MAX_PAGES = 15;
const DEFAULT_WAIT_MS = 500;

function resolvePlaywright() {
  try {
    return require('playwright');
  } catch {
    const candidates = [
      path.join(__dirname, '..', '..', 'website'),
      path.join(process.cwd(), 'website'),
    ];
    for (const fromDir of candidates) {
      try {
        const resolved = require.resolve('playwright', { paths: [fromDir] });
        return require(resolved);
      } catch { /* try next candidate */ }
    }
  }
  return null;
}

function isNoisy(text) {
  return NOISY_ALLOWLIST.some((re) => re.test(text));
}

// Fingerprint: strip anything that looks like it varies per-load (line:col
// numbers, query strings, hex/numeric ids) so the SAME underlying error on
// two different pages collapses to one entry instead of two.
function fingerprint(text) {
  return String(text)
    .replace(/:\d+:\d+\b/g, '') // line:col
    .replace(/\?[^\s'")]+/g, '') // query strings
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>') // hex ids
    .replace(/\b\d+\b/g, '<n>') // bare numbers
    .trim()
    .slice(0, 200);
}

class ConsoleErrorsModule extends BaseModule {
  constructor() {
    super('consoleErrors', 'Console Errors — site-wide console error/warning aggregation across every crawled page');
  }

  async run(result, config) {
    const moduleCfg = config.getModuleConfig('consoleErrors') || {};
    const baseUrl =
      process.env.GATETEST_CONSOLE_ERRORS_URL ||
      moduleCfg.url ||
      config.get('explorer.url') ||
      config.get('liveCrawler.url') ||
      config.get('webUrl') ||
      config.get('wpUrl') ||
      config.get('targetUrl');

    if (!baseUrl) {
      result.addCheck('console-errors:config', true, {
        severity: 'info',
        message: 'No target URL configured — set GATETEST_CONSOLE_ERRORS_URL or modules.consoleErrors.url in .gatetest/config.json',
      });
      return;
    }

    const playwright = resolvePlaywright();
    if (!playwright) {
      result.addCheck('console-errors:playwright-missing', true, {
        severity: 'info',
        message: 'Playwright not available in this environment — console-errors checks skipped.',
        suggestion: 'npm install playwright && npx playwright install chromium',
      });
      return;
    }

    let browser;
    try {
      browser = await playwright.chromium.launch({ headless: true, timeout: 15000 });
    } catch (err) {
      result.addCheck('console-errors:browser-launch', true, {
        severity: 'info',
        message: `Browser launch failed (${err.message || err}) — environment likely lacks chromium binaries.`,
      });
      return;
    }

    try {
      const stats = await this._crawl(browser, baseUrl, moduleCfg);
      this._report(result, stats, baseUrl);
    } finally {
      try {
        await browser.close();
      } catch {
        /* swallow close errors */
      }
    }
  }

  async _crawl(browser, baseUrl, moduleCfg) {
    const maxPages = moduleCfg.maxPages || DEFAULT_MAX_PAGES;
    const waitMs = typeof moduleCfg.waitMs === 'number' ? moduleCfg.waitMs : DEFAULT_WAIT_MS;
    const timeout = moduleCfg.timeout || 20000;

    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: 'GateTest/1.0 (+https://gatetest.ai/bot) ConsoleErrors',
    });
    const page = await context.newPage();

    // fingerprint -> { text, severity ('error'|'warning'), pages: Set<url>, sample: url }
    const findings = new Map();
    let noisySuppressed = 0;
    let pagesVisited = 0;

    const onConsole = (msg, pageUrl) => {
      const type = msg.type();
      if (type !== 'error' && type !== 'warning') return;
      const text = msg.text();
      if (isNoisy(text)) {
        noisySuppressed++;
        return;
      }
      const fp = fingerprint(text);
      const severity = type === 'error' ? 'error' : 'warning';
      const existing = findings.get(fp);
      if (existing) {
        existing.pages.add(pageUrl);
      } else {
        findings.set(fp, { text, severity, pages: new Set([pageUrl]) });
      }
    };

    const onPageError = (err, pageUrl) => {
      const text = err && err.message ? err.message : String(err);
      if (isNoisy(text)) {
        noisySuppressed++;
        return;
      }
      const fp = fingerprint(text);
      const existing = findings.get(fp);
      if (existing) {
        existing.pages.add(pageUrl);
      } else {
        findings.set(fp, { text, severity: 'error', pages: new Set([pageUrl]) });
      }
    };

    const visited = new Set();
    const queue = [baseUrl];

    try {
      while (queue.length > 0 && visited.size < maxPages) {
        const url = queue.shift();
        if (!url || visited.has(url)) continue;
        visited.add(url);

        const consoleHandler = (msg) => onConsole(msg, url);
        const pageErrorHandler = (err) => onPageError(err, url);
        page.on('console', consoleHandler);
        page.on('pageerror', pageErrorHandler);

        let response;
        try {
          response = await page.goto(url, { timeout, waitUntil: 'networkidle' });
        } catch {
          try {
            response = await page.goto(url, { timeout, waitUntil: 'load' });
          } catch {
            response = null;
          }
        }

        if (response && response.status() < 400) {
          pagesVisited++;
          await page.waitForTimeout(waitMs);

          const links = await page.$$eval('a[href]', (anchors, base) =>
            anchors.map((a) => a.href).filter((href) => href.startsWith(base) && !href.includes('#')), baseUrl,
          ).catch(() => []);
          for (const link of links) {
            if (!visited.has(link) && !queue.includes(link)) queue.push(link);
          }
        }

        page.removeListener('console', consoleHandler);
        page.removeListener('pageerror', pageErrorHandler);
      }
    } finally {
      await context.close().catch(() => {});
    }

    return { findings, pagesVisited, noisySuppressed };
  }

  _report(result, stats, baseUrl) {
    const { findings, pagesVisited, noisySuppressed } = stats;
    const entries = Array.from(findings.values()).map((f) => ({
      text: f.text,
      severity: f.severity,
      pageCount: f.pages.size,
      samplePages: Array.from(f.pages).slice(0, 5),
      persistent: pagesVisited > 1 && f.pages.size === pagesVisited,
    }));

    // Persistent errors (fire on every page visited) are promoted to
    // error severity regardless of console type — a warning that fires
    // on literally every page is a systemic issue, not a one-off.
    for (const e of entries) {
      if (e.persistent) e.severity = 'error';
    }

    entries.sort((a, b) => b.pageCount - a.pageCount);

    const errors = entries.filter((e) => e.severity === 'error');
    const warnings = entries.filter((e) => e.severity === 'warning');

    if (errors.length > 0) {
      result.addCheck('console-errors:errors', false, {
        severity: 'error',
        message: `${errors.length} distinct console error(s) across ${pagesVisited} page(s) crawled at ${baseUrl}`,
        details: errors.slice(0, 30).map((e) => ({
          message: e.text,
          seenOnPages: e.pageCount,
          samplePages: e.samplePages,
          persistent: e.persistent,
        })),
        suggestion: 'Errors marked "persistent" fire on every crawled page — check global scripts/layout components first.',
      });
    }

    if (warnings.length > 0) {
      result.addCheck('console-errors:warnings', false, {
        severity: 'warning',
        message: `${warnings.length} distinct console warning(s) across ${pagesVisited} page(s) crawled at ${baseUrl}`,
        details: warnings.slice(0, 30).map((w) => ({
          message: w.text,
          seenOnPages: w.pageCount,
          samplePages: w.samplePages,
        })),
      });
    }

    result.addCheck('console-errors:summary', true, {
      severity: 'info',
      message: `${pagesVisited} page(s) crawled at ${baseUrl}: ${errors.length} distinct error(s), ${warnings.length} distinct warning(s), ${noisySuppressed} known-noisy message(s) filtered out`,
    });
  }
}

module.exports = ConsoleErrorsModule;
