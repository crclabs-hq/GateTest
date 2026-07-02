// =============================================================================
// PLAYWRIGHT STABILITY HELPER TEST
// =============================================================================

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const PS = require('../src/core/playwright-stability.js');

// ---------------------------------------------------------------------------
// Module shape
// ---------------------------------------------------------------------------

describe('playwright-stability — shape', () => {
  it('exports the documented API', () => {
    assert.strictEqual(typeof PS.stableGoto, 'function');
    assert.strictEqual(typeof PS.installThirdPartyStubs, 'function');
    assert.strictEqual(typeof PS.stabilisedContext, 'function');
    assert.strictEqual(typeof PS.isThirdPartyUrl, 'function');
    assert.ok(Array.isArray(PS.THIRD_PARTY_HOSTS));
  });
});

// ---------------------------------------------------------------------------
// isThirdPartyUrl
// ---------------------------------------------------------------------------

describe('playwright-stability — isThirdPartyUrl', () => {
  it('matches Google Analytics', () => {
    assert.ok(PS.isThirdPartyUrl('https://www.google-analytics.com/collect'));
    assert.ok(PS.isThirdPartyUrl('https://googletagmanager.com/gtag/js'));
  });

  it('matches Segment / Amplitude / Mixpanel', () => {
    assert.ok(PS.isThirdPartyUrl('https://cdn.segment.io/analytics.js'));
    assert.ok(PS.isThirdPartyUrl('https://api.amplitude.com/2/httpapi'));
    assert.ok(PS.isThirdPartyUrl('https://api.mixpanel.com/track'));
  });

  it('matches Sentry / Bugsnag / Rollbar', () => {
    assert.ok(PS.isThirdPartyUrl('https://browser.sentry-cdn.com/7.0.0/bundle.min.js'));
    assert.ok(PS.isThirdPartyUrl('https://api.bugsnag.com/notify'));
    assert.ok(PS.isThirdPartyUrl('https://rollbar.com/api/1/item/'));
  });

  it('matches Hotjar / FullStory / LogRocket', () => {
    assert.ok(PS.isThirdPartyUrl('https://static.hotjar.com/c/hotjar-12345.js'));
    assert.ok(PS.isThirdPartyUrl('https://rs.fullstory.com/rec/page'));
    assert.ok(PS.isThirdPartyUrl('https://cdn.logrocket.io/LogRocket.min.js'));
  });

  it('does NOT match the customer\'s own domain', () => {
    assert.ok(!PS.isThirdPartyUrl('https://gluecron.com/api/x'));
    assert.ok(!PS.isThirdPartyUrl('https://crontech.ai/dashboard'));
    assert.ok(!PS.isThirdPartyUrl('https://gatetest.ai/api/scan'));
  });

  it('returns false for non-string input', () => {
    assert.strictEqual(PS.isThirdPartyUrl(null), false);
    assert.strictEqual(PS.isThirdPartyUrl(undefined), false);
    assert.strictEqual(PS.isThirdPartyUrl(42), false);
  });

  it('is case-insensitive', () => {
    assert.ok(PS.isThirdPartyUrl('https://GOOGLE-ANALYTICS.COM/collect'));
  });
});

// ---------------------------------------------------------------------------
// stableGoto — mocks page.goto to test retry behaviour
// ---------------------------------------------------------------------------

describe('playwright-stability — stableGoto', () => {
  it('returns the response on first-attempt success', async () => {
    const page = {
      goto: async () => ({ status: () => 200 }),
    };
    const resp = await PS.stableGoto(page, 'https://x.com', { backoffMs: 1 });
    assert.strictEqual(resp.status(), 200);
  });

  it('retries on failure and succeeds on the 3rd attempt', async () => {
    let attempts = 0;
    const page = {
      goto: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('flaky timeout');
        return { status: () => 200, attempts };
      },
    };
    const resp = await PS.stableGoto(page, 'https://x.com', { backoffMs: 1 });
    assert.strictEqual(attempts, 3);
    assert.strictEqual(resp.status(), 200);
  });

  it('throws after all retries exhausted', async () => {
    const page = {
      goto: async () => { throw new Error('persistent failure'); },
    };
    await assert.rejects(
      () => PS.stableGoto(page, 'https://x.com', { backoffMs: 1, retries: 2 }),
      /all 2 attempts failed/,
    );
  });

  it('uses default values when opts omitted', async () => {
    const page = { goto: async () => ({ status: () => 200 }) };
    const resp = await PS.stableGoto(page, 'https://x.com');
    assert.ok(resp);
  });

  it('respects custom retries count', async () => {
    let attempts = 0;
    const page = {
      goto: async () => {
        attempts += 1;
        throw new Error('always fail');
      },
    };
    await assert.rejects(
      () => PS.stableGoto(page, 'https://x.com', { retries: 5, backoffMs: 1 }),
    );
    assert.strictEqual(attempts, 5);
  });
});

// ---------------------------------------------------------------------------
// installThirdPartyStubs — mocks page.route
// ---------------------------------------------------------------------------

describe('playwright-stability — installThirdPartyStubs', () => {
  it('installs a route handler when page.route is available', async () => {
    let routeInstalled = false;
    const page = {
      route: async (_pattern, _handler) => { routeInstalled = true; },
    };
    const counters = await PS.installThirdPartyStubs(page);
    assert.ok(routeInstalled, 'page.route should have been called');
    assert.strictEqual(typeof counters.stubbed, 'number');
  });

  it('returns silently when page.route is missing', async () => {
    const counters = await PS.installThirdPartyStubs({});
    assert.strictEqual(counters.stubbed, 0);
  });

  it('returns silently when page is null', async () => {
    const counters = await PS.installThirdPartyStubs(null);
    assert.strictEqual(counters.stubbed, 0);
  });

  it('fulfills with 204 for third-party URLs and continues others', async () => {
    let handler;
    const fulfilled = [];
    const continued = [];
    const page = {
      route: async (_pattern, h) => { handler = h; },
    };
    await PS.installThirdPartyStubs(page);

    // Now simulate two requests: one to GA (should fulfill), one to the
    // customer domain (should continue).
    const gaRoute = {
      fulfill: async (resp) => { fulfilled.push({ url: 'GA', resp }); },
      continue: async () => { continued.push('GA'); },
    };
    await handler(gaRoute, { url: () => 'https://google-analytics.com/collect' });

    const customerRoute = {
      fulfill: async (resp) => { fulfilled.push({ url: 'customer', resp }); },
      continue: async () => { continued.push('customer'); },
    };
    await handler(customerRoute, { url: () => 'https://gatetest.ai/api/scan' });

    assert.strictEqual(fulfilled.length, 1, 'one fulfill (GA)');
    assert.strictEqual(fulfilled[0].resp.status, 204);
    assert.strictEqual(continued.length, 1, 'one continue (customer)');
    assert.strictEqual(continued[0], 'customer');
  });
});

// ---------------------------------------------------------------------------
// stabilisedContext
// ---------------------------------------------------------------------------

describe('playwright-stability — stabilisedContext', () => {
  it('throws on invalid browser', async () => {
    await assert.rejects(() => PS.stabilisedContext(null), /invalid browser/);
    await assert.rejects(() => PS.stabilisedContext({}), /invalid browser/);
  });

  it('creates context + page and installs stubs', async () => {
    let routeInstalled = false;
    const mockPage = { route: async () => { routeInstalled = true; } };
    const mockContext = { newPage: async () => mockPage };
    const browser = { newContext: async () => mockContext };
    const result = await PS.stabilisedContext(browser);
    assert.strictEqual(result.context, mockContext);
    assert.strictEqual(result.page, mockPage);
    assert.ok(routeInstalled);
  });

  it('passes contextOpts through to newContext', async () => {
    let receivedOpts;
    const mockContext = { newPage: async () => ({ route: async () => {} }) };
    const browser = {
      newContext: async (opts) => { receivedOpts = opts; return mockContext; },
    };
    await PS.stabilisedContext(browser, { contextOpts: { userAgent: 'test-agent' } });
    assert.deepStrictEqual(receivedOpts, { userAgent: 'test-agent' });
  });
});
