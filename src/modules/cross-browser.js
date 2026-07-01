/**
 * Cross-Browser Module — runs the same page load across Chromium,
 * Firefox, and WebKit and diffs the results. Every other Playwright-
 * backed module in this spec (runtimeErrors, interactiveElements,
 * performanceBudget, ...) only ever launches Chromium — this is the
 * one module whose entire job is checking whether the OTHER two real
 * rendering engines behave the same way.
 *
 * Per engine: navigation success/status, uncaught page errors, console
 * errors, and a viewport screenshot. Chromium is the reference engine
 * (most-used, most-tested by every other module); Firefox and WebKit
 * are diffed AGAINST it:
 *
 *   - An engine that fails to load a page Chromium loads fine is an
 *     error-severity finding — a real "broken in Safari/Firefox" bug.
 *   - A page error / console error that fires in one engine but not
 *     the others is an error-severity finding — an engine-specific JS
 *     bug (a Chromium-only API used without a check, for example).
 *   - A screenshot pixel-diff against Chromium above a (deliberately
 *     generous — different engines render fonts/anti-aliasing
 *     differently even on an IDENTICAL page) threshold is a warning,
 *     not an error: it flags "go look at this," it doesn't claim the
 *     page is broken.
 *
 * Known, honest limitation: Firefox/WebKit require their own Playwright
 * browser binaries (`npx playwright install firefox webkit`) AND, on
 * Linux, OS-level shared libraries Playwright's installer does not
 * provide (gtk4, flite, libavif, ...). An engine that can't launch is
 * reported as an info-level skip for THAT ENGINE ONLY — never a
 * blocking error, and never silently treated as "browser behaves fine."
 * This mirrors the graceful-skip pattern every sibling module already
 * uses when Chromium itself isn't available.
 *
 * Second known, honest limitation, found during this module's own
 * real-repo proof against vapron.ai: "engine-specific error" comparison
 * is exact-text matching between engines, not fingerprint-normalized
 * (unlike `consoleErrors`' cross-PAGE dedup within a single engine).
 * Different browser vendors format the SAME underlying error in
 * completely different templates — Chromium's CSP violation message
 * and Firefox's CSP violation message for the identical blocked
 * stylesheet share no common substring — so no cheap text
 * normalization can safely unify them without risking false negatives
 * (silently treating two genuinely different bugs as "the same").
 * `engine-specific-errors` findings should be read as "this engine
 * reported something the reference engine didn't," which sometimes
 * means a real engine-only bug and sometimes means the same underlying
 * issue phrased differently — a human (or `consoleErrors`, which
 * already caught this exact CSP bug independently, single-engine, in
 * its own real-repo proof) should confirm which.
 *
 * Requires: Playwright (already an approved GateTest dependency) +
 * the pure-JS pixelmatch/pngjs diff engine already used by
 * `visualRegression` (reused via `core/visual-diff-engine.js`, not
 * duplicated).
 */

'use strict';

const path = require('path');
const BaseModule = require('./base-module');
const { compareScreenshots } = require('../core/visual-diff-engine');

const ENGINES = ['chromium', 'firefox', 'webkit'];
const REFERENCE_ENGINE = 'chromium';
const DEFAULT_DIFF_THRESHOLD_PERCENT = 25; // generous — cross-engine font/AA differences are expected
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

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

class CrossBrowserModule extends BaseModule {
  constructor() {
    super('crossBrowser', 'Cross-Browser — diffs page load, runtime errors, and rendering across Chromium/Firefox/WebKit');
  }

  async run(result, config) {
    const moduleCfg = config.getModuleConfig('crossBrowser') || {};
    const baseUrl =
      process.env.GATETEST_CROSS_BROWSER_URL ||
      moduleCfg.url ||
      config.get('explorer.url') ||
      config.get('liveCrawler.url') ||
      config.get('webUrl') ||
      config.get('wpUrl') ||
      config.get('targetUrl');

    if (!baseUrl) {
      result.addCheck('cross-browser:config', true, {
        severity: 'info',
        message: 'No target URL configured — set GATETEST_CROSS_BROWSER_URL or modules.crossBrowser.url in .gatetest/config.json',
      });
      return;
    }

    const playwright = resolvePlaywright();
    if (!playwright) {
      result.addCheck('cross-browser:playwright-missing', true, {
        severity: 'info',
        message: 'Playwright not available in this environment — cross-browser checks skipped.',
        suggestion: 'npm install playwright && npx playwright install chromium firefox webkit',
      });
      return;
    }

    const engineResults = {};
    for (const engine of ENGINES) {
      engineResults[engine] = await this._captureEngine(playwright, engine, baseUrl, moduleCfg);
    }

    this._report(result, engineResults, baseUrl, moduleCfg);
  }

  async _captureEngine(playwright, engine, url, moduleCfg) {
    const timeout = moduleCfg.timeout || 20000;
    let browser;
    try {
      browser = await playwright[engine].launch({ headless: true, timeout: 15000 });
    } catch (err) {
      return { launched: false, skipReason: err && err.message ? err.message.split('\n')[0] : String(err) };
    }

    try {
      const context = await browser.newContext({
        viewport: DEFAULT_VIEWPORT,
        userAgent: `GateTest/1.0 (+https://gatetest.ai/bot) CrossBrowser/${engine}`,
      });
      const page = await context.newPage();

      const pageErrors = [];
      const consoleErrors = [];
      page.on('pageerror', (err) => pageErrors.push(err && err.message ? err.message : String(err)));
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });

      let status = null;
      let navigationFailure = null;
      try {
        const resp = await page.goto(url, { timeout, waitUntil: 'networkidle' });
        status = resp ? resp.status() : null;
      } catch (err) {
        navigationFailure = err && err.message ? err.message : String(err);
      }

      let screenshotBuffer = null;
      if (!navigationFailure) {
        try {
          screenshotBuffer = await page.screenshot({ fullPage: false });
        } catch {
          screenshotBuffer = null;
        }
      }

      await context.close().catch(() => {});
      return { launched: true, navigationFailure, status, pageErrors, consoleErrors, screenshotBuffer };
    } finally {
      await browser.close().catch(() => {});
    }
  }

  _report(result, engineResults, baseUrl, moduleCfg) {
    const threshold = typeof moduleCfg.diffThresholdPercent === 'number' ? moduleCfg.diffThresholdPercent : DEFAULT_DIFF_THRESHOLD_PERCENT;

    const skipped = ENGINES.filter((e) => !engineResults[e].launched);
    if (skipped.length > 0) {
      result.addCheck('cross-browser:engines-skipped', true, {
        severity: 'info',
        message: `${skipped.length} engine(s) could not be launched and were skipped: ${skipped.map((e) => `${e} (${engineResults[e].skipReason})`).join('; ')}`,
        suggestion: 'Install missing browser binaries/host dependencies to enable full cross-browser coverage: npx playwright install-deps && npx playwright install firefox webkit',
      });
    }

    const launched = ENGINES.filter((e) => engineResults[e].launched);
    if (launched.length === 0) {
      result.addCheck('cross-browser:no-engines', true, {
        severity: 'info',
        message: 'No browser engine could be launched — cross-browser comparison skipped entirely.',
      });
      return;
    }

    const reference = engineResults[REFERENCE_ENGINE];
    if (!reference.launched) {
      result.addCheck('cross-browser:no-reference', true, {
        severity: 'info',
        message: `Reference engine (${REFERENCE_ENGINE}) could not be launched — comparison requires it.`,
      });
      return;
    }

    // Navigation-failure diffs: an engine that fails where Chromium succeeded.
    const brokenEngines = launched.filter((e) => e !== REFERENCE_ENGINE && !reference.navigationFailure && engineResults[e].navigationFailure);
    if (brokenEngines.length > 0) {
      result.addCheck('cross-browser:navigation-broken', false, {
        severity: 'error',
        message: `${baseUrl} fails to load in ${brokenEngines.join(', ')} but loads fine in ${REFERENCE_ENGINE}`,
        details: brokenEngines.map((e) => ({ engine: e, error: engineResults[e].navigationFailure })),
      });
    }

    // Engine-specific runtime errors: fired in one engine, not in Chromium.
    const engineSpecificErrors = [];
    for (const engine of launched) {
      if (engine === REFERENCE_ENGINE) continue;
      const er = engineResults[engine];
      if (er.navigationFailure) continue;
      const referenceMessages = new Set([...(reference.pageErrors || []), ...(reference.consoleErrors || [])]);
      const unique = [...(er.pageErrors || []), ...(er.consoleErrors || [])].filter((msg) => !referenceMessages.has(msg));
      if (unique.length > 0) {
        engineSpecificErrors.push({ engine, errors: unique.slice(0, 10) });
      }
    }
    if (engineSpecificErrors.length > 0) {
      result.addCheck('cross-browser:engine-specific-errors', false, {
        severity: 'error',
        message: `Runtime/console errors unique to a non-reference engine (not seen in ${REFERENCE_ENGINE}) at ${baseUrl}`,
        details: engineSpecificErrors,
        suggestion: 'Check for engine-specific APIs (Chromium-only features used without a feature check) or CSS the other engine parses differently.',
      });
    }

    // Rendering diffs: pixel-diff each non-reference engine's screenshot vs Chromium's.
    const renderDiffs = [];
    for (const engine of launched) {
      if (engine === REFERENCE_ENGINE) continue;
      const er = engineResults[engine];
      if (!er.screenshotBuffer || !reference.screenshotBuffer) continue;
      let diff;
      try {
        diff = compareScreenshots(reference.screenshotBuffer, er.screenshotBuffer);
      } catch {
        continue;
      }
      if (diff.diffPercent > threshold) {
        renderDiffs.push({ engine, diffPercent: Number(diff.diffPercent.toFixed(2)), dimensionMismatch: diff.dimensionMismatch });
      }
    }
    if (renderDiffs.length > 0) {
      result.addCheck('cross-browser:rendering-diff', false, {
        severity: 'warning',
        message: `${renderDiffs.length} engine(s) render ${baseUrl} visibly differently from ${REFERENCE_ENGINE} (above ${threshold}% pixel diff)`,
        details: renderDiffs,
        suggestion: 'Some diff between engines is expected (font rendering/anti-aliasing) — review the flagged engine(s) for actual layout breakage, not just visual noise.',
      });
    }

    result.addCheck('cross-browser:summary', true, {
      severity: 'info',
      message: `${baseUrl}: ${launched.length}/${ENGINES.length} engine(s) tested (${launched.join(', ')}), ${brokenEngines.length} navigation break(s), ${engineSpecificErrors.length} engine-specific error set(s), ${renderDiffs.length} rendering diff(s) above threshold`,
    });
  }
}

module.exports = CrossBrowserModule;
