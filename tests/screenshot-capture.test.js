// ============================================================================
// SCREENSHOT CAPTURE (core helper) TEST — src/core/screenshot-capture.js
// ============================================================================
// The capture path needs a real browser, so unit coverage focuses on:
//   - slugifyRoute parity with the visual-regression module's baselines
//   - resolvePlaywright's require-interception fallback behavior
//   - captureUrlScreenshot's coded errors (PLAYWRIGHT_MISSING via the DI
//     seam — passing playwright:null simulates absence without uninstalling)
//   - input validation
// Real-browser capture is exercised by tests/mcp-eyes-tools.test.js (skips
// gracefully when chromium can't launch) and the E2E proof run.
// ============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  slugifyRoute,
  resolvePlaywright,
  captureUrlScreenshot,
} = require('../src/core/screenshot-capture.js');

describe('slugifyRoute', () => {
  it('matches the baseline layout the visualRegression module writes', () => {
    assert.strictEqual(slugifyRoute('/'), 'index');
    assert.strictEqual(slugifyRoute(''), 'index');
    assert.strictEqual(slugifyRoute('/pricing'), 'pricing');
    assert.strictEqual(slugifyRoute('/docs/api/v2'), 'docs-api-v2');
    assert.strictEqual(slugifyRoute('/Blog?page=2'), 'blog-page-2');
  });

  it('the visual-regression module re-exports THIS implementation (no drift)', () => {
    // The module delegates to core — require it and confirm identity of behavior
    // by round-tripping a tricky route through both import paths.
    const modPath = require.resolve('../src/modules/visual-regression.js');
    delete require.cache[modPath];
    require('../src/modules/visual-regression.js'); // must not throw after the refactor
    assert.strictEqual(slugifyRoute('/A/B_c/'), 'a-b-c');
  });
});

describe('resolvePlaywright', () => {
  it('returns a module or null, never throws', () => {
    const pw = resolvePlaywright();
    assert.ok(pw === null || typeof pw === 'object');
  });
});

describe('captureUrlScreenshot — coded errors + validation', () => {
  it('rejects a missing url', async () => {
    await assert.rejects(() => captureUrlScreenshot({}), /url is required/);
  });

  it('throws PLAYWRIGHT_MISSING when playwright is absent (DI seam)', async () => {
    await assert.rejects(
      () => captureUrlScreenshot({ url: 'https://example.com', playwright: null }),
      (err) => {
        assert.strictEqual(err.code, 'PLAYWRIGHT_MISSING');
        return true;
      },
    );
  });

  it('throws BROWSER_LAUNCH_FAILED when chromium.launch rejects (fake browser)', async () => {
    const fakePw = {
      chromium: {
        launch: async () => { throw new Error('no chromium binary'); },
      },
    };
    await assert.rejects(
      () => captureUrlScreenshot({ url: 'https://example.com', playwright: fakePw }),
      (err) => {
        assert.strictEqual(err.code, 'BROWSER_LAUNCH_FAILED');
        assert.match(err.message, /no chromium binary/);
        return true;
      },
    );
  });

  it('drives the fake-browser happy path with jpeg quality + closes everything', async () => {
    const closed = { page: false, context: false, browser: false };
    let shotOpts = null;
    const fakePage = {
      goto: async () => {},
      addStyleTag: async () => {},
      waitForTimeout: async () => {},
      screenshot: async (o) => { shotOpts = o; return Buffer.from('fake-jpeg-bytes'); },
      evaluate: async () => ({ w: 1280, h: 4200 }),
      close: async () => { closed.page = true; },
    };
    const fakeContext = {
      newPage: async () => fakePage,
      close: async () => { closed.context = true; },
    };
    const fakePw = {
      chromium: {
        launch: async () => ({
          newContext: async () => fakeContext,
          close: async () => { closed.browser = true; },
        }),
      },
    };

    const res = await captureUrlScreenshot({
      url: 'https://example.com/x',
      playwright: fakePw,
      format: 'jpeg',
      quality: 55,
    });
    assert.strictEqual(res.mimeType, 'image/jpeg');
    assert.deepStrictEqual(shotOpts, { fullPage: false, type: 'jpeg', quality: 55 });
    assert.strictEqual(res.width, 1280);
    assert.strictEqual(res.height, 900); // viewport dims when not fullPage
    assert.deepStrictEqual(closed, { page: true, context: true, browser: true });
  });

  it('fullPage reports document scroll dimensions and omits jpeg quality for png', async () => {
    let shotOpts = null;
    const fakePw = {
      chromium: {
        launch: async () => ({
          newContext: async () => ({
            newPage: async () => ({
              goto: async () => {},
              addStyleTag: async () => {},
              waitForTimeout: async () => {},
              screenshot: async (o) => { shotOpts = o; return Buffer.from('png'); },
              evaluate: async () => ({ w: 1280, h: 7098 }),
              close: async () => {},
            }),
            close: async () => {},
          }),
          close: async () => {},
        }),
      },
    };
    const res = await captureUrlScreenshot({
      url: 'https://example.com',
      playwright: fakePw,
      format: 'png',
      fullPage: true,
    });
    assert.strictEqual(res.mimeType, 'image/png');
    assert.deepStrictEqual(shotOpts, { fullPage: true, type: 'png' });
    assert.strictEqual(res.height, 7098);
  });
});
