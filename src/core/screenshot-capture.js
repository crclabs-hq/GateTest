/**
 * Screenshot Capture — core helper for URL screenshots outside the module
 * runner. Lifted from src/modules/visual-regression.js so the MCP server's
 * "eyes" tools (capture_screenshot / get_visual_diff) and the module share
 * ONE implementation of Playwright resolution, route slugging, and page
 * capture. The module delegates here — behavior identical, baselines
 * untouched.
 *
 * Pure orchestration: no baseline management, no diffing (that's
 * visual-diff-engine.js), no Slack. Gracefully throws coded errors
 * (PLAYWRIGHT_MISSING / BROWSER_LAUNCH_FAILED) so callers can degrade to
 * informative text instead of transport failures.
 */

'use strict';

const path = require('path');

function slugifyRoute(route) {
  const cleaned = String(route).replace(/^\/+/, '').replace(/\/+$/, '');
  if (!cleaned) return 'index';
  return cleaned.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();
}

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

/**
 * Capture a screenshot of a live URL.
 *
 * @param {object} opts
 * @param {string} opts.url                  — target URL (required)
 * @param {{width:number,height:number}} [opts.viewport]
 * @param {boolean} [opts.fullPage=false]    — default OFF: MCP image payloads
 *                                             must stay bounded; a 7000px-tall
 *                                             full-page shot busts transports
 * @param {number}  [opts.waitMs=1000]
 * @param {string[]} [opts.maskSelectors]
 * @param {'jpeg'|'png'} [opts.format='jpeg'] — jpeg+quality keeps live captures
 *                                             small; png for diff-able output
 * @param {number}  [opts.quality=70]        — jpeg only
 * @param {object|null} [opts.playwright]    — DI seam for tests; `null`
 *                                             simulates Playwright absence,
 *                                             `undefined` resolves normally
 * @returns {Promise<{buffer: Buffer, mimeType: string, width: number, height: number}>}
 * @throws {Error & {code: 'PLAYWRIGHT_MISSING'|'BROWSER_LAUNCH_FAILED'}}
 */
async function captureUrlScreenshot(opts = {}) {
  const {
    url,
    viewport = { width: 1280, height: 900 },
    fullPage = false,
    waitMs = 1000,
    maskSelectors = [],
    format = 'jpeg',
    quality = 70,
  } = opts;

  if (!url || typeof url !== 'string') {
    throw new Error('url is required');
  }

  const pw = 'playwright' in opts ? opts.playwright : resolvePlaywright();
  if (!pw) {
    const err = new Error('Playwright not available in this environment');
    err.code = 'PLAYWRIGHT_MISSING';
    throw err;
  }

  let browser;
  try {
    browser = await pw.chromium.launch({ headless: true, timeout: 15000 });
  } catch (launchErr) {
    const err = new Error(`Browser launch failed: ${launchErr.message || launchErr}`);
    err.code = 'BROWSER_LAUNCH_FAILED';
    throw err;
  }

  try {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      userAgent: 'GateTest/1.0 (+https://gatetest.ai/bot) ScreenshotCapture',
    });
    const page = await context.newPage();
    try {
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
      } catch {
        await page.goto(url, { waitUntil: 'load', timeout: 20000 });
      }
      if (maskSelectors.length) {
        const css = maskSelectors.map((sel) => `${sel}{visibility:hidden !important;}`).join('\n');
        await page.addStyleTag({ content: css }).catch(() => {});
      }
      await page.waitForTimeout(waitMs);

      const type = format === 'png' ? 'png' : 'jpeg';
      const shotOpts = { fullPage, type };
      if (type === 'jpeg') shotOpts.quality = quality;
      const buffer = await page.screenshot(shotOpts);

      // Report the real captured dimensions: viewport for windowed shots,
      // document scroll extent for full-page.
      let width = viewport.width;
      let height = viewport.height;
      if (fullPage) {
        try {
          const dims = await page.evaluate(() => ({
            w: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),
            h: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
          }));
          width = dims.w || width;
          height = dims.h || height;
        } catch { /* dims stay viewport-approximate */ }
      }

      return {
        buffer,
        mimeType: type === 'png' ? 'image/png' : 'image/jpeg',
        width,
        height,
      };
    } finally {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = {
  resolvePlaywright,
  slugifyRoute,
  captureUrlScreenshot,
};
