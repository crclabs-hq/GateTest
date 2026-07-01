/**
 * Design System Compliance Module — audits a LIVE rendered page for the
 * kind of drift that erodes a design system over time: near-duplicate
 * colors that should be one token, font sizes that don't sit on a type
 * scale, spacing values that don't sit on a grid, and border-radius
 * values that have multiplied past what any real design system
 * intentionally ships.
 *
 * This is deliberately NOT a "does this page match Figma" pixel check
 * (that's `visualRegression`'s job) and NOT a static source-code lint
 * (no CSS/Tailwind config parsing) — it reads the ACTUAL computed
 * styles Chromium renders, so it catches drift regardless of whether
 * it originated in a stylesheet, inline style, a CSS-in-JS library, or
 * a third-party widget the team doesn't control the source of.
 *
 * Findings are about CONSISTENCY, not aesthetics: this module has no
 * opinion on whether a site should use 8 colors or 20, only on whether
 * near-identical values that were probably meant to be the same token
 * have drifted apart (`#1a1a1a` vs `#1c1c1c` vs `#191919` all showing
 * up as "the app's dark background" is a design-system bug even though
 * no single instance looks wrong in isolation).
 *
 * Requires: Playwright (already an approved GateTest dependency). Skips
 * gracefully when Chromium isn't available, same as its siblings.
 */

'use strict';

const path = require('path');
const BaseModule = require('./base-module');

const DEFAULT_MAX_PAGES = 5;
const DEFAULT_MAX_ELEMENTS_PER_PAGE = 1500;
const DEFAULT_BASE_SPACING_UNIT = 4;
const DEFAULT_MAX_RECOMMENDED_COLORS = 20;
const DEFAULT_MAX_RECOMMENDED_FONT_SIZES = 10;
const DEFAULT_MAX_RECOMMENDED_FONT_FAMILIES = 3;
const DEFAULT_MAX_RECOMMENDED_RADII = 6;
// Colors within this Euclidean RGB distance of each other are flagged as
// likely-unintentional near-duplicates (should be one token). Chosen to
// catch "off by a shade" drift without flagging genuinely distinct hues
// that happen to share a channel value.
const COLOR_DUPLICATE_DISTANCE = 10;

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

function parseRgb(value) {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(String(value || '').trim());
  if (!m) return null;
  const alpha = m[4] === undefined ? 1 : parseFloat(m[4]);
  if (alpha === 0) return null; // fully transparent — not a real color choice
  return { r: parseInt(m[1], 10), g: parseInt(m[2], 10), b: parseInt(m[3], 10) };
}

function colorDistance(a, b) {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

function parsePx(value) {
  const m = /^(-?[\d.]+)px$/.exec(String(value || '').trim());
  return m ? parseFloat(m[1]) : null;
}

class DesignSystemComplianceModule extends BaseModule {
  constructor() {
    super('designSystemCompliance', 'Design System Compliance — flags color/spacing/typography drift on the live rendered page');
  }

  async run(result, config) {
    const moduleCfg = config.getModuleConfig('designSystemCompliance') || {};
    const baseUrl =
      process.env.GATETEST_DESIGN_COMPLIANCE_URL ||
      moduleCfg.url ||
      config.get('explorer.url') ||
      config.get('liveCrawler.url') ||
      config.get('webUrl') ||
      config.get('wpUrl') ||
      config.get('targetUrl');

    if (!baseUrl) {
      result.addCheck('design-system-compliance:config', true, {
        severity: 'info',
        message: 'No target URL configured — set GATETEST_DESIGN_COMPLIANCE_URL or modules.designSystemCompliance.url in .gatetest/config.json',
      });
      return;
    }

    const playwright = resolvePlaywright();
    if (!playwright) {
      result.addCheck('design-system-compliance:playwright-missing', true, {
        severity: 'info',
        message: 'Playwright not available in this environment — design-system-compliance checks skipped.',
        suggestion: 'npm install playwright && npx playwright install chromium',
      });
      return;
    }

    let browser;
    try {
      browser = await playwright.chromium.launch({ headless: true, timeout: 15000 });
    } catch (err) {
      result.addCheck('design-system-compliance:browser-launch', true, {
        severity: 'info',
        message: `Browser launch failed (${err.message || err}) — environment likely lacks chromium binaries.`,
      });
      return;
    }

    try {
      const stats = await this._crawl(browser, baseUrl, moduleCfg);
      this._report(result, stats, baseUrl, moduleCfg);
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
    const maxElementsPerPage = moduleCfg.maxElementsPerPage || DEFAULT_MAX_ELEMENTS_PER_PAGE;
    const timeout = moduleCfg.timeout || 20000;

    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: 'GateTest/1.0 (+https://gatetest.ai/bot) DesignSystemCompliance',
    });
    const page = await context.newPage();
    const visited = new Set();
    const queue = [baseUrl];

    const colors = new Map(); // rgbString -> count
    const fontSizes = new Map();
    const fontFamilies = new Map();
    const radii = new Map();
    const spacingValues = new Map();
    let pagesVisited = 0;

    try {
      while (queue.length > 0 && visited.size < maxPages) {
        const url = queue.shift();
        if (!url || visited.has(url)) continue;
        visited.add(url);

        let response;
        try {
          response = await page.goto(url, { timeout, waitUntil: 'networkidle' });
        } catch {
          try {
            response = await page.goto(url, { timeout, waitUntil: 'load' });
          } catch {
            continue;
          }
        }
        if (!response || response.status() >= 400) continue;
        pagesVisited++;

        const links = await page.$$eval('a[href]', (anchors, base) =>
          anchors.map((a) => a.href).filter((href) => href.startsWith(base) && !href.includes('#')), baseUrl,
        ).catch(() => []);
        for (const link of links) {
          if (!visited.has(link) && !queue.includes(link)) queue.push(link);
        }

        const styles = await this._collectStyles(page, maxElementsPerPage);
        this._merge(colors, styles.colors);
        this._merge(fontSizes, styles.fontSizes);
        this._merge(fontFamilies, styles.fontFamilies);
        this._merge(radii, styles.radii);
        this._merge(spacingValues, styles.spacingValues);
      }
    } finally {
      await context.close().catch(() => {});
    }

    return { colors, fontSizes, fontFamilies, radii, spacingValues, pagesVisited };
  }

  _merge(target, source) {
    for (const [key, count] of Object.entries(source)) {
      target.set(key, (target.get(key) || 0) + count);
    }
  }

  async _collectStyles(page, maxElements) {
    return page.evaluate((cap) => {
      const colors = {};
      const fontSizes = {};
      const fontFamilies = {};
      const radii = {};
      const spacingValues = {};

      const bump = (map, key) => {
        if (!key) return;
        map[key] = (map[key] || 0) + 1;
      };

      const els = Array.from(document.querySelectorAll('*')).slice(0, cap);
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const cs = window.getComputedStyle(el);

        bump(colors, cs.color);
        bump(colors, cs.backgroundColor);
        bump(fontSizes, cs.fontSize);
        bump(fontFamilies, (cs.fontFamily || '').split(',')[0].trim());
        bump(radii, cs.borderTopLeftRadius);

        for (const prop of ['marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight']) {
          bump(spacingValues, cs[prop]);
        }
      }

      return { colors, fontSizes, fontFamilies, radii, spacingValues };
    }, maxElements);
  }

  _findColorDuplicateClusters(colors) {
    const parsed = Array.from(colors.entries())
      .map(([key, count]) => ({ key, count, rgb: parseRgb(key) }))
      .filter((c) => c.rgb);

    const clusters = [];
    const used = new Set();
    for (let i = 0; i < parsed.length; i++) {
      if (used.has(parsed[i].key)) continue;
      const cluster = [parsed[i]];
      for (let j = i + 1; j < parsed.length; j++) {
        if (used.has(parsed[j].key)) continue;
        if (colorDistance(parsed[i].rgb, parsed[j].rgb) <= COLOR_DUPLICATE_DISTANCE) {
          cluster.push(parsed[j]);
          used.add(parsed[j].key);
        }
      }
      if (cluster.length > 1) {
        used.add(parsed[i].key);
        clusters.push(cluster.map((c) => ({ color: c.key, count: c.count })));
      }
    }
    return clusters;
  }

  _findOffGridSpacing(spacingValues, baseUnit) {
    const offenders = [];
    for (const [value, count] of spacingValues.entries()) {
      const px = parsePx(value);
      if (px === null || px === 0) continue;
      if (px % baseUnit !== 0) {
        offenders.push({ value, count });
      }
    }
    return offenders.sort((a, b) => b.count - a.count);
  }

  _report(result, stats, baseUrl, moduleCfg) {
    const baseUnit = typeof moduleCfg.baseSpacingUnit === 'number' ? moduleCfg.baseSpacingUnit : DEFAULT_BASE_SPACING_UNIT;
    const maxColors = moduleCfg.maxRecommendedColors || DEFAULT_MAX_RECOMMENDED_COLORS;
    const maxFontSizes = moduleCfg.maxRecommendedFontSizes || DEFAULT_MAX_RECOMMENDED_FONT_SIZES;
    const maxFontFamilies = moduleCfg.maxRecommendedFontFamilies || DEFAULT_MAX_RECOMMENDED_FONT_FAMILIES;
    const maxRadii = moduleCfg.maxRecommendedRadii || DEFAULT_MAX_RECOMMENDED_RADII;

    if (stats.pagesVisited === 0) {
      result.addCheck('design-system-compliance:no-pages', true, {
        severity: 'info',
        message: `No pages could be crawled at ${baseUrl}`,
      });
      return;
    }

    const colorClusters = this._findColorDuplicateClusters(stats.colors);
    if (colorClusters.length > 0) {
      result.addCheck('design-system-compliance:near-duplicate-colors', false, {
        severity: 'warning',
        message: `${colorClusters.length} group(s) of near-duplicate colors found across ${stats.pagesVisited} page(s) — likely meant to be a single design token`,
        details: colorClusters.slice(0, 20),
        suggestion: 'Consolidate each cluster into one CSS variable / design token.',
      });
    }

    if (stats.colors.size > maxColors) {
      result.addCheck('design-system-compliance:color-count', false, {
        severity: 'warning',
        message: `${stats.colors.size} distinct color values in use across ${stats.pagesVisited} page(s), above the recommended ${maxColors}`,
        suggestion: 'A large, growing color palette usually means colors are being hand-picked per-component instead of drawn from a shared token set.',
      });
    }

    if (stats.fontSizes.size > maxFontSizes) {
      result.addCheck('design-system-compliance:font-size-count', false, {
        severity: 'warning',
        message: `${stats.fontSizes.size} distinct font-size values in use across ${stats.pagesVisited} page(s), above the recommended ${maxFontSizes} — sizes may not be drawn from a type scale`,
        details: Array.from(stats.fontSizes.keys()).sort(),
      });
    }

    if (stats.fontFamilies.size > maxFontFamilies) {
      result.addCheck('design-system-compliance:font-family-count', false, {
        severity: 'warning',
        message: `${stats.fontFamilies.size} distinct font-family values in use across ${stats.pagesVisited} page(s), above the recommended ${maxFontFamilies}`,
        details: Array.from(stats.fontFamilies.keys()),
      });
    }

    if (stats.radii.size > maxRadii) {
      result.addCheck('design-system-compliance:border-radius-count', false, {
        severity: 'info',
        message: `${stats.radii.size} distinct border-radius values in use across ${stats.pagesVisited} page(s), above the recommended ${maxRadii}`,
        details: Array.from(stats.radii.keys()).sort(),
      });
    }

    const offGrid = this._findOffGridSpacing(stats.spacingValues, baseUnit);
    if (offGrid.length > 0) {
      result.addCheck('design-system-compliance:off-grid-spacing', false, {
        severity: 'info',
        message: `${offGrid.length} distinct margin/padding value(s) across ${stats.pagesVisited} page(s) are not multiples of the ${baseUnit}px spacing unit`,
        details: offGrid.slice(0, 30),
        suggestion: `Snap spacing values to the ${baseUnit}px grid, or configure modules.designSystemCompliance.baseSpacingUnit if this site intentionally uses a different unit.`,
      });
    }

    result.addCheck('design-system-compliance:summary', true, {
      severity: 'info',
      message: `${stats.pagesVisited} page(s) crawled at ${baseUrl}: ${stats.colors.size} colors, ${stats.fontSizes.size} font sizes, ${stats.fontFamilies.size} font families, ${stats.radii.size} border-radii, ${offGrid.length} off-grid spacing value(s)`,
    });
  }
}

module.exports = DesignSystemComplianceModule;
