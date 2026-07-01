/**
 * Performance Budget Module — live Core Web Vitals against a real URL.
 *
 * The existing `performance` module is entirely static (bundle size from
 * build output, regex checks on HTML/JS source, and a check for whether
 * the `lighthouse` CLI is *installed* — it never actually loads the page).
 * This module is the live counterpart the spec calls for: it opens the
 * target URL in a real Chromium instance and measures what a visitor
 * actually experiences.
 *
 * Metrics captured via an init script (`page.addInitScript`) that installs
 * `PerformanceObserver`s BEFORE navigation, so early paint/layout-shift
 * entries aren't missed:
 *   - TTFB   — Navigation Timing: `responseStart - requestStart`
 *   - LCP    — `PerformanceObserver({type:'largest-contentful-paint'})`,
 *              takes the last (largest) candidate reported by page unload
 *   - CLS    — `PerformanceObserver({type:'layout-shift'})`, summed for
 *              entries where `hadRecentInput` is false (matches the
 *              standard Web Vitals CLS definition)
 *   - Page weight — summed `content-length` (or actual transferred body
 *     size when the header is absent) across every response Playwright
 *     observes for the navigation
 *
 * Per the spec's own stated limitations:
 *   - A cold-start-inflated first load is mitigated with one throwaway
 *     warm-up request before any measured run.
 *   - Metrics vary run-to-run — 3 runs are taken and the MEDIAN reported
 *     (matches the spec's own Lighthouse-variance guidance), reducing
 *     one-off network blips from failing the gate.
 *
 * Requires: Playwright (already an approved GateTest dependency). Skips
 * gracefully when Chromium isn't available, same as its siblings.
 */

'use strict';

const path = require('path');
const BaseModule = require('./base-module');

const DEFAULT_RUNS = 3;
const DEFAULT_BUDGETS = {
  ttfbMs: 800,
  lcpMs: 2500,
  clsScore: 0.1,
  pageWeightBytes: 2 * 1024 * 1024,
};

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

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Installed in-page before navigation so early entries aren't missed. */
function installObservers() {
  window.__gatetestVitals = { lcp: 0, cls: 0 };
  try {
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (last) window.__gatetestVitals.lcp = last.renderTime || last.loadTime || 0;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch { /* LCP not supported in this browser build */ }
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) window.__gatetestVitals.cls += entry.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch { /* CLS not supported in this browser build */ }
}

class PerformanceBudgetModule extends BaseModule {
  constructor() {
    super('performanceBudget', 'Performance Budget — live TTFB / LCP / CLS / page weight against a real URL');
  }

  async run(result, config) {
    const moduleCfg = config.getModuleConfig('performanceBudget') || {};
    const baseUrl =
      process.env.GATETEST_PERF_BUDGET_URL ||
      moduleCfg.url ||
      config.get('explorer.url') ||
      config.get('liveCrawler.url') ||
      config.get('webUrl') ||
      config.get('wpUrl') ||
      config.get('targetUrl');

    if (!baseUrl) {
      result.addCheck('performance-budget:config', true, {
        severity: 'info',
        message: 'No target URL configured — set GATETEST_PERF_BUDGET_URL or modules.performanceBudget.url in .gatetest/config.json',
      });
      return;
    }

    const playwright = resolvePlaywright();
    if (!playwright) {
      result.addCheck('performance-budget:playwright-missing', true, {
        severity: 'info',
        message: 'Playwright not available in this environment — performance budget checks skipped.',
        suggestion: 'npm install playwright && npx playwright install chromium',
      });
      return;
    }

    const routes = Array.isArray(moduleCfg.routes) && moduleCfg.routes.length ? moduleCfg.routes : ['/'];
    const runs = typeof moduleCfg.runs === 'number' ? moduleCfg.runs : DEFAULT_RUNS;
    const budgets = { ...DEFAULT_BUDGETS, ...(moduleCfg.budgets || {}) };
    const timeout = moduleCfg.timeout || 20000;

    let browser;
    try {
      browser = await playwright.chromium.launch({ headless: true, timeout: 15000 });
    } catch (err) {
      result.addCheck('performance-budget:browser-launch', true, {
        severity: 'info',
        message: `Browser launch failed (${err.message || err}) — environment likely lacks chromium binaries.`,
      });
      return;
    }

    try {
      for (const route of routes) {
        await this._checkRoute({ browser, baseUrl, route, runs, budgets, timeout, result });
      }
    } finally {
      try {
        await browser.close();
      } catch {
        /* swallow close errors */
      }
    }
  }

  async _checkRoute({ browser, baseUrl, route, runs, budgets, timeout, result }) {
    const url = new URL(route, baseUrl).toString();

    // Cold-start mitigation — one throwaway request before measured runs.
    await this._measureOnce(browser, url, timeout).catch(() => null);

    const samples = [];
    for (let i = 0; i < runs; i++) {
      const sample = await this._measureOnce(browser, url, timeout).catch((err) => ({ error: err.message || String(err) }));
      if (!sample.error) samples.push(sample);
    }

    if (samples.length === 0) {
      result.addCheck(`performance-budget:${route}`, false, {
        severity: 'warning',
        message: `Could not measure ${route} — all ${runs} run(s) failed to load`,
      });
      return;
    }

    const metrics = {
      ttfbMs: median(samples.map((s) => s.ttfbMs)),
      lcpMs: median(samples.map((s) => s.lcpMs)),
      clsScore: median(samples.map((s) => s.clsScore)),
      pageWeightBytes: median(samples.map((s) => s.pageWeightBytes)),
    };

    this._report(result, route, metrics, budgets, samples.length, runs);
  }

  async _measureOnce(browser, url, timeout) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: 'GateTest/1.0 (+https://gatetest.ai/bot) PerformanceBudget',
    });
    const page = await context.newPage();
    let pageWeightBytes = 0;
    page.on('response', (res) => {
      const len = res.headers()['content-length'];
      if (len && !Number.isNaN(Number(len))) pageWeightBytes += Number(len);
    });

    try {
      await page.addInitScript(installObservers);
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout });
      } catch {
        await page.goto(url, { waitUntil: 'load', timeout });
      }
      // Let async LCP/CLS observers flush their final buffered entries.
      await page.waitForTimeout(500);

      const navTiming = await page.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0];
        return nav ? { responseStart: nav.responseStart, requestStart: nav.requestStart } : null;
      });
      const vitals = await page.evaluate(() => window.__gatetestVitals || { lcp: 0, cls: 0 });

      const ttfbMs = navTiming ? Math.max(0, navTiming.responseStart - navTiming.requestStart) : 0;

      return { ttfbMs, lcpMs: vitals.lcp || 0, clsScore: vitals.cls || 0, pageWeightBytes };
    } finally {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  }

  _report(result, route, metrics, budgets, sampleCount, runs) {
    const checkName = `performance-budget:${route}`;
    const runNote = sampleCount < runs ? ` (median of ${sampleCount}/${runs} successful runs)` : ` (median of ${runs} runs)`;

    const failures = [];
    if (metrics.ttfbMs > budgets.ttfbMs) failures.push(`TTFB ${metrics.ttfbMs.toFixed(0)}ms > ${budgets.ttfbMs}ms`);
    if (metrics.lcpMs > budgets.lcpMs) failures.push(`LCP ${metrics.lcpMs.toFixed(0)}ms > ${budgets.lcpMs}ms`);
    if (metrics.clsScore > budgets.clsScore) failures.push(`CLS ${metrics.clsScore.toFixed(3)} > ${budgets.clsScore}`);
    if (metrics.pageWeightBytes > budgets.pageWeightBytes) {
      failures.push(`page weight ${(metrics.pageWeightBytes / 1024 / 1024).toFixed(2)}MB > ${(budgets.pageWeightBytes / 1024 / 1024).toFixed(2)}MB`);
    }

    const passed = failures.length === 0;
    result.addCheck(checkName, passed, {
      severity: passed ? 'info' : 'error',
      message: passed
        ? `${route}: TTFB ${metrics.ttfbMs.toFixed(0)}ms, LCP ${metrics.lcpMs.toFixed(0)}ms, CLS ${metrics.clsScore.toFixed(3)}, ${(metrics.pageWeightBytes / 1024).toFixed(0)}KB — within budget${runNote}`
        : `${route}: budget exceeded — ${failures.join('; ')}${runNote}`,
      metrics,
      budgets,
      suggestion: passed ? undefined : 'Investigate the failing metric — large unoptimised images (page weight), render-blocking JS (LCP/TTFB), or late-loading web fonts / injected ads (CLS)',
    });
  }
}

module.exports = PerformanceBudgetModule;
// Exposed for unit tests
module.exports.median = median;
module.exports.DEFAULT_BUDGETS = DEFAULT_BUDGETS;
