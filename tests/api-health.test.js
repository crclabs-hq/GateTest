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

test('run() reports NOT CHECKED (not a pass) when no URL is configured — issue #807', async () => {
  const m = new ApiHealthModule();
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
  const config = { getModuleConfig: () => ({}), get: () => undefined };
  await m.run(result, config);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].name, 'apiHealth:not-checked');
  assert.equal(checks[0].passed, false, 'a module that could not look must not wear a green tick');
  assert.equal(checks[0].details.notChecked, true);
  assert.equal(checks[0].details.severity, 'info');
  assert.match(checks[0].details.message, /no target URL/);
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
  // Bound to the resolver rather than to literals: these probe values are sent
  // into a customer's API, so what matters is that they stay GateTest-owned and
  // track the canonical origin — not which TLD is current this quarter.
  const { FIXTURE_EMAIL, siteUrl } = require('../src/core/site-url');
  assert.equal(inferBenignValue('email'), FIXTURE_EMAIL);
  assert.equal(inferBenignValue('userEmail'), FIXTURE_EMAIL);
  assert.equal(inferBenignValue('redirectUrl'), siteUrl());
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

test('looksLikeApiEndpoint is true for /api/ paths and spec/explicit sources; false for a page path, whatever the method (issue #807)', () => {
  assert.equal(looksLikeApiEndpoint('https://example.com/api/users', 'GET', new Set(['common-paths'])), true);
  assert.equal(looksLikeApiEndpoint('https://example.com/users/{id}', 'GET', new Set(['openapi'])), true);
  assert.equal(looksLikeApiEndpoint('https://example.com/anything', 'POST', new Set(['explicit-config'])), true);
  assert.equal(looksLikeApiEndpoint('https://example.com/search', 'GET', new Set(['html-link'])), false);
  // A form harvested from the homepage that POSTs to a page path is a page,
  // not an API — it answers HTML by design.
  assert.equal(looksLikeApiEndpoint('https://example.com/contact', 'POST', new Set(['html-form'])), false);
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
      // The module fetches the homepage as the bare origin it was given
      // (`https://example.com`); responders key on the canonical form.
      const canonical = new URL(url).toString();
      calls.push({ method, url: canonical, body });
      return responder(method, canonical, body);
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
  // ...and a catch-all page answering every guess confirms no route either.
  const nc = checks.find((c) => c.name === 'apiHealth:not-checked');
  assert.ok(nc, 'nothing confirmed => not-checked, not a green "0 broken"');
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

test('run() reports NOT CHECKED when every probe was a common-paths guess that 404\'d — the tallrig.com false green (issue #807)', async () => {
  // No explicit endpoints/openapi, a homepage with no forms or links —
  // everything comes from the curated common-paths guess list and the site
  // says "no such route" to all of it. Before this fix the module printed
  // "26 endpoint(s) checked — 0 broken": a health check that could not go red.
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

  assert.equal(checks.find((c) => c.name === 'api-health:broken-endpoints'), undefined,
    'no "0 broken" line when nothing real was checked');
  const nc = checks.find((c) => c.name === 'apiHealth:not-checked');
  assert.ok(nc, 'expected apiHealth:not-checked');
  assert.equal(nc.passed, false);
  assert.equal(nc.details.notChecked, true);
  assert.match(nc.details.message, /no OpenAPI spec/);
  assert.match(nc.details.message, /no explicit endpoints/);
  assert.match(nc.details.message, /no API-shaped forms or links on the homepage/);
  assert.match(nc.details.message, /\d+ guessed common path\(s\) probed, none answered as a live route/);
  const summary = checks.find((c) => c.name === 'api-health:summary');
  assert.match(summary.details.message, /0 confirmed live/);
});

test('CONTROL — a guessed path that answers like a live route IS confirmed and gets a real "0 broken" verdict', async () => {
  const runner = makeFakeRunner((method, url) => {
    if (url === 'https://example.com/') return htmlResult(200, '<html></html>');
    // Exactly /api/users (bare and query-filled), not the /api/users/1 guess.
    if (/^https:\/\/example\.com\/api\/users(\?|$)/.test(url)) return jsonResult(200, { users: [] });
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

  assert.equal(checks.find((c) => c.name === 'apiHealth:not-checked'), undefined);
  const broken = checks.find((c) => c.name === 'api-health:broken-endpoints');
  assert.equal(broken.passed, true);
  assert.match(broken.details.message, /^1 confirmed endpoint\(s\) checked — 0 broken \(\d+ guessed path\(s\) answered "no such route" and are not counted\)$/);
});

test('CONTROL — a real failure still fires when nothing else was confirmed: a guessed path answering 5xx is broken, not not-checked', async () => {
  const runner = makeFakeRunner((method, url) => {
    if (url === 'https://example.com/') return htmlResult(200, '<html></html>');
    if (url.startsWith('https://example.com/api/search')) return jsonResult(500, { error: 'boom' });
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

  assert.equal(checks.find((c) => c.name === 'apiHealth:not-checked'), undefined);
  const broken = checks.find((c) => c.name === 'api-health:broken-endpoints');
  assert.equal(broken.passed, false);
  assert.ok(broken.details.details.some((d) => d.url.endsWith('/api/search') && d.status === 500));
});

test('run() does NOT flag a homepage form that POSTs to a page path and answers HTML (issue #807 false claim)', async () => {
  const runner = makeFakeRunner((method, url) => {
    if (url === 'https://example.com/') return htmlResult(200, '<form action="/contact" method="post"><input name="email"></form>');
    if (url === 'https://example.com/contact') return htmlResult(200, '<html>thanks</html>');
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

  assert.ok(runner.calls.some((c) => c.method === 'POST' && c.url === 'https://example.com/contact'), 'the form must have been probed');
  assert.equal(checks.find((c) => c.name === 'api-health:wrong-content-type'), undefined,
    'a page-path form answering HTML is a page, not an API returning HTML');
  const broken = checks.find((c) => c.name === 'api-health:broken-endpoints');
  assert.equal(broken.passed, true, 'the form route was confirmed from the site\'s own HTML');
});

test('run() flags a trusted API route answering 401 with an HTML page (404 shape, issue #807); a JSON 401 stays quiet', async () => {
  const runner = makeFakeRunner((method, url) => {
    if (url === 'https://example.com/') return htmlResult(200, '<html></html>');
    if (url.endsWith('/api/private-html')) return htmlResult(401, '<html>login</html>');
    if (url.endsWith('/api/private-json')) return jsonResult(401, { error: 'unauthorised' });
    return htmlResult(404, 'not found');
  });

  const m = new ApiHealthModule();
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
  const config = {
    getModuleConfig: () => ({
      url: 'https://example.com', runner, maxEndpoints: 50,
      endpoints: [{ path: '/api/private-html', method: 'GET' }, { path: '/api/private-json', method: 'GET' }],
    }),
    get: () => undefined,
  };
  await m.run(result, config);

  const wrongType = checks.find((c) => c.name === 'api-health:wrong-content-type');
  assert.ok(wrongType, 'expected a wrong-content-type finding');
  assert.ok(wrongType.details.details.some((d) => d.url.endsWith('/api/private-html') && d.status === 401));
  assert.ok(!wrongType.details.details.some((d) => d.url.endsWith('/api/private-json')), 'a JSON 401 is the correct shape');
});
