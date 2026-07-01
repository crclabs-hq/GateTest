'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

const InteractiveElementsModule = require('../src/modules/interactive-elements.js');

/** Starts a tiny local server that mishandles HEAD but answers GET fine. */
function startHeadHostileServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'HEAD') {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('module exports a class with the expected name', () => {
  const m = new InteractiveElementsModule();
  assert.equal(m.name, 'interactiveElements');
  assert.equal(typeof m.run, 'function');
  assert.ok(m.description && m.description.length > 0);
});

test('run() returns gracefully when no URL is configured', async () => {
  const m = new InteractiveElementsModule();
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
  const config = { getModuleConfig: () => ({}), get: () => undefined };
  await m.run(result, config);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].name, 'interactive-elements:config');
  assert.equal(checks[0].passed, true);
  assert.equal(checks[0].details.severity, 'info');
});

test('run() falls back gracefully when playwright is not installed', async () => {
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, ...rest) {
    if (request === 'playwright') {
      const err = new Error(`Cannot find module '${request}'`);
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }
    return originalResolve.call(this, request, parent, ...rest);
  };

  try {
    const m = new InteractiveElementsModule();
    const checks = [];
    const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
    const config = { getModuleConfig: () => ({ url: 'https://example.com' }), get: () => undefined };
    await m.run(result, config);
    assert.equal(checks.length, 1);
    assert.equal(checks[0].name, 'interactive-elements:playwright-missing');
    assert.equal(checks[0].details.severity, 'info');
  } finally {
    Module._resolveFilename = originalResolve;
  }
});

test('module file does not import playwright at the top level', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'interactive-elements.js'), 'utf-8');
  assert.ok(src.includes('playwright'), 'module should reference playwright');
  const topLevelImports = src
    .split('\n')
    .filter((line) => /^\s*(const|let|var)\s+.*=\s*require\(['"]playwright['"]\)/.test(line));
  assert.equal(topLevelImports.length, 0, 'playwright must only be required lazily inside run()');
});

test('module registers in the built-in modules map by name "interactiveElements"', () => {
  const registry = require('../src/core/registry.js');
  assert.ok(registry.BUILT_IN_MODULES, 'BUILT_IN_MODULES must be exported');
  assert.ok(registry.BUILT_IN_MODULES.interactiveElements, 'interactiveElements must be in BUILT_IN_MODULES');
});

test('module is included in the "web" suite', () => {
  const { DEFAULT_CONFIG } = require('../src/core/config.js');
  const web = DEFAULT_CONFIG && DEFAULT_CONFIG.suites && DEFAULT_CONFIG.suites.web;
  assert.ok(Array.isArray(web), 'web suite must be defined');
  assert.ok(web.includes('interactiveElements'), 'interactiveElements must be in the web suite');
});

test('module is included in the "wp" suite', () => {
  const { DEFAULT_CONFIG } = require('../src/core/config.js');
  const wp = DEFAULT_CONFIG && DEFAULT_CONFIG.suites && DEFAULT_CONFIG.suites.wp;
  assert.ok(Array.isArray(wp), 'wp suite must be defined');
  assert.ok(wp.includes('interactiveElements'), 'interactiveElements must be in the wp suite');
});

test('module instantiates without errors', () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-elements-test-'));
  try {
    const m = new InteractiveElementsModule();
    assert.ok(m);
  } finally {
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('_checkButtons skips destructive-looking buttons without clicking them', async () => {
  const m = new InteractiveElementsModule();
  const stats = {
    buttonsChecked: 0, deadButtons: [], buttonErrors: [], skippedDestructive: [],
  };
  let clicked = false;
  const fakePage = {
    locator: () => ({
      first: () => ({ click: async () => { clicked = true; } }),
      nth: () => ({ click: async () => { clicked = true; } }),
    }),
    url: () => 'https://example.com/settings',
    evaluate: async () => 0,
    on: () => {},
    removeListener: () => {},
    waitForTimeout: async () => {},
    keyboard: { press: async () => {} },
    goto: async () => {},
  };

  const destructiveButtons = [
    { selector: 'button-idx-1', nthFallback: 1, text: 'Delete Account', description: 'button: "Delete Account"' },
    { selector: 'button-idx-2', nthFallback: 2, text: 'Cancel Subscription', description: 'button: "Cancel Subscription"' },
    { selector: 'button-idx-3', nthFallback: 3, text: 'Sign Out', description: 'button: "Sign Out"' },
  ];

  await m._checkButtons(fakePage, destructiveButtons, 'https://example.com/settings', 5000, stats);

  assert.equal(clicked, false, 'destructive buttons must never be clicked');
  assert.equal(stats.skippedDestructive.length, 3);
  assert.equal(stats.buttonsChecked, 3);
  assert.equal(stats.deadButtons.length, 0);
});

test('_checkButtons clicks an FAQ question containing a destructive keyword instead of safety-skipping it', async () => {
  const m = new InteractiveElementsModule();
  const stats = {
    buttonsChecked: 0, deadButtons: [], buttonErrors: [], skippedDestructive: [],
  };
  let clicked = false;
  const fakePage = {
    locator: () => ({
      first: () => ({ click: async () => { clicked = true; } }),
      nth: () => ({ click: async () => { clicked = true; } }),
    }),
    url: () => 'https://example.com/pricing',
    evaluate: async () => 100,
    on: () => {},
    removeListener: () => {},
    waitForTimeout: async () => {},
    keyboard: { press: async () => {} },
    goto: async () => {},
  };

  const buttons = [
    { selector: 'button-idx-1', nthFallback: 1, text: 'Can I cancel at any time?', description: 'button: "Can I cancel at any time?"' },
  ];
  await m._checkButtons(fakePage, buttons, 'https://example.com/pricing', 5000, stats);

  assert.equal(clicked, true, 'an FAQ question is not a destructive action — it should be click-tested');
  assert.equal(stats.skippedDestructive.length, 0);
});

test('_checkButtons clicks a non-destructive button and detects a dead button', async () => {
  const m = new InteractiveElementsModule();
  const stats = {
    buttonsChecked: 0, deadButtons: [], buttonErrors: [], skippedDestructive: [],
  };
  const fakePage = {
    locator: () => ({
      first: () => ({ click: async () => {} }),
      nth: () => ({ click: async () => {} }),
    }),
    url: () => 'https://example.com/',
    evaluate: async () => 100, // constant body length -> no DOM change, no modals
    on: () => {},
    removeListener: () => {},
    waitForTimeout: async () => {},
    keyboard: { press: async () => {} },
    goto: async () => {},
  };

  const buttons = [{ selector: 'button-idx-1', nthFallback: 1, text: 'Submit', description: 'button: "Submit"' }];
  await m._checkButtons(fakePage, buttons, 'https://example.com/', 5000, stats);

  assert.equal(stats.buttonsChecked, 1);
  assert.equal(stats.skippedDestructive.length, 0);
  assert.equal(stats.deadButtons.length, 1);
  assert.equal(stats.deadButtons[0].description, 'button: "Submit"');
});

test('_checkButtons does not flag a theme-toggle button that only changes <html> class', async () => {
  const m = new InteractiveElementsModule();
  const stats = {
    buttonsChecked: 0, deadButtons: [], buttonErrors: [], skippedDestructive: [],
  };
  let toggled = false;
  const fakePage = {
    locator: () => ({
      first: () => ({ click: async () => { toggled = true; } }),
      nth: () => ({ click: async () => { toggled = true; } }),
    }),
    url: () => 'https://example.com/',
    // Body content never changes; only the <html> root class flips —
    // the classic Tailwind/next-themes dark-mode pattern.
    evaluate: async (fn) => {
      const src = fn.toString();
      if (src.includes('innerHTML.length')) return 100;
      if (src.includes('documentElement')) return toggled ? 'dark|null|' : '|null|';
      return 0;
    },
    on: () => {},
    removeListener: () => {},
    waitForTimeout: async () => {},
    keyboard: { press: async () => {} },
    goto: async () => {},
  };

  const buttons = [{ selector: 'button-idx-1', nthFallback: 1, text: 'Toggle colour theme', description: 'button: "Toggle colour theme"' }];
  await m._checkButtons(fakePage, buttons, 'https://example.com/', 5000, stats);

  assert.equal(stats.deadButtons.length, 0, 'a root-level class toggle must count as "something happened"');
});

test('_checkButtons does not report a hover-only mega-nav trigger as a dead button', async () => {
  const m = new InteractiveElementsModule();
  const stats = {
    buttonsChecked: 0, deadButtons: [], hoverOnlyButtons: [], buttonErrors: [], skippedDestructive: [],
  };
  let hovered = false;
  const fakeLocator = {
    click: async () => { /* click does nothing — no handler at all */ },
    hover: async () => { hovered = true; },
  };
  const fakePage = {
    locator: () => ({ first: () => fakeLocator, nth: () => fakeLocator }),
    url: () => 'https://example.com/',
    evaluate: async (fn) => {
      const src = fn.toString();
      if (src.includes('innerHTML.length')) return 100; // body content never changes
      // documentElement class flips ONLY once hovered — a CSS :hover mega-nav panel.
      if (src.includes('documentElement')) return hovered ? 'nav-open' : '';
      return 0;
    },
    on: () => {},
    removeListener: () => {},
    waitForTimeout: async () => {},
    keyboard: { press: async () => {} },
    goto: async () => {},
    mouse: { move: async () => {} },
  };

  const buttons = [{ selector: 'button-idx-1', nthFallback: 1, text: 'Products', description: 'button: "Products"' }];
  await m._checkButtons(fakePage, buttons, 'https://example.com/', 5000, stats);

  assert.equal(stats.deadButtons.length, 0, 'a hover-revealed trigger must not be reported as dead');
  assert.equal(stats.hoverOnlyButtons.length, 1);
  assert.equal(stats.hoverOnlyButtons[0].description, 'button: "Products"');
});

test('_checkButtons still reports a genuinely dead button when hover ALSO does nothing', async () => {
  const m = new InteractiveElementsModule();
  const stats = {
    buttonsChecked: 0, deadButtons: [], hoverOnlyButtons: [], buttonErrors: [], skippedDestructive: [],
  };
  const fakeLocator = { click: async () => {}, hover: async () => {} };
  const fakePage = {
    locator: () => ({ first: () => fakeLocator, nth: () => fakeLocator }),
    url: () => 'https://example.com/',
    evaluate: async () => 100, // nothing ever changes, click or hover
    on: () => {},
    removeListener: () => {},
    waitForTimeout: async () => {},
    keyboard: { press: async () => {} },
    goto: async () => {},
    mouse: { move: async () => {} },
  };

  const buttons = [{ selector: 'button-idx-1', nthFallback: 1, text: 'Submit', description: 'button: "Submit"' }];
  await m._checkButtons(fakePage, buttons, 'https://example.com/', 5000, stats);

  assert.equal(stats.hoverOnlyButtons.length, 0);
  assert.equal(stats.deadButtons.length, 1, 'a button that does nothing on click OR hover is genuinely dead');
});

test('_checkButtons records a button-error when the click throws a page error', async () => {
  const m = new InteractiveElementsModule();
  const stats = {
    buttonsChecked: 0, deadButtons: [], buttonErrors: [], skippedDestructive: [],
  };
  const fakePage = {
    locator: () => ({
      first: () => ({ click: async () => {} }),
      nth: () => ({ click: async () => {} }),
    }),
    url: () => 'https://example.com/',
    evaluate: async () => 100,
    on: (event, handler) => {
      if (event === 'pageerror') {
        // Simulate an uncaught exception firing synchronously on click.
        setImmediate(() => handler(new Error('Cannot read properties of undefined')));
      }
    },
    removeListener: () => {},
    waitForTimeout: async () => new Promise((resolve) => setImmediate(resolve)),
    keyboard: { press: async () => {} },
    goto: async () => {},
  };

  const buttons = [{ selector: 'button-idx-1', nthFallback: 1, text: 'Load More', description: 'button: "Load More"' }];
  await m._checkButtons(fakePage, buttons, 'https://example.com/', 5000, stats);

  assert.equal(stats.buttonErrors.length, 1);
  assert.match(stats.buttonErrors[0].message, /Cannot read properties/);
  assert.equal(stats.deadButtons.length, 0);
});

test('_checkLinks flags a broken internal link (connection refused) and skips external links', async () => {
  const m = new InteractiveElementsModule();
  const stats = { linksChecked: 0, brokenLinks: [] };
  const checkedLinkUrls = new Set();

  const links = [
    { href: '/dead', absoluteUrl: 'http://127.0.0.1:1/dead', internal: true, text: 'Dead link' },
    { href: 'https://external.example.com/', absoluteUrl: 'https://external.example.com/', internal: false, text: 'External' },
  ];

  await m._checkLinks(links, checkedLinkUrls, 2000, stats);

  assert.equal(stats.linksChecked, 1, 'external links should not be HTTP-checked');
  assert.equal(stats.brokenLinks.length, 1);
  assert.equal(stats.brokenLinks[0].url, 'http://127.0.0.1:1/dead');
});

test('_checkLinks deduplicates repeated URLs across pages', async () => {
  const m = new InteractiveElementsModule();
  const stats = { linksChecked: 0, brokenLinks: [] };
  const checkedLinkUrls = new Set();

  const links = [
    { href: '/dead', absoluteUrl: 'http://127.0.0.1:1/dead', internal: true, text: 'Dead link' },
  ];

  await m._checkLinks(links, checkedLinkUrls, 2000, stats);
  await m._checkLinks(links, checkedLinkUrls, 2000, stats);

  assert.equal(stats.linksChecked, 1, 'the same URL must only be checked once');
  assert.equal(stats.brokenLinks.length, 1);
});

test('_checkLinkLive falls back to GET when a server mishandles HEAD, avoiding a false "broken link"', async () => {
  const server = await startHeadHostileServer();
  try {
    const { port } = server.address();
    const m = new InteractiveElementsModule();
    const status = await m._checkLinkLive(`http://127.0.0.1:${port}/page`, 3000);
    assert.equal(status, 200, 'GET fallback should report the real (working) status, not the broken HEAD response');
  } finally {
    server.close();
  }
});

test('_checkLinks does not flag a link whose HEAD 404s but whose GET succeeds', async () => {
  const server = await startHeadHostileServer();
  try {
    const { port } = server.address();
    const m = new InteractiveElementsModule();
    const stats = { linksChecked: 0, brokenLinks: [] };
    const links = [
      { href: '/page', absoluteUrl: `http://127.0.0.1:${port}/page`, internal: true, text: 'HEAD-hostile page' },
    ];
    await m._checkLinks(links, new Set(), 3000, stats);
    assert.equal(stats.linksChecked, 1);
    assert.equal(stats.brokenLinks.length, 0, 'a HEAD-only quirk must not produce a false broken-link report');
  } finally {
    server.close();
  }
});
