'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');

const PerformanceBudgetModule = require('../src/modules/performance-budget.js');
const { median, DEFAULT_BUDGETS } = PerformanceBudgetModule;

test('module exports a class with the expected name', () => {
  const m = new PerformanceBudgetModule();
  assert.equal(m.name, 'performanceBudget');
  assert.equal(typeof m.run, 'function');
  assert.ok(m.description && m.description.length > 0);
});

test('run() returns gracefully when no URL is configured', async () => {
  const m = new PerformanceBudgetModule();
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
  const config = { getModuleConfig: () => ({}), get: () => undefined };
  await m.run(result, config);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].name, 'performance-budget:config');
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
    const m = new PerformanceBudgetModule();
    const checks = [];
    const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
    const config = { getModuleConfig: () => ({ url: 'https://example.com' }), get: () => undefined };
    await m.run(result, config);
    assert.equal(checks.length, 1);
    assert.equal(checks[0].name, 'performance-budget:playwright-missing');
  } finally {
    Module._resolveFilename = originalResolve;
  }
});

test('module file does not import playwright at the top level', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'performance-budget.js'), 'utf-8');
  const topLevelImports = src
    .split('\n')
    .filter((line) => /^\s*(const|let|var)\s+.*=\s*require\(['"]playwright['"]\)/.test(line));
  assert.equal(topLevelImports.length, 0);
});

test('module registers in the built-in modules map and suites', () => {
  const registry = require('../src/core/registry.js');
  assert.ok(registry.BUILT_IN_MODULES.performanceBudget);
  const { DEFAULT_CONFIG } = require('../src/core/config.js');
  assert.ok(DEFAULT_CONFIG.suites.web.includes('performanceBudget'));
  assert.ok(DEFAULT_CONFIG.suites.wp.includes('performanceBudget'));
});

test('median() handles odd and even length arrays', () => {
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([5]), 5);
  assert.equal(median([3, 1, 2]), 2);
});

// ── _checkRoute end-to-end via a fake browser ──────────────────────────

function makeFakePage({ ttfbMs, lcpMs, clsScore, clsShiftCount, contentLengths, shouldThrow }) {
  const responseHandlers = [];
  return {
    on: (event, handler) => { if (event === 'response') responseHandlers.push(handler); },
    addInitScript: async () => {},
    goto: async () => {
      if (shouldThrow) throw new Error('navigation failed');
      for (const len of contentLengths || []) {
        responseHandlers.forEach((h) => h({ headers: () => ({ 'content-length': String(len) }) }));
      }
    },
    waitForTimeout: async () => {},
    evaluate: async (fn) => {
      const src = fn.toString();
      if (src.includes('getEntriesByType')) return { responseStart: ttfbMs, requestStart: 0 };
      if (src.includes('__gatetestVitals')) return { lcp: lcpMs, cls: clsScore, clsShiftCount: clsShiftCount || 0 };
      return null;
    },
    close: async () => {},
  };
}

function makeFakeBrowser(pageOpts) {
  return {
    newContext: async () => ({
      newPage: async () => makeFakePage(pageOpts),
      close: async () => {},
    }),
  };
}

test('_checkRoute passes when all metrics are within budget', async () => {
  const m = new PerformanceBudgetModule();
  const browser = makeFakeBrowser({ ttfbMs: 200, lcpMs: 1200, clsScore: 0.02, contentLengths: [50000] });
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };

  await m._checkRoute({ browser, baseUrl: 'https://example.com', route: '/', runs: 1, budgets: DEFAULT_BUDGETS, timeout: 5000, result });

  assert.equal(checks.length, 1);
  assert.equal(checks[0].passed, true);
  assert.equal(checks[0].details.severity, 'info');
});

test('_checkRoute fails when TTFB exceeds budget', async () => {
  const m = new PerformanceBudgetModule();
  const browser = makeFakeBrowser({ ttfbMs: 1500, lcpMs: 1200, clsScore: 0.02, contentLengths: [50000] });
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };

  await m._checkRoute({ browser, baseUrl: 'https://example.com', route: '/', runs: 1, budgets: DEFAULT_BUDGETS, timeout: 5000, result });

  assert.equal(checks[0].passed, false);
  assert.equal(checks[0].details.severity, 'error');
  assert.match(checks[0].details.message, /TTFB/);
});

test('_checkRoute fails when LCP, CLS, and page weight all exceed budget', async () => {
  const m = new PerformanceBudgetModule();
  const browser = makeFakeBrowser({ ttfbMs: 100, lcpMs: 4000, clsScore: 0.3, contentLengths: [3 * 1024 * 1024] });
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };

  await m._checkRoute({ browser, baseUrl: 'https://example.com', route: '/', runs: 1, budgets: DEFAULT_BUDGETS, timeout: 5000, result });

  assert.equal(checks[0].passed, false);
  assert.match(checks[0].details.message, /LCP/);
  assert.match(checks[0].details.message, /CLS/);
  assert.match(checks[0].details.message, /page weight/);
});

// ── False-positive elimination: distinguishing single-thrash vs animation-driven CLS ──

test('_checkRoute annotates a CLS budget failure caused by many small shifts as likely animation-driven', async () => {
  const m = new PerformanceBudgetModule();
  const browser = makeFakeBrowser({ ttfbMs: 100, lcpMs: 1200, clsScore: 0.3, clsShiftCount: 12, contentLengths: [50000] });
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };

  await m._checkRoute({ browser, baseUrl: 'https://example.com', route: '/', runs: 1, budgets: DEFAULT_BUDGETS, timeout: 5000, result });

  assert.equal(checks[0].passed, false);
  assert.match(checks[0].details.message, /12 separate shifts/);
  assert.match(checks[0].details.suggestion, /carousel\/marquee\/entrance-animation/);
});

test('_checkRoute does NOT add the animation note for a CLS failure from a single large shift', async () => {
  const m = new PerformanceBudgetModule();
  const browser = makeFakeBrowser({ ttfbMs: 100, lcpMs: 1200, clsScore: 0.3, clsShiftCount: 1, contentLengths: [50000] });
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };

  await m._checkRoute({ browser, baseUrl: 'https://example.com', route: '/', runs: 1, budgets: DEFAULT_BUDGETS, timeout: 5000, result });

  assert.equal(checks[0].passed, false);
  assert.doesNotMatch(checks[0].details.message, /separate shifts/);
  assert.doesNotMatch(checks[0].details.suggestion, /carousel/);
});

test('_checkRoute does not change pass/fail based on clsShiftCount — it is diagnostic only', async () => {
  const m = new PerformanceBudgetModule();
  // CLS score itself is within budget even though shift count is high —
  // must still PASS. clsShiftCount is context for a failure, not a
  // separate budget dimension of its own.
  const browser = makeFakeBrowser({ ttfbMs: 100, lcpMs: 1200, clsScore: 0.02, clsShiftCount: 20, contentLengths: [50000] });
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };

  await m._checkRoute({ browser, baseUrl: 'https://example.com', route: '/', runs: 1, budgets: DEFAULT_BUDGETS, timeout: 5000, result });

  assert.equal(checks[0].passed, true);
});

test('_checkRoute reports a warning when every measurement run fails to load', async () => {
  const m = new PerformanceBudgetModule();
  const browser = makeFakeBrowser({ shouldThrow: true });
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };

  await m._checkRoute({ browser, baseUrl: 'https://example.com', route: '/', runs: 2, budgets: DEFAULT_BUDGETS, timeout: 5000, result });

  assert.equal(checks.length, 1);
  assert.equal(checks[0].passed, false);
  assert.equal(checks[0].details.severity, 'warning');
});
