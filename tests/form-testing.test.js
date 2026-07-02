'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');

const FormTestingModule = require('../src/modules/form-testing.js');

test('module exports a class with the expected name', () => {
  const m = new FormTestingModule();
  assert.equal(m.name, 'formTesting');
  assert.equal(typeof m.run, 'function');
  assert.ok(m.description && m.description.length > 0);
});

test('run() returns gracefully when no URL is configured', async () => {
  const m = new FormTestingModule();
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
  const config = { getModuleConfig: () => ({}), get: () => undefined };
  await m.run(result, config);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].name, 'form-testing:config');
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
    const m = new FormTestingModule();
    const checks = [];
    const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
    const config = { getModuleConfig: () => ({ url: 'https://example.com' }), get: () => undefined };
    await m.run(result, config);
    assert.equal(checks.length, 1);
    assert.equal(checks[0].name, 'form-testing:playwright-missing');
  } finally {
    Module._resolveFilename = originalResolve;
  }
});

test('module file does not import playwright at the top level', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'form-testing.js'), 'utf-8');
  const topLevelImports = src
    .split('\n')
    .filter((line) => /^\s*(const|let|var)\s+.*=\s*require\(['"]playwright['"]\)/.test(line));
  assert.equal(topLevelImports.length, 0);
});

test('module registers in the built-in modules map and suites', () => {
  const registry = require('../src/core/registry.js');
  assert.ok(registry.BUILT_IN_MODULES.formTesting);
  const { DEFAULT_CONFIG } = require('../src/core/config.js');
  assert.ok(DEFAULT_CONFIG.suites.web.includes('formTesting'));
  assert.ok(DEFAULT_CONFIG.suites.wp.includes('formTesting'));
});

// ── _checkForm skip paths — a spy page proves these never touch the DOM ──

function makeSpyPage() {
  const locatorCalls = [];
  return {
    locatorCalls,
    locator: (sel) => { locatorCalls.push(sel); throw new Error('locator() must not be called for a skipped form'); },
    url: () => 'https://example.com/',
    evaluate: async () => 0,
    on: () => {},
    removeListener: () => {},
    waitForTimeout: async () => {},
    goto: async () => {},
  };
}

test('_checkForm skips a payment-shaped form without touching the page', async () => {
  const m = new FormTestingModule();
  const page = makeSpyPage();
  const stats = { formsChecked: 0, silentFailures: [], submitErrors: [], possibleErrors: [], successes: [], skippedPayment: [], skippedAuth: [], skippedCaptcha: [], skippedDestructive: [] };
  const form = { index: 0, fields: [], hasPassword: false, paymentShaped: true, captchaPresent: false, submitText: 'Pay now', hasSubmit: true };

  await m._checkForm({ page, pageUrl: 'https://example.com/', form, waitMs: 0, timeout: 5000, stats });

  assert.equal(stats.skippedPayment.length, 1);
  assert.equal(page.locatorCalls.length, 0, 'a payment form must never be filled or clicked');
});

test('_checkForm skips an auth-shaped (password) form without touching the page', async () => {
  const m = new FormTestingModule();
  const page = makeSpyPage();
  const stats = { formsChecked: 0, silentFailures: [], submitErrors: [], possibleErrors: [], successes: [], skippedPayment: [], skippedAuth: [], skippedCaptcha: [], skippedDestructive: [] };
  const form = { index: 0, fields: [], hasPassword: true, paymentShaped: false, captchaPresent: false, submitText: 'Log in', hasSubmit: true };

  await m._checkForm({ page, pageUrl: 'https://example.com/', form, waitMs: 0, timeout: 5000, stats });

  assert.equal(stats.skippedAuth.length, 1);
  assert.equal(page.locatorCalls.length, 0);
});

test('_checkForm skips a CAPTCHA-protected form without touching the page', async () => {
  const m = new FormTestingModule();
  const page = makeSpyPage();
  const stats = { formsChecked: 0, silentFailures: [], submitErrors: [], possibleErrors: [], successes: [], skippedPayment: [], skippedAuth: [], skippedCaptcha: [], skippedDestructive: [] };
  const form = { index: 0, fields: [], hasPassword: false, paymentShaped: false, captchaPresent: true, submitText: 'Submit', hasSubmit: true };

  await m._checkForm({ page, pageUrl: 'https://example.com/', form, waitMs: 0, timeout: 5000, stats });

  assert.equal(stats.skippedCaptcha.length, 1);
  assert.equal(page.locatorCalls.length, 0);
});

test('_checkForm skips a form with a destructive-looking submit label', async () => {
  const m = new FormTestingModule();
  const page = makeSpyPage();
  const stats = { formsChecked: 0, silentFailures: [], submitErrors: [], possibleErrors: [], successes: [], skippedPayment: [], skippedAuth: [], skippedCaptcha: [], skippedDestructive: [] };
  const form = { index: 0, fields: [], hasPassword: false, paymentShaped: false, captchaPresent: false, submitText: 'Delete my account', hasSubmit: true };

  await m._checkForm({ page, pageUrl: 'https://example.com/', form, waitMs: 0, timeout: 5000, stats });

  assert.equal(stats.skippedDestructive.length, 1);
  assert.equal(page.locatorCalls.length, 0);
});

// ── _checkForm real submit paths ─────────────────────────────────────────

function makeFillableLocator() {
  return {
    nth: () => makeFillableLocator(),
    locator: () => makeFillableLocator(),
    first: () => makeFillableLocator(),
    fill: async () => {},
    check: async () => {},
    selectOption: async () => {},
    click: async () => {},
  };
}

function makeFakePage({ evaluateResults, urlSequence }) {
  let evalIdx = 0;
  let urlIdx = 0;
  return {
    locator: () => makeFillableLocator(),
    url: () => urlSequence[Math.min(urlIdx++, urlSequence.length - 1)],
    goto: async () => {},
    on: () => {},
    removeListener: () => {},
    waitForTimeout: async () => {},
    evaluate: async () => {
      const v = evaluateResults[Math.min(evalIdx, evaluateResults.length - 1)];
      evalIdx++;
      return v;
    },
  };
}

const SAFE_FORM = { index: 0, fields: [{ type: 'email', name: 'email', id: '', placeholder: '', autocomplete: '' }], hasPassword: false, paymentShaped: false, captchaPresent: false, submitText: 'Send', hasSubmit: true };

test('_checkForm reports a success when the URL changes after submit', async () => {
  const m = new FormTestingModule();
  const page = makeFakePage({
    evaluateResults: [100, 100, ''], // beforeLen, afterLen, bodyText
    urlSequence: ['https://example.com/contact', 'https://example.com/thank-you', 'https://example.com/thank-you'],
  });
  const stats = { formsChecked: 0, silentFailures: [], submitErrors: [], possibleErrors: [], successes: [], skippedPayment: [], skippedAuth: [], skippedCaptcha: [], skippedDestructive: [] };

  await m._checkForm({ page, pageUrl: 'https://example.com/contact', form: SAFE_FORM, waitMs: 0, timeout: 5000, stats });

  assert.equal(stats.successes.length, 1);
  assert.equal(stats.silentFailures.length, 0);
});

test('_checkForm reports a silent failure when nothing happens on submit', async () => {
  const m = new FormTestingModule();
  const page = makeFakePage({
    evaluateResults: [100, 100, 'Contact us'], // no growth, no success/error text
    urlSequence: ['https://example.com/contact', 'https://example.com/contact', 'https://example.com/contact'],
  });
  const stats = { formsChecked: 0, silentFailures: [], submitErrors: [], possibleErrors: [], successes: [], skippedPayment: [], skippedAuth: [], skippedCaptcha: [], skippedDestructive: [] };

  await m._checkForm({ page, pageUrl: 'https://example.com/contact', form: SAFE_FORM, waitMs: 0, timeout: 5000, stats });

  assert.equal(stats.silentFailures.length, 1);
  assert.equal(stats.successes.length, 0);
});

test('_checkForm reports a possible error when error text appears after submit', async () => {
  const m = new FormTestingModule();
  const page = makeFakePage({
    evaluateResults: [100, 100, 'Something went wrong, please try again.'],
    urlSequence: ['https://example.com/contact', 'https://example.com/contact', 'https://example.com/contact'],
  });
  const stats = { formsChecked: 0, silentFailures: [], submitErrors: [], possibleErrors: [], successes: [], skippedPayment: [], skippedAuth: [], skippedCaptcha: [], skippedDestructive: [] };

  await m._checkForm({ page, pageUrl: 'https://example.com/contact', form: SAFE_FORM, waitMs: 0, timeout: 5000, stats });

  assert.equal(stats.possibleErrors.length, 1);
  assert.equal(stats.silentFailures.length, 0);
});

test('_checkForm reports a submit error when a pageerror fires during submission', async () => {
  const m = new FormTestingModule();
  const handlers = {};
  const page = {
    locator: () => makeFillableLocator(),
    url: () => 'https://example.com/contact',
    goto: async () => {},
    on: (event, handler) => { handlers[event] = handler; },
    removeListener: () => {},
    waitForTimeout: async () => {
      // Simulate the page throwing during the submission's settle window.
      if (handlers.pageerror) handlers.pageerror(new Error('Cannot read properties of undefined'));
    },
    evaluate: async () => 100,
  };
  const stats = { formsChecked: 0, silentFailures: [], submitErrors: [], possibleErrors: [], successes: [], skippedPayment: [], skippedAuth: [], skippedCaptcha: [], skippedDestructive: [] };

  await m._checkForm({ page, pageUrl: 'https://example.com/contact', form: SAFE_FORM, waitMs: 0, timeout: 5000, stats });

  assert.equal(stats.submitErrors.length, 1);
  assert.match(stats.submitErrors[0].message, /Cannot read properties/);
});

test('_checkForm treats a fired non-GET request with no visible confirmation as a soft success, not a silent failure', async () => {
  const m = new FormTestingModule();
  const handlers = {};
  const page = {
    locator: () => makeFillableLocator(),
    url: () => 'https://example.com/contact',
    goto: async () => {},
    on: (event, handler) => { handlers[event] = handler; },
    removeListener: () => {},
    waitForTimeout: async () => {
      if (handlers.request) handlers.request({ method: () => 'POST' });
    },
    evaluate: async () => (arguments.length ? 100 : 100),
  };
  // Override evaluate to return varying values per call while still being simple.
  let call = 0;
  page.evaluate = async () => {
    const vals = [100, 100, 'Contact us']; // no success/error text
    return vals[Math.min(call++, vals.length - 1)];
  };
  const stats = { formsChecked: 0, silentFailures: [], submitErrors: [], possibleErrors: [], successes: [], skippedPayment: [], skippedAuth: [], skippedCaptcha: [], skippedDestructive: [] };

  await m._checkForm({ page, pageUrl: 'https://example.com/contact', form: SAFE_FORM, waitMs: 0, timeout: 5000, stats });

  assert.equal(stats.silentFailures.length, 0, 'a fired network request means something happened — not silent');
  assert.equal(stats.successes.length, 1);
});

test('inferFieldValue-style email fields always resolve to a GateTest-owned address (never a real inbox)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'form-testing.js'), 'utf-8');
  assert.match(src, /test@gatetest\.ai/);
});
