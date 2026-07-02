'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const VisualRegressionModule = require('../src/modules/visual-regression.js');

test('module exports a class with the expected name', () => {
  const m = new VisualRegressionModule();
  assert.equal(m.name, 'visualRegression');
  assert.equal(typeof m.run, 'function');
  assert.ok(m.description && m.description.length > 0);
});

test('run() returns gracefully when no URL is configured', async () => {
  const m = new VisualRegressionModule();
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
  const config = { getModuleConfig: () => ({}), get: () => undefined, projectRoot: process.cwd() };
  await m.run(result, config);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].name, 'visual-regression:config');
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
    const m = new VisualRegressionModule();
    const checks = [];
    const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
    const config = {
      getModuleConfig: () => ({ url: 'https://example.com' }),
      get: () => undefined,
      projectRoot: process.cwd(),
    };
    await m.run(result, config);
    assert.equal(checks.length, 1);
    assert.equal(checks[0].name, 'visual-regression:playwright-missing');
    assert.equal(checks[0].details.severity, 'info');
  } finally {
    Module._resolveFilename = originalResolve;
  }
});

test('module file does not import playwright at the top level', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'visual-regression.js'), 'utf-8');
  assert.ok(src.includes('playwright'), 'module should reference playwright');
  const topLevelImports = src
    .split('\n')
    .filter((line) => /^\s*(const|let|var)\s+.*=\s*require\(['"]playwright['"]\)/.test(line));
  assert.equal(topLevelImports.length, 0, 'playwright must only be required lazily inside run()');
});

test('module registers in the built-in modules map by name "visualRegression"', () => {
  const registry = require('../src/core/registry.js');
  assert.ok(registry.BUILT_IN_MODULES, 'BUILT_IN_MODULES must be exported');
  assert.ok(registry.BUILT_IN_MODULES.visualRegression, 'visualRegression must be in BUILT_IN_MODULES');
});

test('module is included in the "web" suite', () => {
  const { DEFAULT_CONFIG } = require('../src/core/config.js');
  const web = DEFAULT_CONFIG && DEFAULT_CONFIG.suites && DEFAULT_CONFIG.suites.web;
  assert.ok(Array.isArray(web), 'web suite must be defined');
  assert.ok(web.includes('visualRegression'), 'visualRegression must be in the web suite');
});

test('module is included in the "wp" suite', () => {
  const { DEFAULT_CONFIG } = require('../src/core/config.js');
  const wp = DEFAULT_CONFIG && DEFAULT_CONFIG.suites && DEFAULT_CONFIG.suites.wp;
  assert.ok(Array.isArray(wp), 'wp suite must be defined');
  assert.ok(wp.includes('visualRegression'), 'visualRegression must be in the wp suite');
});

test('module instantiates without errors', () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-regression-test-'));
  try {
    const m = new VisualRegressionModule();
    assert.ok(m);
  } finally {
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('_checkRoute creates a baseline on first run without failing the check', async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-regression-baseline-'));
  try {
    const m = new VisualRegressionModule();
    const { PNG } = require('pngjs');
    const png = new PNG({ width: 4, height: 4 });
    png.data.fill(200);
    const buffer = PNG.sync.write(png);

    const fakeBrowser = {
      newContext: async () => ({
        newPage: async () => ({
          goto: async () => {},
          addStyleTag: async () => {},
          waitForTimeout: async () => {},
          screenshot: async () => buffer,
          close: async () => {},
        }),
        close: async () => {},
      }),
    };

    const checks = [];
    const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };

    await m._checkRoute({
      browser: fakeBrowser,
      baseUrl: 'https://example.com',
      route: '/',
      viewport: { name: 'desktop', width: 4, height: 4 },
      platform: 'example',
      baselineDir: tmpdir,
      threshold: 5,
      waitMs: 0,
      maskSelectors: [],
      moduleCfg: {},
      result,
    });

    assert.equal(checks.length, 1);
    assert.equal(checks[0].passed, true);
    assert.equal(checks[0].details.severity, 'info');
    assert.ok(fs.existsSync(path.join(tmpdir, 'example', 'desktop', 'index.png')));
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('_checkRoute fails the check when diff exceeds threshold against an existing baseline', async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-regression-diff-'));
  try {
    const m = new VisualRegressionModule();
    const { PNG } = require('pngjs');

    const baselinePng = new PNG({ width: 4, height: 4 });
    baselinePng.data.fill(255);
    const baselineBuffer = PNG.sync.write(baselinePng);

    const viewportDir = path.join(tmpdir, 'example', 'desktop');
    fs.mkdirSync(viewportDir, { recursive: true });
    fs.writeFileSync(path.join(viewportDir, 'index.png'), baselineBuffer);

    const currentPng = new PNG({ width: 4, height: 4 });
    currentPng.data.fill(0);
    for (let i = 3; i < currentPng.data.length; i += 4) currentPng.data[i] = 255;
    const currentBuffer = PNG.sync.write(currentPng);

    const fakeBrowser = {
      newContext: async () => ({
        newPage: async () => ({
          goto: async () => {},
          addStyleTag: async () => {},
          waitForTimeout: async () => {},
          screenshot: async () => currentBuffer,
          close: async () => {},
        }),
        close: async () => {},
      }),
    };

    const checks = [];
    const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };

    await m._checkRoute({
      browser: fakeBrowser,
      baseUrl: 'https://example.com',
      route: '/',
      viewport: { name: 'desktop', width: 4, height: 4 },
      platform: 'example',
      baselineDir: tmpdir,
      threshold: 5,
      waitMs: 0,
      maskSelectors: [],
      moduleCfg: {},
      result,
    });

    assert.equal(checks.length, 1);
    assert.equal(checks[0].passed, false);
    assert.equal(checks[0].details.severity, 'error');
    assert.ok(checks[0].details.diffPercent > 5);
    assert.ok(fs.existsSync(path.join(viewportDir, 'current', 'index.png')));
    assert.ok(fs.existsSync(path.join(viewportDir, 'diff', 'index.png')));
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('_checkRoute passes when diff is within threshold', async () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-regression-pass-'));
  try {
    const m = new VisualRegressionModule();
    const { PNG } = require('pngjs');

    const png = new PNG({ width: 10, height: 10 });
    png.data.fill(255);
    for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
    const buffer = PNG.sync.write(png);

    const viewportDir = path.join(tmpdir, 'example', 'desktop');
    fs.mkdirSync(viewportDir, { recursive: true });
    fs.writeFileSync(path.join(viewportDir, 'index.png'), buffer);

    const fakeBrowser = {
      newContext: async () => ({
        newPage: async () => ({
          goto: async () => {},
          addStyleTag: async () => {},
          waitForTimeout: async () => {},
          screenshot: async () => buffer,
          close: async () => {},
        }),
        close: async () => {},
      }),
    };

    const checks = [];
    const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };

    await m._checkRoute({
      browser: fakeBrowser,
      baseUrl: 'https://example.com',
      route: '/',
      viewport: { name: 'desktop', width: 10, height: 10 },
      platform: 'example',
      baselineDir: tmpdir,
      threshold: 5,
      waitMs: 0,
      maskSelectors: [],
      moduleCfg: {},
      result,
    });

    assert.equal(checks.length, 1);
    assert.equal(checks[0].passed, true);
    assert.equal(checks[0].details.diffPercent, 0);
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});

// ── False-positive reduction: auto-masking dynamic content ──────────────

test('_resolveMaskSelectors includes the default dynamic-content selectors by default (no config needed)', () => {
  const m = new VisualRegressionModule();
  const resolved = m._resolveMaskSelectors({});
  assert.ok(resolved.includes('[aria-live]'));
  assert.ok(resolved.includes('[class*="timestamp" i]'));
});

test('_resolveMaskSelectors merges user maskSelectors with the auto-mask defaults, not replacing them', () => {
  const m = new VisualRegressionModule();
  const resolved = m._resolveMaskSelectors({ maskSelectors: ['.custom-widget'] });
  assert.ok(resolved.includes('.custom-widget'));
  assert.ok(resolved.includes('[aria-live]'), 'user selectors must not replace the defaults');
});

test('_resolveMaskSelectors returns ONLY user selectors when autoMaskDynamicContent is explicitly disabled', () => {
  const m = new VisualRegressionModule();
  const resolved = m._resolveMaskSelectors({ maskSelectors: ['.custom-widget'], autoMaskDynamicContent: false });
  assert.deepEqual(resolved, ['.custom-widget']);
});

test('_captureScreenshot injects CSS for whatever maskSelectors it is given', async () => {
  const m = new VisualRegressionModule();
  const styleTags = [];
  const fakeBrowser = {
    newContext: async () => ({
      newPage: async () => ({
        goto: async () => {},
        addStyleTag: async (opts) => { styleTags.push(opts.content); },
        waitForTimeout: async () => {},
        screenshot: async () => Buffer.from([]),
        close: async () => {},
      }),
      close: async () => {},
    }),
  };
  const resolved = m._resolveMaskSelectors({});
  await m._captureScreenshot(fakeBrowser, 'https://example.com', '/', { width: 4, height: 4 }, 0, resolved, false);
  assert.equal(styleTags.length, 1);
  assert.match(styleTags[0], /\[aria-live\]/);
  assert.match(styleTags[0], /\[class\*="timestamp" i\]/);
});

test('_maskDynamicTextContent hides leaf elements whose text reads like a relative timestamp', async () => {
  const m = new VisualRegressionModule();
  const hidden = [];
  const fakePage = {
    evaluate: async (fn, arg) => {
      // Simulate the DOM-side logic being exercised with a controlled element set.
      const elements = [
        { text: '2 minutes ago', hide: false },
        { text: 'Contact us', hide: false },
        { text: 'just now', hide: false },
        { text: 'Open 9:00 AM - 5:00 PM', hide: false },
        { text: '12:34:56', hide: false },
      ];
      const patterns = arg.map((p) => new RegExp(p, 'i'));
      for (const el of elements) {
        if (patterns.some((re) => re.test(el.text))) { el.hide = true; hidden.push(el.text); }
      }
    },
  };
  await m._maskDynamicTextContent(fakePage);
  assert.ok(hidden.includes('2 minutes ago'));
  assert.ok(hidden.includes('just now'));
  assert.ok(hidden.includes('12:34:56'));
  assert.ok(!hidden.includes('Contact us'), 'static content must not be masked');
  assert.ok(!hidden.includes('Open 9:00 AM - 5:00 PM'), 'business hours (bare HH:MM) must not be masked — too common in real static content');
});

test('_checkRoute passes autoMaskDynamicContent=false through to _captureScreenshot when configured off', async () => {
  const m = new VisualRegressionModule();
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-regression-automask-'));
  try {
    let receivedAutoMask;
    const originalCapture = m._captureScreenshot.bind(m);
    m._captureScreenshot = async (...args) => {
      receivedAutoMask = args[6];
      return originalCapture(...args.slice(0, 5), args[5], false);
    };
    const { PNG } = require('pngjs');
    const png = new PNG({ width: 4, height: 4 });
    const buffer = PNG.sync.write(png);
    const fakeBrowser = {
      newContext: async () => ({
        newPage: async () => ({
          goto: async () => {},
          addStyleTag: async () => {},
          waitForTimeout: async () => {},
          screenshot: async () => buffer,
          close: async () => {},
        }),
        close: async () => {},
      }),
    };
    const checks = [];
    const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
    await m._checkRoute({
      browser: fakeBrowser, baseUrl: 'https://example.com', route: '/',
      viewport: { name: 'desktop', width: 4, height: 4 }, platform: 'example',
      baselineDir: tmpdir, threshold: 5, waitMs: 0, maskSelectors: [],
      moduleCfg: { autoMaskDynamicContent: false }, result,
    });
    assert.equal(receivedAutoMask, false);
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});
