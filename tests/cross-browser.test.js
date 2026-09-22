'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const CrossBrowserModule = require('../src/modules/cross-browser.js');

test('module exports a class with the expected name', () => {
  const m = new CrossBrowserModule();
  assert.equal(m.name, 'crossBrowser');
  assert.equal(typeof m.run, 'function');
  assert.ok(m.description && m.description.length > 0);
});

// Issue #658 item 3: when the module has no way to look at all (no URL
// configured, or no browser engine available), it must report itself
// not-checked — Doctrine #1's three-state rule (clean / found / NOT
// CHECKED) — never a silent `passed: true` info note that coverage
// tooling (deriveModuleCoverage) can't tell apart from "ran, found nothing".

test('run() reports not-checked (never a silent pass) when no URL is configured', async () => {
  const m = new CrossBrowserModule();
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
  const config = { getModuleConfig: () => ({}), get: () => undefined };
  await m.run(result, config);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].name, 'crossBrowser:not-checked');
  assert.equal(checks[0].passed, false);
  assert.equal(checks[0].details.notChecked, true);
  assert.match(checks[0].details.message, /No target URL configured/);
});

test('run() reports not-checked, never a failure, when playwright is not installed', async () => {
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
    const m = new CrossBrowserModule();
    const checks = [];
    const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
    const config = { getModuleConfig: () => ({ url: 'https://example.com' }), get: () => undefined };
    await m.run(result, config);
    assert.equal(checks.length, 1);
    assert.equal(checks[0].name, 'crossBrowser:not-checked');
    assert.equal(checks[0].passed, false);
    assert.equal(checks[0].details.notChecked, true);
    assert.match(checks[0].details.message, /Playwright not available/);
  } finally {
    Module._resolveFilename = originalResolve;
  }
});

test('module registers in the built-in modules map and suites', () => {
  const registry = require('../src/core/registry.js');
  assert.ok(registry.BUILT_IN_MODULES.crossBrowser);
  const { DEFAULT_CONFIG } = require('../src/core/config.js');
  assert.ok(DEFAULT_CONFIG.suites.web.includes('crossBrowser'));
  assert.ok(DEFAULT_CONFIG.suites.wp.includes('crossBrowser'));
});

// ── _report given synthetic per-engine results ───────────────────────────

function okEngine(overrides = {}) {
  return { launched: true, version: '120.0', navigationFailure: null, status: 200, pageErrors: [], consoleErrors: [], screenshotBuffer: null, ...overrides };
}

test('_report flags an engine that fails navigation while the reference engine succeeds', () => {
  const m = new CrossBrowserModule();
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
  const engineResults = {
    chromium: okEngine(),
    firefox: okEngine({ navigationFailure: 'Timeout 20000ms exceeded' }),
    webkit: { launched: false, skipReason: 'Executable does not exist' },
  };
  m._report(result, engineResults, 'https://example.com', {});

  const broken = checks.find((c) => c.name === 'cross-browser:navigation-broken');
  assert.ok(broken);
  assert.equal(broken.details.severity, 'error');
  assert.deepEqual(broken.details.details.map((d) => d.engine), ['firefox']);
});

// Issue #658 item 3: the finding's customer-visible `message` — not just
// the internal `details` field the web-scan finding translators never
// read — must carry the actual error text and the engine version.
test('_report attaches the runtime error text and engine version to navigation-broken as evidence in the message', () => {
  const m = new CrossBrowserModule();
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
  const engineResults = {
    chromium: okEngine({ version: '120.0.1' }),
    firefox: okEngine({ version: '118.0', navigationFailure: 'Timeout 20000ms exceeded while waiting for event "load"' }),
    webkit: { launched: false, skipReason: 'Executable does not exist' },
  };
  m._report(result, engineResults, 'https://example.com', {});

  const broken = checks.find((c) => c.name === 'cross-browser:navigation-broken');
  assert.ok(broken);
  assert.match(broken.details.message, /v118\.0/);
  assert.match(broken.details.message, /Timeout 20000ms exceeded/);
  assert.match(broken.details.message, /v120\.0\.1/); // reference engine version too
  assert.equal(broken.details.details[0].engineVersion, '118.0');
});

test('_report flags engine-specific runtime errors not seen on the reference engine', () => {
  const m = new CrossBrowserModule();
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
  const engineResults = {
    chromium: okEngine({ consoleErrors: ['shared error'] }),
    firefox: okEngine({ consoleErrors: ['shared error', 'firefox-only ReferenceError: foo is not defined'] }),
    webkit: okEngine(),
  };
  m._report(result, engineResults, 'https://example.com', {});

  const specific = checks.find((c) => c.name === 'cross-browser:engine-specific-errors');
  assert.ok(specific);
  assert.equal(specific.details.details[0].engine, 'firefox');
  assert.deepEqual(specific.details.details[0].errors, ['firefox-only ReferenceError: foo is not defined']);
  // Issue #658 item 3: the actual error text is evidence in `message`, not
  // buried only in `details`.
  assert.match(specific.details.message, /firefox-only ReferenceError: foo is not defined/);
  assert.match(specific.details.message, /v120\.0/);
});

test('_report does not flag errors that appear on every engine', () => {
  const m = new CrossBrowserModule();
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
  const engineResults = {
    chromium: okEngine({ consoleErrors: ['shared error'] }),
    firefox: okEngine({ consoleErrors: ['shared error'] }),
    webkit: okEngine({ consoleErrors: ['shared error'] }),
  };
  m._report(result, engineResults, 'https://example.com', {});

  assert.equal(checks.find((c) => c.name === 'cross-browser:engine-specific-errors'), undefined);
});

test('_report reports not-checked (never a failure) when no engine could launch', () => {
  const m = new CrossBrowserModule();
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
  const engineResults = {
    chromium: { launched: false, skipReason: 'no binary' },
    firefox: { launched: false, skipReason: 'no binary' },
    webkit: { launched: false, skipReason: 'no binary' },
  };
  m._report(result, engineResults, 'https://example.com', {});

  assert.ok(checks.find((c) => c.name === 'cross-browser:engines-skipped'));
  const notChecked = checks.find((c) => c.name === 'crossBrowser:not-checked');
  assert.ok(notChecked);
  assert.equal(notChecked.passed, false);
  assert.equal(notChecked.details.notChecked, true);
  assert.equal(checks.find((c) => c.name === 'cross-browser:navigation-broken'), undefined);
});

test('_report skips per-engine gracefully and still compares the engines that did launch', () => {
  const m = new CrossBrowserModule();
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
  const engineResults = {
    chromium: okEngine(),
    firefox: okEngine(),
    webkit: { launched: false, skipReason: 'Executable does not exist' },
  };
  m._report(result, engineResults, 'https://example.com', {});

  assert.ok(checks.find((c) => c.name === 'cross-browser:engines-skipped'));
  const summary = checks.find((c) => c.name === 'cross-browser:summary');
  assert.match(summary.details.message, /2\/3 engine/);
});

test('_report flags a rendering diff above the configured threshold using real PNG buffers', () => {
  const { PNG } = require('pngjs');
  const makePng = (fillR) => {
    const png = new PNG({ width: 4, height: 4 });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = fillR; png.data[i + 1] = 0; png.data[i + 2] = 0; png.data[i + 3] = 255;
    }
    return PNG.sync.write(png);
  };
  const m = new CrossBrowserModule();
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
  const engineResults = {
    chromium: okEngine({ screenshotBuffer: makePng(0) }),
    firefox: okEngine({ screenshotBuffer: makePng(255) }), // maximally different
    webkit: { launched: false, skipReason: 'no binary' },
  };
  m._report(result, engineResults, 'https://example.com', { diffThresholdPercent: 5 });

  const diffCheck = checks.find((c) => c.name === 'cross-browser:rendering-diff');
  assert.ok(diffCheck);
  assert.equal(diffCheck.details.details[0].engine, 'firefox');
  // Issue #658 item 3: diff percent + engine version are evidence in `message`.
  assert.match(diffCheck.details.message, /% pixel diff/);
  assert.match(diffCheck.details.message, /v120\.0/);
});
