/**
 * Mobile Rendering Module — layout/readability checks across 5 device
 * widths (390 iPhone / 414 Android / 768 tablet / 1024 small-laptop /
 * 1280 desktop). Absolute checks, not diffs — this catches "the layout
 * is currently broken at this width," where `visualRegression` only
 * catches "the layout CHANGED since the last baseline."
 *
 * `explorer` already does a lighter version of this (horizontal-overflow
 * + clipped-text) but only at 2 viewports (desktop/mobile) as one signal
 * among many in its full autonomous-exploration pass. This module is the
 * focused, spec-named counterpart: the full 5-viewport matrix, plus a
 * check `explorer` doesn't do — unreadably small text (computed
 * font-size below a legibility floor).
 *
 * Per the spec's own stated limitations:
 *   - Some admin/internal pages are intentionally desktop-only —
 *     `moduleCfg.exemptRoutes` (or a matching glob) skips the
 *     narrow-viewport checks for those routes entirely.
 *
 * Requires: Playwright (already an approved GateTest dependency). Skips
 * gracefully when Chromium isn't available, same as its siblings.
 */

'use strict';

const path = require('path');
const BaseModule = require('./base-module');

const DEFAULT_VIEWPORTS = [
  { name: 'iphone', width: 390, height: 844 },
  { name: 'android', width: 414, height: 896 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'laptop', width: 1024, height: 768 },
  { name: 'desktop', width: 1280, height: 900 },
];

const NARROW_VIEWPORT_NAMES = new Set(['iphone', 'android', 'tablet']);
const DEFAULT_MIN_FONT_PX = 10;
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

function isExempt(route, exemptRoutes) {
  if (!Array.isArray(exemptRoutes)) return false;
  return exemptRoutes.some((pattern) => {
    if (pattern instanceof RegExp) return pattern.test(route);
    return route === pattern || route.startsWith(pattern);
  });
}

class MobileRenderingModule extends BaseModule {
  constructor() {
    super('mobileRendering', 'Mobile Rendering — overflow + readability checks across 5 device widths');
  }

  async run(result, config) {
    const moduleCfg = config.getModuleConfig('mobileRendering') || {};
    const baseUrl =
      process.env.GATETEST_MOBILE_URL ||
      moduleCfg.url ||
      config.get('explorer.url') ||
      config.get('liveCrawler.url') ||
      config.get('webUrl') ||
      config.get('wpUrl') ||
      config.get('targetUrl');

    if (!baseUrl) {
      result.addCheck('mobile-rendering:config', true, {
        severity: 'info',
        message: 'No target URL configured — set GATETEST_MOBILE_URL or modules.mobileRendering.url in .gatetest/config.json',
      });
      return;
    }

    const playwright = resolvePlaywright();
    if (!playwright) {
      result.addCheck('mobile-rendering:playwright-missing', true, {
        severity: 'info',
        message: 'Playwright not available in this environment — mobile rendering checks skipped.',
        suggestion: 'npm install playwright && npx playwright install chromium',
      });
      return;
    }

    const routes = Array.isArray(moduleCfg.routes) && moduleCfg.routes.length ? moduleCfg.routes : ['/'];
    const viewports = Array.isArray(moduleCfg.viewports) && moduleCfg.viewports.length ? moduleCfg.viewports : DEFAULT_VIEWPORTS;
    const exemptRoutes = moduleCfg.exemptRoutes || [];
    const minFontPx = typeof moduleCfg.minFontPx === 'number' ? moduleCfg.minFontPx : DEFAULT_MIN_FONT_PX;
    const waitMs = typeof moduleCfg.waitMs === 'number' ? moduleCfg.waitMs : DEFAULT_WAIT_MS;
    const timeout = moduleCfg.timeout || 20000;

    let browser;
    try {
      browser = await playwright.chromium.launch({ headless: true, timeout: 15000 });
    } catch (err) {
      result.addCheck('mobile-rendering:browser-launch', true, {
        severity: 'info',
        message: `Browser launch failed (${err.message || err}) — environment likely lacks chromium binaries.`,
      });
      return;
    }

    const stats = { overflow: [], tinyText: [], exempted: [], pageErrors: [], pagesChecked: 0 };

    try {
      for (const route of routes) {
        if (isExempt(route, exemptRoutes)) {
          stats.exempted.push(route);
          continue;
        }
        for (const viewport of viewports) {
          await this._checkOne({ browser, baseUrl, route, viewport, minFontPx, waitMs, timeout, stats });
        }
      }
    } finally {
      try {
        await browser.close();
      } catch {
        /* swallow close errors */
      }
    }

    this._report(result, stats, baseUrl);
  }

  async _checkOne({ browser, baseUrl, route, viewport, minFontPx, waitMs, timeout, stats }) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      userAgent: 'GateTest/1.0 (+https://gatetest.ai/bot) MobileRendering',
    });
    const page = await context.newPage();

    try {
      const url = new URL(route, baseUrl).toString();
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout });
      } catch {
        await page.goto(url, { waitUntil: 'load', timeout });
      }
      await page.waitForTimeout(waitMs);
      stats.pagesChecked++;

      const findings = await page.evaluate((minFont) => {
        const out = { hasOverflow: false, overflowPx: 0, tinyTextSamples: [] };
        out.hasOverflow = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
        out.overflowPx = Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth);

        const seen = new Set();
        document.querySelectorAll('body *').forEach((el) => {
          if (out.tinyTextSamples.length >= 5) return;
          const text = el.textContent ? el.textContent.trim() : '';
          if (text.length < 3) return;
          // Only count elements whose OWN direct text matters (skip pure
          // containers whose visible text actually belongs to a child).
          const hasDirectText = Array.from(el.childNodes).some(
            (n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim().length >= 3,
          );
          if (!hasDirectText) return;
          const style = window.getComputedStyle(el);
          const fontSize = parseFloat(style.fontSize);
          if (Number.isNaN(fontSize) || fontSize >= minFont) return;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return;
          const key = `${el.tagName}:${text.slice(0, 30)}`;
          if (seen.has(key)) return;
          seen.add(key);
          out.tinyTextSamples.push({ tag: el.tagName.toLowerCase(), fontSizePx: fontSize, text: text.slice(0, 40) });
        });

        return out;
      }, minFontPx);

      if (findings.hasOverflow) {
        stats.overflow.push({ route, viewport: viewport.name, width: viewport.width, overflowPx: findings.overflowPx });
      }
      if (findings.tinyTextSamples.length > 0) {
        stats.tinyText.push({ route, viewport: viewport.name, width: viewport.width, samples: findings.tinyTextSamples });
      }
    } catch (err) {
      stats.pageErrors.push({ route, viewport: viewport.name, width: viewport.width, error: err.message || String(err) });
    } finally {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  }

  _report(result, stats, baseUrl) {
    const narrowOverflow = stats.overflow.filter((o) => NARROW_VIEWPORT_NAMES.has(o.viewport));

    if (stats.overflow.length > 0) {
      result.addCheck('mobile-rendering:overflow', false, {
        severity: narrowOverflow.length > 0 ? 'error' : 'warning',
        message: `${stats.overflow.length} page/viewport combination(s) have horizontal overflow${narrowOverflow.length > 0 ? ` (${narrowOverflow.length} on phone/tablet widths)` : ''}`,
        details: stats.overflow.slice(0, 30),
        suggestion: 'Fix the CSS causing content wider than the viewport (fixed widths, unwrapped tables, unconstrained images)',
      });
    } else {
      result.addCheck('mobile-rendering:overflow', true, {
        severity: 'info',
        message: `${stats.pagesChecked} page/viewport combination(s) checked — no horizontal overflow`,
      });
    }

    if (stats.tinyText.length > 0) {
      result.addCheck('mobile-rendering:tiny-text', false, {
        severity: 'warning',
        message: `${stats.tinyText.length} page/viewport combination(s) have text below the legibility floor`,
        details: stats.tinyText.slice(0, 30),
        suggestion: 'Increase font-size for body text at narrow viewports — WCAG 1.4.4 recommends a legible minimum',
      });
    }

    if (stats.pageErrors.length > 0) {
      result.addCheck('mobile-rendering:page-errors', false, {
        severity: 'warning',
        message: `${stats.pageErrors.length} page/viewport combination(s) failed to load`,
        details: stats.pageErrors.slice(0, 30),
      });
    }

    if (stats.exempted.length > 0) {
      result.addCheck('mobile-rendering:exempted', true, {
        severity: 'info',
        message: `${stats.exempted.length} route(s) exempted from mobile checks (modules.mobileRendering.exemptRoutes)`,
        details: stats.exempted,
      });
    }

    result.addCheck('mobile-rendering:summary', true, {
      severity: 'info',
      message: `${stats.pagesChecked} page/viewport combination(s) checked at ${baseUrl}: ${stats.overflow.length} overflow, ${stats.tinyText.length} tiny-text, ${stats.pageErrors.length} load-error, ${stats.exempted.length} exempted`,
    });
  }
}

module.exports = MobileRenderingModule;
// Exposed for unit tests
module.exports.isExempt = isExempt;
module.exports.DEFAULT_VIEWPORTS = DEFAULT_VIEWPORTS;
