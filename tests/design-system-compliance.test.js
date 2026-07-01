'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const DesignSystemComplianceModule = require('../src/modules/design-system-compliance.js');

test('module exports a class with the expected name', () => {
  const m = new DesignSystemComplianceModule();
  assert.equal(m.name, 'designSystemCompliance');
  assert.equal(typeof m.run, 'function');
  assert.ok(m.description && m.description.length > 0);
});

test('run() returns gracefully when no URL is configured', async () => {
  const m = new DesignSystemComplianceModule();
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
  const config = { getModuleConfig: () => ({}), get: () => undefined };
  await m.run(result, config);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].name, 'design-system-compliance:config');
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
    const m = new DesignSystemComplianceModule();
    const checks = [];
    const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
    const config = { getModuleConfig: () => ({ url: 'https://example.com' }), get: () => undefined };
    await m.run(result, config);
    assert.equal(checks.length, 1);
    assert.equal(checks[0].name, 'design-system-compliance:playwright-missing');
  } finally {
    Module._resolveFilename = originalResolve;
  }
});

test('module registers in the built-in modules map and suites', () => {
  const registry = require('../src/core/registry.js');
  assert.ok(registry.BUILT_IN_MODULES.designSystemCompliance);
  const { DEFAULT_CONFIG } = require('../src/core/config.js');
  assert.ok(DEFAULT_CONFIG.suites.web.includes('designSystemCompliance'));
  assert.ok(DEFAULT_CONFIG.suites.wp.includes('designSystemCompliance'));
});

// ── pure aggregation helpers ─────────────────────────────────────────────

test('_findColorDuplicateClusters groups colors within the distance threshold', () => {
  const m = new DesignSystemComplianceModule();
  const colors = new Map([
    ['rgb(26, 26, 26)', 5],
    ['rgb(28, 28, 28)', 3], // distance ~3.46 from the above — should cluster
    ['rgb(255, 0, 0)', 2],  // far away — should not cluster with anything
  ]);
  const clusters = m._findColorDuplicateClusters(colors);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].length, 2);
});

test('_findColorDuplicateClusters returns nothing when all colors are distinct', () => {
  const m = new DesignSystemComplianceModule();
  const colors = new Map([
    ['rgb(0, 0, 0)', 5],
    ['rgb(255, 255, 255)', 3],
    ['rgb(0, 128, 255)', 2],
  ]);
  const clusters = m._findColorDuplicateClusters(colors);
  assert.equal(clusters.length, 0);
});

test('_findColorDuplicateClusters ignores unparseable / transparent values', () => {
  const m = new DesignSystemComplianceModule();
  const colors = new Map([
    ['transparent', 5],
    ['rgba(0, 0, 0, 0)', 4],
    ['currentcolor', 1],
  ]);
  const clusters = m._findColorDuplicateClusters(colors);
  assert.equal(clusters.length, 0);
});

test('_findOffGridSpacing flags values not divisible by the base unit', () => {
  const m = new DesignSystemComplianceModule();
  const spacing = new Map([
    ['16px', 10],
    ['8px', 8],
    ['13px', 3], // not a multiple of 4
    ['7px', 1],  // not a multiple of 4
    ['0px', 20], // zero is never a finding
  ]);
  const offenders = m._findOffGridSpacing(spacing, 4);
  const values = offenders.map((o) => o.value).sort();
  assert.deepEqual(values, ['13px', '7px']);
});

test('_findOffGridSpacing respects a custom base unit', () => {
  const m = new DesignSystemComplianceModule();
  const spacing = new Map([['10px', 5], ['5px', 5]]);
  assert.equal(m._findOffGridSpacing(spacing, 5).length, 0);
  assert.equal(m._findOffGridSpacing(spacing, 4).length, 2);
});

// ── _report thresholds ───────────────────────────────────────────────────

function baseStats(overrides = {}) {
  return {
    colors: new Map(),
    fontSizes: new Map(),
    fontFamilies: new Map(),
    radii: new Map(),
    spacingValues: new Map(),
    pagesVisited: 1,
    ...overrides,
  };
}

test('_report emits nothing but a summary when everything is within thresholds', () => {
  const m = new DesignSystemComplianceModule();
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
  const stats = baseStats({
    colors: new Map([['rgb(0,0,0)', 1], ['rgb(255,255,255)', 1]]),
    fontSizes: new Map([['16px', 1]]),
    fontFamilies: new Map([['Inter', 1]]),
  });
  m._report(result, stats, 'https://example.com', {});
  assert.equal(checks.length, 1);
  assert.equal(checks[0].name, 'design-system-compliance:summary');
});

test('_report flags color-count when above the configured threshold', () => {
  const m = new DesignSystemComplianceModule();
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
  const colors = new Map();
  for (let i = 0; i < 5; i++) colors.set(`rgb(${i * 40}, 10, 10)`, 1); // spaced far apart, no dup clustering
  const stats = baseStats({ colors });
  m._report(result, stats, 'https://example.com', { maxRecommendedColors: 3 });
  assert.ok(checks.find((c) => c.name === 'design-system-compliance:color-count'));
});

test('_report reports zero pages crawled distinctly from zero findings', () => {
  const m = new DesignSystemComplianceModule();
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
  m._report(result, baseStats({ pagesVisited: 0 }), 'https://example.com', {});
  assert.equal(checks.length, 1);
  assert.equal(checks[0].name, 'design-system-compliance:no-pages');
});
