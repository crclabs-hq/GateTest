'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ApiHealthModule = require('../src/modules/api-health.js');
const { inferBenignValue, groupByEndpoint, looksLikeApiEndpoint } = ApiHealthModule;

// ── Pure helper tests ───────────────────────────────────────────────────

test('module exports a class with the expected name', () => {
  const m = new ApiHealthModule();
  assert.equal(m.name, 'apiHealth');
  assert.equal(typeof m.run, 'function');
  assert.ok(m.description && m.description.length > 0);
});

test('run() returns gracefully when no URL is configured', async () => {
  const m = new ApiHealthModule();
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
  const config = { getModuleConfig: () => ({}), get: () => undefined };
  await m.run(result, config);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].name, 'api-health:config');
  assert.equal(checks[0].passed, true);
  assert.equal(checks[0].details.severity, 'info');
});

test('module registers in the built-in modules map by name "apiHealth"', () => {
  const registry = require('../src/core/registry.js');
  assert.ok(registry.BUILT_IN_MODULES.apiHealth, 'apiHealth must be in BUILT_IN_MODULES');
});

test('module is included in the "web" suite', () => {
  const { DEFAULT_CONFIG } = require('../src/core/config.js');
  assert.ok(DEFAULT_CONFIG.suites.web.includes('apiHealth'));
});

test('module is included in the "wp" suite', () => {
  const { DEFAULT_CONFIG } = require('../src/core/config.js');
  assert.ok(DEFAULT_CONFIG.suites.wp.includes('apiHealth'));
});

test('module does not depend on playwright (pure HTTP, no browser)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'api-health.js'), 'utf-8');
  assert.ok(!src.includes('playwright'), 'apiHealth should never need a browser');
});

test('inferBenignValue picks a plausible value per param name shape', () => {
  assert.equal(inferBenignValue('email'), 'test@gatetest.ai');
  assert.equal(inferBenignValue('userEmail'), 'test@gatetest.ai');
  assert.equal(inferBenignValue('redirectUrl'), 'https://gatetest.ai');
  assert.equal(inferBenignValue('id'), '1');
  assert.equal(inferBenignValue('userId'), '1');
  assert.equal(inferBenignValue('phone'), '+15555550100');
  assert.equal(inferBenignValue('password'), 'GateTest-Probe-1!');
  assert.equal(inferBenignValue('something_unrecognised'), 'gatetest-probe');
});

test('groupByEndpoint collapses multiple per-param rows into one entry per method+url', () => {
  const discovered = [
    { url: 'https://example.com/api/login', method: 'POST', paramName: 'email', paramLocation: 'body', source: 'common-paths' },
    { url: 'https://example.com/api/login', method: 'POST', paramName: 'password', paramLocation: 'body', source: 'common-paths' },
    { url: 'https://example.com/api/search', method: 'GET', paramName: 'q', paramLocation: 'query', source: 'html-link' },
  ];
  const grouped = groupByEndpoint(discovered);
  assert.equal(grouped.length, 2);
  const login = grouped.find((e) => e.url.endsWith('/api/login'));
  assert.equal(login.params.length, 2);
  assert.ok(login.sources.has('common-paths'));
});

test('looksLikeApiEndpoint is true for /api/ paths, POST methods, and openapi source; false for a plain GET page', () => {
  assert.equal(looksLikeApiEndpoint('https://example.com/api/users', 'GET', new Set(['common-paths'])), true);
  assert.equal(looksLikeApiEndpoint('https://example.com/anything', 'POST', new Set(['html-form'])), true);
  assert.equal(looksLikeApiEndpoint('https://example.com/users/{id}', 'GET', new Set(['openapi'])), true);
  assert.equal(looksLikeApiEndpoint('https://example.com/search', 'GET', new Set(['html-link'])), false);
});

// ── End-to-end tests via a fake runner (LiveProbeRunner blocks localhost,
//    so a real local test server can't be used here — the same dependency-
//    injection pattern as the existing live-sql-injection module) ────────

function makeFakeRunner(responder) {
  const calls = [];
  return {
    aborted: false,
    calls,
    async probe({ method, url, body }) {
      calls.push({ method, url, body });
      return responder(method, url, body);
    },
    summary() {
      return { totalRequests: calls.length, aborted: false, abortReason: null, durationMs: 12, hostsTouched: ['example.com'] };
    },
  };
}

function jsonResult(status, obj, extra = {}) {
  return { ok: true, status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj), timeMs: 20, ...extra };
}

function htmlResult(status, body, extra = {}) {
  return { ok: true, status, headers: { 'content-type': 'text/html' }, body, timeMs: 20, ...extra };
}

test('run() flags a 5xx endpoint from explicit config as broken', async () => {
  const runner = makeFakeRunner((method, url) => {
    if (url.endsWith('/api/broken')) return jsonResult(500, { error: 'boom' });
    if (url === 'https://example.com/') return htmlResult(200, '<html></html>');
    return htmlResult(404, 'not found');
  });

  const m = new ApiHealthModule();
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
  const config = {
    getModuleConfig: () => ({ url: 'https://example.com', runner, endpoints: [{ path: '/api/broken', method: 'GET' }], maxEndpoints: 50 }),
    get: () => undefined,
  };
  await m.run(result, config);

  const broken = checks.find((c) => c.name === 'api-health:broken-endpoints');
  assert.equal(broken.passed, false);
  assert.ok(broken.details.details.some((d) => d.url.endsWith('/api/broken') && d.status === 500));
});

test('run() flags an API-shaped endpoint returning HTML instead of JSON', async () => {
  const runner = makeFakeRunner((method, url) => {
    if (url.endsWith('/api/htmlbug')) return htmlResult(200, '<html>oops</html>');
    if (url === 'https://example.com/') return htmlResult(200, '<html></html>');
    return htmlResult(404, 'not found');
  });

  const m = new ApiHealthModule();
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
  const config = {
    getModuleConfig: () => ({ url: 'https://example.com', runner, endpoints: [{ path: '/api/htmlbug', method: 'GET' }], maxEndpoints: 50 }),
    get: () => undefined,
  };
  await m.run(result, config);

  const wrongType = checks.find((c) => c.name === 'api-health:wrong-content-type');
  assert.ok(wrongType, 'expected a wrong-content-type finding');
  assert.equal(wrongType.passed, false);
  assert.ok(wrongType.details.details.some((d) => d.url.endsWith('/api/htmlbug')));
});

test('run() does NOT flag a plain (non-API-shaped) GET page for returning HTML', async () => {
  const runner = makeFakeRunner((method, url) => {
    // Matches both the bare request (.../search) and the query-filled
    // variant (.../search?q=...) since /search takes a query param.
    if (url.startsWith('https://example.com/search')) return htmlResult(200, '<html>results</html>');
    if (url === 'https://example.com/') return htmlResult(200, '<a href="/search?q=x">Search</a>');
    return htmlResult(404, 'not found');
  });

  const m = new ApiHealthModule();
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
  const config = {
    getModuleConfig: () => ({ url: 'https://example.com', runner, maxEndpoints: 50 }),
    get: () => undefined,
  };
  await m.run(result, config);

  const wrongType = checks.find((c) => c.name === 'api-health:wrong-content-type');
  assert.equal(wrongType, undefined, 'a plain HTML page must not be flagged as wrong-content-type');
});

test('run() does NOT flag an untrusted common-paths guess (e.g. /graphql on a non-GraphQL site) for returning the site\'s normal 200-status HTML page', async () => {
  // No explicit endpoints/openapi — /graphql only comes from the curated
  // common-paths guess list. A site that doesn't run GraphQL will answer
  // its normal catch-all page (status 200, text/html) for this path,
  // which is expected behaviour, not a bug.
  const runner = makeFakeRunner((method, url) => {
    if (url === 'https://example.com/') return htmlResult(200, '<html></html>');
    return htmlResult(200, '<html>catch-all app shell</html>');
  });

  const m = new ApiHealthModule();
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
  const config = {
    getModuleConfig: () => ({ url: 'https://example.com', runner, maxEndpoints: 50 }),
    get: () => undefined,
  };
  await m.run(result, config);

  const wrongType = checks.find((c) => c.name === 'api-health:wrong-content-type');
  assert.equal(wrongType, undefined, 'an untrusted common-paths guess getting the site\'s normal page back must not be flagged');
});

test('run() flags a 2xx endpoint claiming application/json with an unparsable body', async () => {
  const runner = makeFakeRunner((method, url) => {
    if (url.endsWith('/api/badjson')) return { ok: true, status: 200, headers: { 'content-type': 'application/json' }, body: 'not json{', timeMs: 10 };
    if (url === 'https://example.com/') return htmlResult(200, '<html></html>');
    return htmlResult(404, 'not found');
  });

  const m = new ApiHealthModule();
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
  const config = {
    getModuleConfig: () => ({ url: 'https://example.com', runner, endpoints: [{ path: '/api/badjson', method: 'GET' }], maxEndpoints: 50 }),
    get: () => undefined,
  };
  await m.run(result, config);

  const malformed = checks.find((c) => c.name === 'api-health:malformed-json');
  assert.ok(malformed, 'expected a malformed-json finding');
  assert.equal(malformed.passed, false);
});

test('run() flags a critically slow endpoint using the recorded timeMs (no real waiting)', async () => {
  const runner = makeFakeRunner((method, url) => {
    if (url.endsWith('/api/slow')) return jsonResult(200, { ok: true }, { timeMs: 20000 });
    if (url === 'https://example.com/') return htmlResult(200, '<html></html>');
    return htmlResult(404, 'not found');
  });

  const m = new ApiHealthModule();
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
  const config = {
    getModuleConfig: () => ({ url: 'https://example.com', runner, endpoints: [{ path: '/api/slow', method: 'GET' }], maxEndpoints: 50 }),
    get: () => undefined,
  };
  await m.run(result, config);

  const slow = checks.find((c) => c.name === 'api-health:slow-endpoints');
  assert.ok(slow, 'expected a slow-endpoints finding');
  assert.equal(slow.passed, false);
  assert.equal(slow.details.details[0].severity, 'error');
});

test('run() substitutes OpenAPI path parameters instead of sending a literal "{id}" placeholder', async () => {
  const spec = {
    paths: {
      '/users/{id}': {
        get: { parameters: [{ name: 'id', in: 'path' }] },
      },
    },
  };
  const runner = makeFakeRunner((method, url) => {
    if (url === 'https://example.com/users/1') return jsonResult(200, { id: 1 });
    if (url === 'https://example.com/') return htmlResult(200, '<html></html>');
    return htmlResult(404, 'not found');
  });

  const m = new ApiHealthModule();
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
  const config = {
    getModuleConfig: () => ({ url: 'https://example.com', runner, openApiSpec: spec, maxEndpoints: 50 }),
    get: () => undefined,
  };
  await m.run(result, config);

  assert.ok(runner.calls.some((c) => c.url === 'https://example.com/users/1'), 'expected the {id} placeholder to be substituted before sending');
  const broken = checks.find((c) => c.name === 'api-health:broken-endpoints');
  assert.equal(broken.passed, true, 'the substituted path-param endpoint must not be reported broken');
});

test('run() does not flag an untrusted (common-paths) 404 as broken', async () => {
  // No explicit endpoints/openapi — everything comes from the curated
  // common-paths guess list, none of which are confirmed to exist.
  const runner = makeFakeRunner((method, url) => {
    if (url === 'https://example.com/') return htmlResult(200, '<html></html>');
    return htmlResult(404, 'not found');
  });

  const m = new ApiHealthModule();
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
  const config = {
    getModuleConfig: () => ({ url: 'https://example.com', runner, maxEndpoints: 50 }),
    get: () => undefined,
  };
  await m.run(result, config);

  const broken = checks.find((c) => c.name === 'api-health:broken-endpoints');
  assert.equal(broken.passed, true, 'speculative common-paths guesses 404ing is expected, not a finding');
});
