/**
 * Interactive Elements Module — the live/dynamic counterpart to the static
 * `links` module. Crawls a real site with Playwright and verifies every
 * link and button actually works — not just that it compiles.
 *
 * Design note (why this isn't a duplicate of `explorer`): `explorer` is the
 * full autonomous QA surface (forms, toggles, disclosures, screenshots,
 * visual-regression checks) and clicks every button it finds. This module
 * is narrower and safer by construction:
 *
 *   - Links (`<a href>` without `role="button"`) are verified with a direct
 *     HTTP HEAD request against the literal URL, not a simulated click.
 *     This is faster, catches server-side 404s that a client-side router
 *     would swallow on a simulated click, and carries zero destructive
 *     risk — a HEAD request never mutates state.
 *   - Buttons (`<button>`, `[role="button"]`, `input[type=button|submit]`)
 *     ARE click-tested, because there's no way to verify "does this button
 *     do something" without clicking it. Before clicking, the element's
 *     text/aria-label is checked against a destructive-action pattern list
 *     (delete, cancel, unsubscribe, deactivate, sign out, archive, revoke,
 *     ...) — matches are SKIPPED, never clicked. This is the safety gap
 *     the visual/runtime testing spec explicitly calls out: automated
 *     crawlers must never fire real delete/cancel/logout actions against a
 *     live site.
 *   - Any modal/dialog left open by a button click is dismissed (Escape,
 *     then a best-effort close-button click) before the next element is
 *     tested, so state doesn't leak between interactions on the same page.
 *   - Page scrolling before element discovery is capped at a small,
 *     configurable step count so infinite-scroll pages can't turn one
 *     page visit into an unbounded crawl.
 *
 * Requires: Playwright (already an approved GateTest dependency). Reuses
 * the HTTP HEAD helper from live-crawler-http-helpers.js instead of
 * duplicating it.
 */

'use strict';

const path = require('path');
const BaseModule = require('./base-module');
const { checkUrl, fetchPage } = require('./live-crawler-http-helpers');

const DESTRUCTIVE_PATTERNS = [
  /\bdelete\b/i,
  /\bremove\b/i,
  /\bcancel\b/i,
  /\bunsubscribe\b/i,
  /\bdeactivat/i,
  /\bsign[\s-]*out\b/i,
  /\blog[\s-]*(out|off)\b/i,
  /\barchive\b/i,
  /\brevoke\b/i,
  /\bdisconnect\b/i,
  /\buninstall\b/i,
  /\bterminate\b/i,
  /\bclose\s+account\b/i,
  /\bpermanently\b/i,
  /\bdiscard\b/i,
  /\bclear\s+(all|data|cache|history)\b/i,
  /\breset\b/i,
  /\bban\b/i,
  /\bblock\b/i,
  /\bsuspend\b/i,
  /\bwipe\b/i,
  /\bpurge\b/i,
  /\bempty\s+trash\b/i,
];

// Deliberately broad — covers modals/dialogs AND lighter-weight dynamic UI
// (dropdown menus, popovers, mega-nav category panels, toasts). A nav
// category button that opens a hover/click dropdown is "doing something"
// even though nothing navigates — narrower selector lists misclassify
// those as dead buttons (confirmed against a real mega-nav during the
// vapron.ai proof run for this module).
const MODAL_SELECTORS = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[role="tooltip"]',
  '.modal',
  '.dialog',
  '.dropdown-menu',
  '.popover',
  '.toast',
  '.overlay',
  '.drawer',
  '[data-state="open"]',
  '[aria-expanded="true"]',
  'dialog[open]',
];

const DEFAULT_MAX_PAGES = 15;
const DEFAULT_MAX_ELEMENTS_PER_PAGE = 40;
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_HTTP_TIMEOUT_MS = 6000;
const DEFAULT_SCROLL_STEPS = 3;

const MAX_ACTION_LABEL_LENGTH = 40;

function isDestructive(text) {
  const t = (text || '').trim();
  if (!t) return false;
  // Real destructive actions are short, imperative button labels
  // ("Cancel", "Delete Account", "Unsubscribe") — never long sentences.
  // An FAQ question like "Can I cancel at any time?" contains the same
  // keyword but isn't an action button; without this guard it gets
  // safety-skipped and its actual dead/working state never gets tested
  // (confirmed against a real pricing-FAQ accordion during this
  // module's zoobicon.com proof run). Question marks and long text both
  // rule out an imperative action label.
  if (t.endsWith('?') || t.length > MAX_ACTION_LABEL_LENGTH) return false;
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(t));
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

class InteractiveElementsModule extends BaseModule {
  constructor() {
    super('interactiveElements', 'Interactive Element Crawler — Links & Buttons');
  }

  async run(result, config) {
    const moduleCfg = config.getModuleConfig('interactiveElements') || {};
    const baseUrl =
      process.env.GATETEST_INTERACTIVE_URL ||
      moduleCfg.url ||
      config.get('explorer.url') ||
      config.get('liveCrawler.url') ||
      config.get('webUrl') ||
      config.get('wpUrl') ||
      config.get('targetUrl');

    if (!baseUrl) {
      result.addCheck('interactive-elements:config', true, {
        severity: 'info',
        message:
          'No target URL configured — set GATETEST_INTERACTIVE_URL or modules.interactiveElements.url in .gatetest/config.json',
      });
      return;
    }

    const playwright = resolvePlaywright();
    if (!playwright) {
      result.addCheck('interactive-elements:playwright-missing', true, {
        severity: 'info',
        message: 'Playwright not available in this environment — interactive element checks skipped.',
        suggestion: 'npm install playwright && npx playwright install chromium',
      });
      return;
    }

    let browser;
    try {
      browser = await playwright.chromium.launch({ headless: true, timeout: 15000 });
    } catch (err) {
      result.addCheck('interactive-elements:browser-launch', true, {
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
    const maxElementsPerPage = moduleCfg.maxElementsPerPage || DEFAULT_MAX_ELEMENTS_PER_PAGE;
    const timeout = moduleCfg.timeout || DEFAULT_TIMEOUT_MS;
    const httpTimeout = moduleCfg.httpTimeout || DEFAULT_HTTP_TIMEOUT_MS;
    const scrollSteps = typeof moduleCfg.scrollSteps === 'number' ? moduleCfg.scrollSteps : DEFAULT_SCROLL_STEPS;

    const stats = {
      pagesVisited: 0,
      linksChecked: 0,
      buttonsChecked: 0,
      brokenLinks: [],
      deadButtons: [],
      buttonErrors: [],
      skippedDestructive: [],
      pageErrors: [],
    };

    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: 'GateTest/1.0 (+https://gatetest.ai/bot) InteractiveElements',
    });
    const page = await context.newPage();

    const checkedLinkUrls = new Set();
    const visited = new Set();
    const queue = [baseUrl];

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
          } catch (err) {
            stats.pageErrors.push({ url, message: err.message || String(err) });
            continue;
          }
        }

        if (!response || response.status() >= 400) {
          stats.brokenLinks.push({ url, status: response ? response.status() : 0, source: 'crawl-navigation' });
          continue;
        }
        stats.pagesVisited++;

        await this._boundedScroll(page, scrollSteps);

        const { links, buttons } = await this._discover(page, baseUrl);

        for (const link of links) {
          if (link.internal && !visited.has(link.absoluteUrl) && !queue.includes(link.absoluteUrl)) {
            queue.push(link.absoluteUrl);
          }
        }

        await this._checkLinks(links.slice(0, maxElementsPerPage), checkedLinkUrls, httpTimeout, stats);
        await this._checkButtons(page, buttons.slice(0, maxElementsPerPage), url, timeout, stats);
      }
    } finally {
      await context.close().catch(() => {});
    }

    return stats;
  }

  async _boundedScroll(page, steps) {
    for (let i = 0; i < steps; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight)).catch(() => {});
      await page.waitForTimeout(150);
    }
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await page.waitForTimeout(150);
  }

  async _discover(page, baseUrl) {
    return page.evaluate((base) => {
      function isVisible(el) {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      const links = [];
      document.querySelectorAll('a[href]').forEach((el) => {
        if (el.getAttribute('role') === 'button') return; // handled as a button below
        const href = el.getAttribute('href');
        if (!href || href === '#' || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
        if (!isVisible(el)) return;
        let absoluteUrl;
        try {
          absoluteUrl = new URL(href, base).toString();
        } catch {
          return;
        }
        links.push({
          href,
          absoluteUrl,
          internal: absoluteUrl.startsWith(base) || absoluteUrl.startsWith(new URL(base).origin),
          text: el.textContent ? el.textContent.trim().slice(0, 60) : href,
        });
      });

      const buttons = [];
      let idx = 0;
      document
        .querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]')
        .forEach((el) => {
          idx++;
          if (!isVisible(el)) return;
          if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return;
          const text = el.textContent ? el.textContent.trim().slice(0, 60) : '';
          const label = el.getAttribute('aria-label') || '';
          buttons.push({
            selector: el.id ? `#${CSS.escape(el.id)}` : `button-idx-${idx}`,
            nthFallback: idx,
            tag: el.tagName.toLowerCase(),
            text: text || label,
            description: `${el.tagName.toLowerCase()}: "${text || label || 'unnamed'}"`,
          });
        });

      return { links, buttons };
    }, baseUrl);
  }

  async _checkLinks(links, checkedLinkUrls, httpTimeout, stats) {
    for (const link of links) {
      if (!link.internal) continue; // external liveness is out of scope — links module + liveCrawler cover static/HTTP external checks
      if (checkedLinkUrls.has(link.absoluteUrl)) continue;
      checkedLinkUrls.add(link.absoluteUrl);
      stats.linksChecked++;
      try {
        const status = await this._checkLinkLive(link.absoluteUrl, httpTimeout);
        if (status === 404 || status >= 500) {
          stats.brokenLinks.push({ url: link.absoluteUrl, status, text: link.text });
        }
      } catch (err) {
        stats.brokenLinks.push({ url: link.absoluteUrl, status: 0, text: link.text, error: err.message || String(err) });
      }
    }
  }

  /**
   * Resolve liveness for one URL. HEAD is the fast path, but some servers
   * (Next.js middleware in particular) mishandle HEAD — hanging, timing
   * out, or answering 404/405 for a route that's perfectly fine on GET.
   * A HEAD result that looks broken is verified with a real GET before
   * being trusted, so a HEAD-handling quirk never produces a false
   * "broken link" report (confirmed against real Next.js routes during
   * the vapron.ai proof run for this module).
   */
  async _checkLinkLive(url, timeout) {
    try {
      const headRes = await checkUrl(url, timeout);
      if (headRes.status < 400) return headRes.status;
    } catch {
      /* HEAD failed outright — fall through to a GET verification */
    }
    const getRes = await fetchPage(url, timeout);
    return getRes.status;
  }

  async _checkButtons(page, buttons, pageUrl, timeout, stats) {
    for (const btn of buttons) {
      stats.buttonsChecked++;

      if (isDestructive(btn.text)) {
        stats.skippedDestructive.push({ description: btn.description, url: pageUrl });
        continue;
      }

      try {
        const outcome = await this._testButton(page, btn, timeout);
        if (outcome.errored) {
          stats.buttonErrors.push({ description: btn.description, url: pageUrl, message: outcome.errorMessage });
        } else if (outcome.dead) {
          stats.deadButtons.push({ description: btn.description, url: pageUrl });
        }
      } catch (err) {
        stats.buttonErrors.push({ description: btn.description, url: pageUrl, message: err.message || String(err) });
      }

      await this._dismissModals(page);
      if (page.url() !== pageUrl) {
        try {
          await page.goto(pageUrl, { timeout, waitUntil: 'networkidle' });
        } catch {
          await page.goto(pageUrl, { timeout, waitUntil: 'load' }).catch(() => {});
        }
      }
    }
  }

  async _testButton(page, btn, timeout) {
    const locator = btn.selector.startsWith('#')
      ? page.locator(btn.selector).first()
      : page
          .locator('button, [role="button"], input[type="button"], input[type="submit"]')
          .nth(btn.nthFallback - 1);

    const beforeUrl = page.url();
    const beforeHtmlLen = await page.evaluate(() => document.body.innerHTML.length).catch(() => 0);
    const beforeModalCount = await this._countModals(page);
    const beforeSelfState = await this._readSelfState(locator);
    const beforeRootState = await this._readRootState(page);

    let networkRequestFired = false;
    const onRequest = () => { networkRequestFired = true; };
    const clickErrors = [];
    const onError = (err) => { clickErrors.push(err.message || String(err)); };
    page.on('request', onRequest);
    page.on('pageerror', onError);

    try {
      await locator.click({ timeout: 5000 });
    } catch {
      /* click failures are observed via page state, not thrown */
    }
    await page.waitForTimeout(600);

    page.removeListener('request', onRequest);
    page.removeListener('pageerror', onError);

    if (clickErrors.length > 0) {
      return { errored: true, errorMessage: clickErrors[0], dead: false };
    }

    const afterUrl = page.url();
    const afterHtmlLen = await page.evaluate(() => document.body.innerHTML.length).catch(() => 0);
    const afterModalCount = await this._countModals(page);
    const afterSelfState = await this._readSelfState(locator);
    const afterRootState = await this._readRootState(page);

    const urlChanged = beforeUrl !== afterUrl;
    const domChanged = Math.abs(afterHtmlLen - beforeHtmlLen) > 30;
    const modalChanged = beforeModalCount !== afterModalCount;
    const selfStateChanged = beforeSelfState !== afterSelfState;
    const rootStateChanged = beforeRootState !== afterRootState;
    const somethingHappened = urlChanged || domChanged || modalChanged || selfStateChanged || rootStateChanged || networkRequestFired;

    return { errored: false, dead: !somethingHappened };
  }

  /**
   * Many dropdown/mega-nav triggers reveal an already-present panel purely
   * via CSS (a class or aria-expanded toggle on the trigger itself), which
   * doesn't move `body.innerHTML.length` enough to register as a DOM
   * change and isn't one of the MODAL_SELECTORS if the site uses its own
   * class convention. Reading the clicked element's own class/expanded/
   * pressed/data-state attributes before and after the click catches that
   * common pattern without needing to guess every framework's CSS naming.
   */
  async _readSelfState(locator) {
    try {
      return await locator.evaluate((el) => [
        el.className,
        el.getAttribute('aria-expanded'),
        el.getAttribute('aria-pressed'),
        el.getAttribute('data-state'),
      ].join('|'));
    } catch {
      return '__gone__';
    }
  }

  /**
   * Theme toggles ("dark mode" switches) are the classic example of a
   * button whose effect lands neither on itself nor inside `<body>`'s
   * content — they flip a class or data attribute on `<html>` (the
   * standard Tailwind/next-themes convention: `document.documentElement
   * .classList.toggle('dark')`). Confirmed as a real false-positive
   * ("Toggle colour theme" on vapron.ai) during this module's proof run.
   */
  async _readRootState(page) {
    return page
      .evaluate(() => {
        const root = document.documentElement;
        return [root.className, root.getAttribute('data-theme'), document.body.className].join('|');
      })
      .catch(() => '__gone__');
  }

  async _countModals(page) {
    return page
      .evaluate((selectors) => selectors.reduce((count, sel) => count + document.querySelectorAll(sel).length, 0), MODAL_SELECTORS)
      .catch(() => 0);
  }

  async _dismissModals(page) {
    const openCount = await this._countModals(page);
    if (openCount === 0) return;
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);
    if ((await this._countModals(page)) === 0) return;
    const closeSelectors = [
      '[aria-label="Close" i]',
      '.close',
      '[data-dismiss="modal"]',
      'button:has-text("Close")',
    ];
    for (const sel of closeSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 500 })) {
          await el.click({ timeout: 1000 }).catch(() => {});
          break;
        }
      } catch {
        /* selector not present or not clickable — try the next one */
      }
    }
    await page.waitForTimeout(200);
  }

  _report(result, stats, baseUrl) {
    if (stats.pageErrors.length > 0) {
      result.addCheck('interactive-elements:page-errors', false, {
        severity: 'warning',
        message: `${stats.pageErrors.length} page(s) failed to load during the crawl`,
        details: stats.pageErrors.slice(0, 15),
      });
    }

    if (stats.brokenLinks.length > 0) {
      result.addCheck('interactive-elements:broken-links', false, {
        severity: 'error',
        message: `${stats.brokenLinks.length} broken link(s) found across ${stats.pagesVisited} page(s) — ${stats.linksChecked} links checked`,
        details: stats.brokenLinks.slice(0, 30),
        suggestion: 'Fix or remove links pointing at pages that 404 or 5xx',
      });
    } else {
      result.addCheck('interactive-elements:broken-links', true, {
        severity: 'info',
        message: `${stats.linksChecked} internal link(s) verified live across ${stats.pagesVisited} page(s) — 0 broken`,
      });
    }

    if (stats.deadButtons.length > 0) {
      result.addCheck('interactive-elements:dead-buttons', false, {
        severity: 'error',
        message: `${stats.deadButtons.length} dead button(s) found — clicked but nothing happened (no navigation, no DOM change, no modal, no network request)`,
        details: stats.deadButtons.slice(0, 30),
        suggestion: 'Wire up a click handler, or remove the button if it is no longer needed',
      });
    } else if (stats.buttonsChecked > 0) {
      result.addCheck('interactive-elements:dead-buttons', true, {
        severity: 'info',
        message: `${stats.buttonsChecked - stats.skippedDestructive.length} button(s) click-tested — 0 dead`,
      });
    }

    if (stats.buttonErrors.length > 0) {
      result.addCheck('interactive-elements:button-errors', false, {
        severity: 'error',
        message: `${stats.buttonErrors.length} button(s) threw an uncaught error when clicked`,
        details: stats.buttonErrors.slice(0, 30),
        suggestion: 'Fix the uncaught exception — add error handling around the click handler',
      });
    }

    if (stats.skippedDestructive.length > 0) {
      result.addCheck('interactive-elements:destructive-skipped', true, {
        severity: 'info',
        message: `${stats.skippedDestructive.length} destructive-looking button(s) (delete/cancel/logout/...) were NOT clicked — safety skip`,
        details: stats.skippedDestructive.slice(0, 30),
      });
    }

    result.addCheck('interactive-elements:summary', true, {
      severity: 'info',
      message: `${stats.pagesVisited} page(s) crawled from ${baseUrl}: ${stats.linksChecked} links checked (${stats.brokenLinks.length} broken), ${stats.buttonsChecked} buttons found (${stats.skippedDestructive.length} safety-skipped, ${stats.deadButtons.length} dead, ${stats.buttonErrors.length} errored)`,
    });
  }
}

module.exports = InteractiveElementsModule;
