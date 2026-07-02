/**
 * Playwright stability helpers (Manifest item #10).
 *
 * Wraps page.goto in a deterministic 3-strike retry loop and installs
 * page.route stubs that intercept third-party tracking / analytics
 * scripts so they can't destabilise the headless browser run with
 * flaky DNS, 504s, or unhandled console noise.
 *
 * Why this lives here:
 *   chaos.js, runtime-errors.js, and live-crawler-browser-engine.js
 *   all run Playwright and all hit the same flakiness shapes. Centralising
 *   stops the same retry logic being copy-pasted into three modules and
 *   drifting.
 *
 * Public API:
 *   stableGoto(page, url, opts)        — 3-strike navigation with backoff
 *   installThirdPartyStubs(page)       — route-block tracking + analytics
 *   stabilisedContext(browser, opts)   — context + stubs installed
 *
 * RESILIENCE: never throws on stub-installation failure (best-effort).
 * stableGoto throws after the final retry exhausts — callers wrap.
 */

'use strict';

const DEFAULT_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_BACKOFF_MS = 500;

// ---------------------------------------------------------------------------
// Third-party patterns — block requests to known tracking domains and
// known noisy script paths. Customers don't pay for us to ping Google.
// ---------------------------------------------------------------------------

const THIRD_PARTY_HOSTS = [
  // Analytics
  'google-analytics.com', 'googletagmanager.com', 'analytics.google.com',
  'segment.io', 'segment.com', 'cdn.segment.io', 'api.segment.io',
  'amplitude.com', 'api.amplitude.com',
  'mixpanel.com', 'api.mixpanel.com',
  'heap.io', 'heapanalytics.com',
  'hotjar.com', 'static.hotjar.com',
  'fullstory.com', 'rs.fullstory.com',
  'logrocket.com', 'cdn.logrocket.io',
  // Ads + pixels
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
  'facebook.net', 'connect.facebook.net',
  'twitter.com/i/adsct', 'analytics.twitter.com',
  'linkedin.com/li/track',
  'bat.bing.com',
  // Error trackers (we want our OWN error capture, not Sentry's)
  'sentry.io', 'browser.sentry-cdn.com',
  'bugsnag.com', 'd2wy8f7a9ursnm.cloudfront.net',
  'rollbar.com',
  // Misc noisy
  'intercom.io', 'intercom-cdn.com',
  'drift.com',
  'crisp.chat',
  'tawk.to',
];

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------

function isThirdPartyUrl(url) {
  if (typeof url !== 'string') return false;
  const lower = url.toLowerCase();
  for (const h of THIRD_PARTY_HOSTS) {
    if (lower.includes(h)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// stableGoto — 3-strike with exponential backoff
// ---------------------------------------------------------------------------

/**
 * page.goto with a 3-strike retry. Returns the response on success.
 *
 * @param {object} page                Playwright Page
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.retries=3]
 * @param {number} [opts.timeout=15000]
 * @param {number} [opts.backoffMs=500]
 * @param {string} [opts.waitUntil='networkidle']
 * @returns {Promise<object>}          Playwright Response
 */
async function stableGoto(page, url, opts = {}) {
  const retries = Number.isFinite(opts.retries) ? opts.retries : DEFAULT_RETRIES;
  const timeout = Number.isFinite(opts.timeout) ? opts.timeout : DEFAULT_TIMEOUT_MS;
  const backoffMs = Number.isFinite(opts.backoffMs) ? opts.backoffMs : DEFAULT_BACKOFF_MS;
  const waitUntil = opts.waitUntil || 'networkidle';

  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await page.goto(url, { timeout, waitUntil });
      return response;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const wait = backoffMs * Math.pow(2, attempt - 1);
        await sleep(wait);
      }
    }
  }
  throw new Error(`stableGoto: all ${retries} attempts failed for ${url}: ${lastErr && lastErr.message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// installThirdPartyStubs — page.route to abort/stub tracking requests
// ---------------------------------------------------------------------------

/**
 * Install route handlers on a Playwright page that abort or stub
 * requests to known third-party tracking / analytics / ad domains.
 *
 * Best-effort: if page.route is not a function, returns silently.
 *
 * @param {object} page
 * @returns {Promise<{ stubbed: number }>}
 */
async function installThirdPartyStubs(page) {
  if (!page || typeof page.route !== 'function') {
    return { stubbed: 0 };
  }
  let stubbed = 0;
  try {
    await page.route('**', async (route, request) => {
      try {
        const url = request.url();
        if (isThirdPartyUrl(url)) {
          stubbed += 1;
          await route.fulfill({
            status: 204,
            body: '',
            headers: { 'content-type': 'text/plain' },
          });
          return;
        }
        await route.continue();
      } catch {
        try { await route.continue(); } catch { /* swallow */ }
      }
    });
  } catch {
    return { stubbed: 0 };
  }
  // The stubbed counter is a closure — caller can read it via the
  // returned object, but Playwright dispatches handlers async so the
  // count is only accurate after the page has navigated. The returned
  // object holds a snapshot of `stubbed` at any later moment via a
  // getter.
  return {
    get stubbed() { return stubbed; },
  };
}

// ---------------------------------------------------------------------------
// stabilisedContext — convenience: create a context with stubs ready
// ---------------------------------------------------------------------------

/**
 * Create a new browser context, then a new page, install third-party
 * stubs, and return { context, page, counters }.
 *
 * Caller is responsible for cleanup (context.close()).
 *
 * @param {object} browser   Playwright Browser
 * @param {object} [opts]
 * @returns {Promise<{ context: object, page: object, counters: object }>}
 */
async function stabilisedContext(browser, opts = {}) {
  if (!browser || typeof browser.newContext !== 'function') {
    throw new Error('stabilisedContext: invalid browser');
  }
  const context = await browser.newContext(opts.contextOpts || {});
  const page = await context.newPage();
  const counters = await installThirdPartyStubs(page);
  return { context, page, counters };
}

// ---------------------------------------------------------------------------

module.exports = {
  stableGoto,
  installThirdPartyStubs,
  stabilisedContext,
  isThirdPartyUrl,
  THIRD_PARTY_HOSTS,
};
