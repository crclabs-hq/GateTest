/**
 * Live Site Crawler Module — tests a RUNNING website by visiting every page.
 *
 * Solves the real problem: "Claude says it's fixed but it's not."
 *
 * Crawls a live URL, checks every page for HTTP errors, JS console errors,
 * broken images, dead links, missing titles, blank pages, redirect chains,
 * mixed content, missing meta tags. Produces a structured report that can
 * be fed directly back to Claude for automated fix loops.
 *
 * Engines split into sibling files for length-budget compliance:
 *   - live-crawler-browser-engine.js — Playwright (JS-rendered, real DOM)
 *   - live-crawler-http-engine.js    — fetch-based (no JS execution)
 *   - live-crawler-http-helpers.js   — shared HTTP utilities + suggestions
 *   - live-crawler-report.js         — Claude-feedback markdown + JSON
 */

const BaseModule = require('./base-module');
const { URL } = require('url');
const { checkUrl, getSuggestion, extractDeclaredIconHref } = require('./live-crawler-http-helpers');
const { crawlWithBrowser } = require('./live-crawler-browser-engine');
const { crawlWithHttp } = require('./live-crawler-http-engine');
const { generateFeedbackReport } = require('./live-crawler-report');
const { resolveAuth, authHeadersFor, isLoginUrl } = require('./live-crawler-auth');

// One definition of the per-page fetch budget, imported by both engines
// (live-crawler-http-engine.js, live-crawler-browser-engine.js) and this
// module's own default when .gatetest config / --crawl-page-timeout don't
// override it.
const DEFAULT_PAGE_TIMEOUT_MS = 15000;

// Headroom above the raw crawlMax × pageTimeout arithmetic (#640): time for
// the aux checks (sitemap/robots/favicon), the feedback report, and the
// runner's own overhead. One definition, used both by estimateTimeoutMs()
// (the runner-consulted outer ceiling) and by run()'s own internal pacing
// below, so the two figures can never independently drift (doctrine #4).
const CRAWL_BUDGET_MARGIN_MS = 30000;

class LiveCrawlerModule extends BaseModule {
  constructor() {
    super('liveCrawler', 'Live Site Crawl & Verification');
  }

  /** One definition of "which URL is this crawl targeting" — shared by run() and estimateTimeoutMs() below. */
  _resolveBaseUrl(config, crawlConfig) {
    return crawlConfig.url ||
      config.get('liveCrawler.url') ||
      config.get('targetUrl') ||
      config.get('webUrl') ||
      config.get('wpUrl');
  }

  /** One definition of "how long should this crawl's own configured workload take" (#640). */
  _estimatedCrawlBudgetMs(maxPages, pageTimeout) {
    return maxPages * pageTimeout + CRAWL_BUDGET_MARGIN_MS;
  }

  /**
   * Runner hook consulted by GateTestRunner._moduleTimeoutMs (see that
   * method's precedence comment in src/core/runner.js). A crawl's own
   * workload — crawlMax pages × the per-page timeout — routinely exceeds
   * the generic module ceiling meant for a lint pass, and used to be killed
   * outright with zero pages recorded (#640: a 60-page crawl of a slow host
   * died at the 120s default with nothing collected). Returning null (no
   * URL configured, or no getModuleConfig to ask) defers to the runner's
   * normal env-var/heavy/default cascade.
   */
  estimateTimeoutMs(config) {
    if (!config || typeof config.getModuleConfig !== 'function') return null;
    const crawlConfig = config.getModuleConfig('liveCrawler') || {};
    const baseUrl = this._resolveBaseUrl(config, crawlConfig);
    if (!baseUrl) return null;
    const maxPages = crawlConfig.maxPages || 100;
    const pageTimeout = crawlConfig.pageTimeout || DEFAULT_PAGE_TIMEOUT_MS;
    return this._estimatedCrawlBudgetMs(maxPages, pageTimeout);
  }

  async run(result, config) {
    const crawlConfig = config.getModuleConfig('liveCrawler') || {};
    const baseUrl = this._resolveBaseUrl(config, crawlConfig);

    if (!baseUrl) {
      result.addCheck('crawl:config', true, {
        message: 'No live URL configured — set modules.liveCrawler.url in .gatetest/config.json',
      });
      return;
    }

    const maxPages = crawlConfig.maxPages || 100;
    const timeout = crawlConfig.timeout || 10000;
    // Per-page fetch budget — separate from `timeout` (the socket timeout
    // used for individual asset/link HEAD checks). A handful of pages that
    // each take a few seconds can add up past the module's wall-clock
    // ceiling before the run ever reaches generateFeedbackReport, producing
    // "zero pages recorded" with no report at all. Bounding each page's own
    // fetch keeps a stalled page from silently eating the whole budget, and
    // labels it as a timeout finding instead of a generic fetch error.
    const pageTimeout = crawlConfig.pageTimeout || DEFAULT_PAGE_TIMEOUT_MS;
    const checkExternal = crawlConfig.checkExternal !== false;
    const slowThresholdMs = crawlConfig.slowThresholdMs || 2500;

    const auth = resolveAuth(crawlConfig, baseUrl);
    if (auth.storageStateMissing) {
      result.addCheck('crawl:auth-config', false, {
        severity: 'error',
        message: `storageState file not found: ${auth.storageState}`,
        suggestion: 'Export a Playwright storage state (e.g. `npx playwright codegen --save-storage=state.json <url>`) and point modules.liveCrawler.storageState / --crawl-storage-state at it.',
      });
    }
    if (auth.enabled) {
      const parts = [];
      if (Object.keys(auth.headers).length > 0) parts.push(`${Object.keys(auth.headers).length} header(s)`);
      if (auth.cookie) parts.push('cookie');
      if (auth.storageState && !auth.storageStateMissing) parts.push('storage state');
      result.addCheck('crawl:auth', true, {
        message: `Authenticated crawl: carrying ${parts.join(' + ')} (same-origin only — never sent to external hosts)`,
      });
    }

    const collectors = {
      visited: new Set(),
      queue: [baseUrl],
      pages: [],
      errors: [],
      brokenLinks: [],
      redirects: [],
      brokenImages: [],
      brokenScripts: [],
      brokenStylesheets: [],
      missingMetaDescription: [],
      missingCanonical: [],
      slowPages: [],
      anchorMissingId: [],
      titlesByUrl: new Map(),
      timedOutPages: [],
      offSiteRedirects: [],
    };

    let playwright = null;
    let useBrowser = crawlConfig.browser !== false;
    if (useBrowser) {
      try { playwright = require('playwright'); }
      catch { playwright = null; useBrowser = false; }
    }

    result.addCheck('crawl:start', true, {
      message: `Crawling ${baseUrl} (max ${maxPages} pages, mode: ${useBrowser ? 'browser (JS-rendered)' : 'HTTP-only'})...`,
    });

    const runStartedAt = Date.now();
    // The wall-clock budget the runner is ACTUALLY racing this run against
    // — injected by GateTestRunner._runModule as config._moduleTimeoutMs
    // when run through the runner (see estimateTimeoutMs above); falls back
    // to this module's own estimate for direct/test invocations that
    // bypass the runner. Pacing the crawl loop against this exact figure
    // (not just a generic default) is what turns a tight budget into a
    // partial report instead of the runner's own race silently discarding
    // every page already fetched (#640).
    const assignedTimeoutMs = (typeof config._moduleTimeoutMs === 'number' && config._moduleTimeoutMs > 0)
      ? config._moduleTimeoutMs
      : this._estimatedCrawlBudgetMs(maxPages, pageTimeout);
    // Stop attempting new pages with at least one page's worst-case
    // duration still in hand, so the aux checks + report below always have
    // time to run before the runner's own race timer (using this exact
    // budget) could fire. Never negative — the engines always allow their
    // very first page attempt regardless of this deadline (see
    // crawlWithHttp/crawlWithBrowser), so an assigned budget smaller than
    // one page's own timeout still gets exactly one try rather than being
    // inflated into a deadline the outer race timer doesn't actually have;
    // in that genuinely pathological case (module budget < a single page's
    // own timeout) the runner's own race remains the safety net, same as
    // before this fix.
    const crawlDeadlineTs = runStartedAt + Math.max(0, assignedTimeoutMs - pageTimeout);

    const engineCtx = {
      baseUrl, maxPages, timeout, pageTimeout, checkExternal, slowThresholdMs, auth,
      crawlDeadlineTs,
      ...collectors,
    };

    let crawlOutcome;
    if (useBrowser) {
      crawlOutcome = await crawlWithBrowser(playwright, engineCtx);
    } else {
      crawlOutcome = await crawlWithHttp(engineCtx);
    }
    collectors.budgetExhausted = !!(crawlOutcome && crawlOutcome.budgetExhausted);
    collectors.maxPages = maxPages;
    collectors.crawlElapsedMs = Date.now() - runStartedAt;

    this._emitChecks(result, baseUrl, collectors);
    this._emitAuthWallCheck(result, collectors, auth);

    // A crawl that was cut short by its own budget has none to spare on
    // aux probes — every extra second spent here eats into the margin
    // reserved above for actually writing the report before the runner's
    // race timer fires.
    if (!collectors.budgetExhausted) {
      if (crawlConfig.checkSitemap !== false) await this._checkAuxUrl(result, baseUrl, '/sitemap.xml', timeout,
        'crawl:sitemap-missing', 'warning', 'No /sitemap.xml found',
        'Generate a sitemap.xml. Most frameworks have a plugin for this.', auth);
      if (crawlConfig.checkRobotsTxt !== false) await this._checkAuxUrl(result, baseUrl, '/robots.txt', timeout,
        'crawl:robots-missing', 'info', 'No /robots.txt found',
        'Add a /robots.txt even if it just says "User-agent: *\\nAllow: /" — signals intentionality.', auth);
      if (crawlConfig.checkFavicon !== false) await this._checkFavicon(result, baseUrl, timeout, auth, collectors.pages);
    }

    generateFeedbackReport(config, {
      baseUrl,
      pagesScanned: collectors.pages.length,
      errors: collectors.errors,
      brokenLinks: collectors.brokenLinks,
      brokenImages: collectors.brokenImages,
      redirects: collectors.redirects,
      timedOutPages: collectors.timedOutPages,
      budgetExhausted: collectors.budgetExhausted,
      maxPages: collectors.maxPages,
      crawlElapsedMs: collectors.crawlElapsedMs,
    });
  }

  _emitChecks(result, baseUrl, c) {
    result.addCheck('crawl:pages-scanned', true, {
      message: `Crawled ${c.pages.length} page(s) from ${baseUrl}`,
    });

    const timedOutPages = c.timedOutPages || [];
    if (timedOutPages.length > 0) {
      const attempted = c.pages.length + timedOutPages.length;
      result.addCheck('crawl:page-timeouts', false, {
        severity: 'warning',
        message: `${timedOutPages.length} of ${attempted} page(s) timed out — a stalled page no longer blocks the rest of the crawl, but it was NOT checked`,
        details: timedOutPages.slice(0, 30),
        suggestion: 'Investigate why the page never responded (slow backend, infinite loop, hung upstream call). Raise --crawl-page-timeout if the page is just slow, not broken.',
      });
    }

    const offSiteRedirects = c.offSiteRedirects || [];
    if (offSiteRedirects.length > 0) {
      // #634: a link redirecting off-site is disclosed, never graded as a
      // broken link — the crawl does not own the terminal host's status.
      result.addCheck('crawl:off-site-redirect', true, {
        severity: 'info',
        message: `${offSiteRedirects.length} link(s) redirected off-site — not followed past the target's own origin, so the terminal host's status is not graded against this site`,
        details: offSiteRedirects.slice(0, 30),
      });
    }

    // Doctrine #1 (three-state): a crawl cut short by its own wall-clock
    // budget must say so explicitly, carrying what it DID fetch, rather
    // than the runner's outer race discarding everything and reporting
    // "no data was collected for this run" (#640).
    if (c.budgetExhausted) {
      const elapsedS = ((c.crawlElapsedMs || 0) / 1000).toFixed(1);
      result.addCheck('crawl:not-checked:budget', true, {
        severity: 'info',
        message: `${c.pages.length} of ${c.maxPages} pages fetched in ${elapsedS}s — crawl budget exhausted before the page limit was reached`,
        suggestion: 'Raise the module timeout (.gatetest config modules.liveCrawler under moduleTimeouts, or GATETEST_MODULE_TIMEOUT_MS) or lower --crawl-max / --crawl-page-timeout for this host.',
      });
    }

    if (c.errors.length > 0) {
      const grouped = {};
      for (const err of c.errors) {
        if (!grouped[err.type]) grouped[err.type] = [];
        grouped[err.type].push(err);
      }
      for (const [type, errs] of Object.entries(grouped)) {
        result.addCheck(`crawl:error:${type}`, false, {
          message: `${errs.length} "${type}" error(s) found`,
          details: errs.map(e => ({ url: e.url, message: e.message })),
          suggestion: getSuggestion(type),
        });
      }
    }

    this._emitListCheck(result, c.brokenLinks, 'crawl:broken-links', 'error',
      'broken link(s) found', 'Fix or remove broken links');
    this._emitListCheck(result, c.brokenImages, 'crawl:broken-images', 'error',
      'broken image(s) found', 'Fix image paths or replace missing images');
    this._emitListCheck(result, c.brokenScripts, 'crawl:broken-scripts', 'error',
      'broken script(s) found — features depending on these scripts will silently fail for real users',
      'Audit <script src> URLs. 404s typically mean a CDN deprecated the asset or a deploy didn\'t ship the bundle.');
    this._emitListCheck(result, c.brokenStylesheets, 'crawl:broken-stylesheets', 'error',
      'broken stylesheet(s) found — users see unstyled HTML',
      'Audit <link rel="stylesheet"> URLs and CDN endpoints for 404s.');
    this._emitListCheck(result, c.missingMetaDescription, 'crawl:missing-meta-description', 'warning',
      'page(s) missing meta description — Google generates poor snippet text for these pages',
      'Add <meta name="description" content="..."> to each page. Ideal length 150-160 characters.');
    this._emitListCheck(result, c.missingCanonical, 'crawl:missing-canonical', 'warning',
      'page(s) missing <link rel="canonical"> — risks duplicate-content SEO penalties',
      'Add <link rel="canonical" href="..."> pointing at the page\'s preferred URL.');
    this._emitListCheck(result, c.slowPages, 'crawl:slow-pages', 'warning',
      'page(s) slower than threshold — real users bounce on slow TTFB',
      'Investigate slow endpoints. Common causes: cold-start backends, unindexed DB queries, blocking 3rd-party scripts.');
    this._emitListCheck(result, c.anchorMissingId, 'crawl:anchor-missing-target', 'warning',
      'broken anchor link(s) — clicking does nothing for users',
      'Either remove the anchor or add the corresponding id="..." attribute to the target element.');

    const titleCounts = new Map();
    for (const t of c.titlesByUrl.values()) {
      titleCounts.set(t, (titleCounts.get(t) || 0) + 1);
    }
    const duplicateTitles = [];
    for (const [title, count] of titleCounts.entries()) {
      if (count > 1) {
        const urls = Array.from(c.titlesByUrl.entries())
          .filter(([, t]) => t === title)
          .map(([u]) => u);
        duplicateTitles.push({ title, count, urls });
      }
    }
    if (duplicateTitles.length > 0) {
      result.addCheck('crawl:duplicate-titles', false, {
        severity: 'warning',
        message: `${duplicateTitles.length} title(s) used by multiple pages — confuses users + dilutes SEO`,
        details: duplicateTitles.slice(0, 20),
        suggestion: 'Each page should have a unique <title> describing that page specifically.',
      });
    }

    if (c.redirects.length > 0) {
      result.addCheck('crawl:redirects', true, {
        message: `${c.redirects.length} redirect(s) detected`,
        details: c.redirects.slice(0, 20),
      });
    }

    const nothingWrong = c.errors.length === 0
      && c.brokenLinks.length === 0
      && c.brokenImages.length === 0
      && timedOutPages.length === 0;

    // "Site is clean" is a claim, and it needs evidence: at least one page must
    // actually have been fetched. Both engines record a fetch-error when a page
    // fails, so an unreachable site cannot reach this branch — but a crawl that
    // simply visited nothing (an exhausted budget, a config that permits no
    // pages) would otherwise have reported "Site is clean — 0 pages", which
    // asserts a verdict off zero observations. Same shape as the aiReview
    // false-clean fixed in d04bd39.
    if (c.budgetExhausted) {
      // An incomplete crawl can never claim "clean" — that would assert a
      // verdict the crawl didn't finish earning. crawl:not-checked:budget
      // above already discloses the shortfall; only add crawl:no-pages on
      // top of it if truly nothing was fetched before the budget ran out.
      if (c.pages.length === 0) {
        result.addCheck('crawl:no-pages', false, {
          severity: 'warning',
          message: 'Crawl finished without fetching any pages — nothing was verified, so this is NOT a clean result',
          suggestion: 'Check the start URL is reachable and that the page budget is above zero.',
        });
      }
    } else if (nothingWrong && c.pages.length > 0) {
      result.addCheck('crawl:clean', true, {
        message: `Site is clean — ${c.pages.length} pages, 0 errors, 0 broken links, 0 broken images`,
      });
    } else if (nothingWrong) {
      result.addCheck('crawl:no-pages', false, {
        severity: 'warning',
        message: 'Crawl finished without fetching any pages — nothing was verified, so this is NOT a clean result',
        suggestion: 'Check the start URL is reachable and that the page budget is above zero.',
      });
    }
  }

  /**
   * Detect the auth-wall pattern: internal pages redirecting to a login
   * screen. Without a session this means whole authed sections (/dashboard/*)
   * were never actually tested — the exact failure mode that makes agents
   * bypass the crawler instead of using it.
   */
  _emitAuthWallCheck(result, c, auth) {
    const loginRedirects = c.redirects.filter(r => isLoginUrl(r.to) && !isLoginUrl(r.from));
    if (loginRedirects.length === 0) return;

    if (!auth.enabled) {
      result.addCheck('crawl:auth-wall', false, {
        severity: 'warning',
        message: `${loginRedirects.length} page(s) redirected to a login screen — the crawler has no session, so pages behind auth were NOT tested`,
        details: loginRedirects.slice(0, 20),
        suggestion: 'Give the crawler a session: --crawl-header "Authorization: Bearer $TOKEN", --crawl-cookie "session=...", or --crawl-storage-state state.json (config: modules.liveCrawler.headers / cookie / storageState; values support ${ENV_VAR}).',
      });
    } else {
      result.addCheck('crawl:auth-rejected', false, {
        severity: 'error',
        message: `Auth was configured but ${loginRedirects.length} page(s) still redirected to a login screen — the session appears invalid or expired`,
        details: loginRedirects.slice(0, 20),
        suggestion: 'Refresh the token/cookie/storage state and re-run. Check the header name and cookie name match what the app expects.',
      });
    }
  }

  _emitListCheck(result, list, key, severity, messageSuffix, suggestion) {
    if (list.length === 0) return;
    result.addCheck(key, false, {
      severity,
      message: `${list.length} ${messageSuffix}`,
      details: list.slice(0, 30),
      suggestion,
    });
  }

  async _checkAuxUrl(result, baseUrl, urlPath, timeout, key, severity, baseMessage, suggestion, auth) {
    try {
      const auxUrl = new URL(urlPath, baseUrl).href;
      const r = await checkUrl(auxUrl, timeout, authHeadersFor(auxUrl, auth));
      if (r.status >= 400) {
        result.addCheck(key, false, {
          severity,
          message: `${baseMessage} (HTTP ${r.status})`,
          suggestion,
        });
      }
    } catch (err) {
      // A probe that could not complete is "not checked", not "present":
      // say so on the report (doctrine §6) instead of passing by silence.
      result.addCheck(`${key}:not-checked`, true, {
        severity: 'info',
        message: `${urlPath} was not checked — the request failed (${err && err.message ? err.message : err})`,
      });
    }
  }

  /**
   * Favicon presence (#641): probing only /favicon.ico missed the "modern
   * alternative" the rule's own old suggestion text named — a
   * <link rel="icon"|"shortcut icon"|"apple-touch-icon" href="..."> in
   * <head> (tallrig.com declares /favicon.svg this way and was flagged
   * anyway). Discover the declared icon on the first crawled page, resolve
   * it against the page URL, and only report when NEITHER it nor
   * /favicon.ico actually resolves. Severity stays info, as before.
   */
  async _checkFavicon(result, baseUrl, timeout, auth, pages) {
    const homepageBody = pages[0] && pages[0].body;
    const declaredHref = homepageBody ? extractDeclaredIconHref(homepageBody) : null;

    const candidates = [];
    if (declaredHref) {
      try { candidates.push(new URL(declaredHref, baseUrl).href); }
      catch { /* error-ok — malformed declared href, /favicon.ico is still checked below */ }
    }
    candidates.push(new URL('/favicon.ico', baseUrl).href);

    let anyResolved = false;
    let anyChecked = false;
    for (const candidate of candidates) {
      try {
        const r = await checkUrl(candidate, timeout, authHeadersFor(candidate, auth));
        anyChecked = true;
        if (r.status < 400) { anyResolved = true; break; }
      } catch { /* this candidate could not be reached — try the next one */ }
    }

    if (anyResolved) return;

    if (!anyChecked) {
      result.addCheck('crawl:favicon-missing:not-checked', true, {
        severity: 'info',
        message: `Favicon was not checked — ${declaredHref ? 'the declared icon and ' : ''}/favicon.ico could not be reached`,
      });
      return;
    }

    result.addCheck('crawl:favicon-missing', false, {
      severity: 'info',
      message: declaredHref
        ? `No favicon found — declared icon "${declaredHref}" and /favicon.ico both failed to resolve`
        : 'No /favicon.ico found and no <link rel="icon"> declared',
      suggestion: 'Add a favicon.ico in the site root, or a <link rel="icon" href="..."> in <head> that actually resolves.',
    });
  }
}

module.exports = LiveCrawlerModule;
