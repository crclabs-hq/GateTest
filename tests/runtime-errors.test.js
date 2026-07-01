'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const RuntimeErrorsModule = require('../src/modules/runtime-errors.js');

test('module exports a class with the expected name', () => {
  const m = new RuntimeErrorsModule();
  assert.equal(m.name, 'runtimeErrors');
  assert.equal(typeof m.run, 'function');
  assert.ok(m.description && m.description.length > 0);
});

test('run() returns gracefully when no URL is configured', async () => {
  const m = new RuntimeErrorsModule();
  const checks = [];
  const result = {
    addCheck: (name, passed, details) => checks.push({ name, passed, details }),
  };
  const config = {
    getModuleConfig: () => ({}),
    get: () => undefined,
  };
  await m.run(result, config);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].name, 'runtime-errors:config');
  assert.equal(checks[0].passed, true);
});

test('run() falls back gracefully when playwright is not installed', async () => {
  // Intercept require for the duration of this test
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
    const m = new RuntimeErrorsModule();
    const checks = [];
    const result = {
      addCheck: (name, passed, details) => checks.push({ name, passed, details }),
    };
    const config = {
      getModuleConfig: () => ({ url: 'https://example.com' }),
      get: () => undefined,
    };
    await m.run(result, config);
    assert.equal(checks.length, 1);
    assert.equal(checks[0].name, 'runtime-errors:playwright-missing');
    assert.equal(checks[0].details.severity, 'info');
  } finally {
    Module._resolveFilename = originalResolve;
  }
});

test('module file does not import playwright at the top level', () => {
  // The module must only require playwright INSIDE run() so that
  // loading the module file in environments without playwright doesn't
  // throw at registry init time.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'runtime-errors.js'), 'utf-8');
  // Quick smoke check — playwright should appear in source but not at
  // an unconditional top-level require.
  assert.ok(src.includes('playwright'), 'module should reference playwright');
  // Detect top-level imports of playwright (no leading whitespace).
  const topLevelImports = src
    .split('\n')
    .filter((line) => /^\s*(const|let|var)\s+.*=\s*require\(['"]playwright['"]\)/.test(line));
  assert.equal(topLevelImports.length, 0, 'playwright must only be required inside run() with a try/catch');
});

test('module registers in the built-in modules map by name "runtimeErrors"', () => {
  const registry = require('../src/core/registry.js');
  assert.ok(registry.BUILT_IN_MODULES, 'BUILT_IN_MODULES must be exported');
  assert.ok(registry.BUILT_IN_MODULES.runtimeErrors, 'runtimeErrors must be in BUILT_IN_MODULES');
});

test('module is included in the "web" suite', () => {
  const { DEFAULT_CONFIG } = require('../src/core/config.js');
  const web = DEFAULT_CONFIG && DEFAULT_CONFIG.suites && DEFAULT_CONFIG.suites.web;
  assert.ok(Array.isArray(web), 'web suite must be defined');
  assert.ok(web.includes('runtimeErrors'), 'runtimeErrors must be in the web suite');
});

test('module is included in the "wp" suite', () => {
  const { DEFAULT_CONFIG } = require('../src/core/config.js');
  const wp = DEFAULT_CONFIG && DEFAULT_CONFIG.suites && DEFAULT_CONFIG.suites.wp;
  assert.ok(Array.isArray(wp), 'wp suite must be defined');
  assert.ok(wp.includes('runtimeErrors'), 'runtimeErrors must be in the wp suite');
});

// Smoke test: ensure the module can be instantiated alongside the rest
// of the engine without throwing.
test('module instantiates without errors', () => {
  // Just confirm we can construct the module.
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-errors-test-'));
  try {
    const m = new RuntimeErrorsModule();
    assert.ok(m);
  } finally {
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ── Idle memory-leak detection ──────────────────────────────────────────

function makeFakePage(heapReadings) {
  let call = 0;
  return {
    evaluate: async () => {
      const value = heapReadings[Math.min(call, heapReadings.length - 1)];
      call++;
      return value;
    },
    waitForTimeout: async () => {},
  };
}

test('_checkIdleMemoryGrowth returns null when performance.memory is unavailable', async () => {
  const m = new RuntimeErrorsModule();
  const page = makeFakePage([null, null]);
  const result = await m._checkIdleMemoryGrowth(page, {});
  assert.equal(result, null);
});

test('_checkIdleMemoryGrowth flags significant heap growth while idle as leaking', async () => {
  const m = new RuntimeErrorsModule();
  // 10MB -> 15MB while idle: 50% growth, well over both thresholds.
  const page = makeFakePage([10 * 1024 * 1024, 15 * 1024 * 1024]);
  const result = await m._checkIdleMemoryGrowth(page, { memoryCheckMs: 100 });
  assert.equal(result.leaking, true);
  assert.equal(result.growthBytes, 5 * 1024 * 1024);
  assert.ok(result.growthPct > 15);
});

test('_checkIdleMemoryGrowth does not flag small/stable heap growth', async () => {
  const m = new RuntimeErrorsModule();
  // 50MB -> 50.5MB: 1% growth, below threshold.
  const page = makeFakePage([50 * 1024 * 1024, 50.5 * 1024 * 1024]);
  const result = await m._checkIdleMemoryGrowth(page, {});
  assert.equal(result.leaking, false);
});

test('_checkIdleMemoryGrowth requires BOTH a percentage and an absolute-bytes floor (avoids noise on tiny heaps)', async () => {
  const m = new RuntimeErrorsModule();
  // 1KB -> 2KB is a 100% jump but a trivially small absolute amount —
  // must not be flagged, or every near-empty page would "leak."
  const page = makeFakePage([1024, 2048]);
  const result = await m._checkIdleMemoryGrowth(page, {});
  assert.equal(result.leaking, false);
});

test('_reportCaptured emits a warning check when memoryLeak.leaking is true', () => {
  const m = new RuntimeErrorsModule();
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
  const captured = {
    pageErrors: [], consoleErrors: [], consoleWarnings: [], requestFailures: [],
    cspViolations: [], mixedContent: [], hydration: [], deprecations: [],
    navigationFailure: null, finalUrl: 'https://example.com', status: 200,
    memoryLeak: { initialBytes: 10e6, afterBytes: 15e6, growthBytes: 5e6, growthPct: 50, idleMs: 4000, leaking: true },
  };
  m._reportCaptured(result, captured, 'https://example.com');
  const leakCheck = checks.find((c) => c.name === 'runtime-errors:memory-leak');
  assert.ok(leakCheck);
  assert.equal(leakCheck.passed, false);
  assert.equal(leakCheck.details.severity, 'warning');
  assert.match(leakCheck.details.message, /grew/);
});

test('_reportCaptured emits an info check when memory is stable', () => {
  const m = new RuntimeErrorsModule();
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
  const captured = {
    pageErrors: [], consoleErrors: [], consoleWarnings: [], requestFailures: [],
    cspViolations: [], mixedContent: [], hydration: [], deprecations: [],
    navigationFailure: null, finalUrl: 'https://example.com', status: 200,
    memoryLeak: { initialBytes: 10e6, afterBytes: 10.1e6, growthBytes: 0.1e6, growthPct: 1, idleMs: 4000, leaking: false },
  };
  m._reportCaptured(result, captured, 'https://example.com');
  const leakCheck = checks.find((c) => c.name === 'runtime-errors:memory-leak');
  assert.ok(leakCheck);
  assert.equal(leakCheck.passed, true);
  assert.equal(leakCheck.details.severity, 'info');
});

test('_reportCaptured emits nothing memory-related when memoryLeak is null (unsupported browser)', () => {
  const m = new RuntimeErrorsModule();
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
  const captured = {
    pageErrors: [], consoleErrors: [], consoleWarnings: [], requestFailures: [],
    cspViolations: [], mixedContent: [], hydration: [], deprecations: [],
    navigationFailure: null, finalUrl: 'https://example.com', status: 200,
    memoryLeak: null,
  };
  m._reportCaptured(result, captured, 'https://example.com');
  assert.equal(checks.find((c) => c.name === 'runtime-errors:memory-leak'), undefined);
});
