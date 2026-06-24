const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  COMMON_API_PATHS, discoverFromCommonPaths, discoverFromOpenApi,
  discoverFromHtml, mergeDiscoveries,
} = require('../src/core/endpoint-discovery');

describe('endpoint-discovery — common paths', () => {
  it('exports a non-empty path list', () => {
    assert.ok(COMMON_API_PATHS.length >= 10);
  });

  it('builds probe targets from a base URL', () => {
    const out = discoverFromCommonPaths('https://example.com');
    assert.ok(out.length > 0);
    // Sample URL is well-formed and rooted at base origin
    for (const e of out) {
      assert.ok(e.url.startsWith('https://example.com'));
      assert.ok(['common-paths'].includes(e.source));
    }
  });

  it('emits a no-param entry for path-only common entries', () => {
    const out = discoverFromCommonPaths('https://example.com');
    const adminProbe = out.find((e) => e.url.endsWith('/admin') && e.paramLocation === 'none');
    assert.ok(adminProbe, 'expected /admin no-param entry');
  });

  it('emits multiple param entries for parameterized common paths', () => {
    const out = discoverFromCommonPaths('https://example.com');
    const loginProbes = out.filter((e) => e.url.endsWith('/api/login'));
    // /api/login has 3 params -> 3 probe entries
    assert.ok(loginProbes.length >= 3);
  });

  it('returns [] for malformed base URL', () => {
    const out = discoverFromCommonPaths('not-a-url');
    assert.deepStrictEqual(out, []);
  });
});

describe('endpoint-discovery — OpenAPI', () => {
  const spec = {
    servers: [{ url: 'https://api.example.com' }],
    paths: {
      '/users': {
        get: {
          parameters: [
            { name: 'id', in: 'query' },
            { name: 'limit', in: 'query' },
          ],
        },
        post: {
          requestBody: {
            content: {
              'application/json': {
                schema: { properties: { name: {}, email: {} } },
              },
            },
          },
        },
      },
      '/health': {
        get: {},
      },
    },
  };

  it('harvests query params for GET', () => {
    const out = discoverFromOpenApi(spec, 'https://api.example.com');
    const getUsers = out.filter((e) => e.url === 'https://api.example.com/users' && e.method === 'GET');
    assert.strictEqual(getUsers.length, 2);
    assert.ok(getUsers.some((e) => e.paramName === 'id'));
    assert.ok(getUsers.some((e) => e.paramName === 'limit'));
  });

  it('harvests body params for POST', () => {
    const out = discoverFromOpenApi(spec, 'https://api.example.com');
    const postUsers = out.filter((e) => e.url === 'https://api.example.com/users' && e.method === 'POST');
    assert.strictEqual(postUsers.length, 2);
    for (const e of postUsers) {
      assert.strictEqual(e.paramLocation, 'body');
    }
  });

  it('emits no-param entry for path with no parameters', () => {
    const out = discoverFromOpenApi(spec, 'https://api.example.com');
    const health = out.find((e) => e.url === 'https://api.example.com/health');
    assert.ok(health);
    assert.strictEqual(health.paramLocation, 'none');
  });

  it('returns [] for empty/invalid spec', () => {
    assert.deepStrictEqual(discoverFromOpenApi(null), []);
    assert.deepStrictEqual(discoverFromOpenApi({}), []);
  });
});

describe('endpoint-discovery — HTML harvest', () => {
  it('parses a GET form with inputs', () => {
    const html = `
      <form action="/search" method="GET">
        <input name="q" type="text">
        <input name="page" type="text">
      </form>
    `;
    const out = discoverFromHtml(html, 'https://example.com/');
    const probes = out.filter((e) => e.url === 'https://example.com/search');
    assert.strictEqual(probes.length, 2);
    for (const e of probes) assert.strictEqual(e.paramLocation, 'query');
  });

  it('parses a POST form', () => {
    const html = `<form action="/login" method="POST"><input name="email"/><input name="password"/></form>`;
    const out = discoverFromHtml(html, 'https://example.com/');
    const probes = out.filter((e) => e.url === 'https://example.com/login');
    assert.strictEqual(probes.length, 2);
    for (const e of probes) assert.strictEqual(e.paramLocation, 'body');
  });

  it('parses anchor links with query params', () => {
    const html = `<a href="/items?id=1&category=foo">link</a>`;
    const out = discoverFromHtml(html, 'https://example.com/');
    const id = out.find((e) => e.paramName === 'id');
    const cat = out.find((e) => e.paramName === 'category');
    assert.ok(id);
    assert.ok(cat);
  });

  it('absolutises relative paths against the page URL', () => {
    const html = `<form action="/api/x" method="POST"><input name="a"/></form>`;
    const out = discoverFromHtml(html, 'https://example.com/sub/page');
    assert.strictEqual(out[0].url, 'https://example.com/api/x');
  });

  it('returns [] for non-string', () => {
    assert.deepStrictEqual(discoverFromHtml(null, 'https://x.com'), []);
  });
});

describe('endpoint-discovery — merge', () => {
  it('dedupes identical entries across sources', () => {
    const a = [{ url: 'https://x/y', method: 'GET', paramName: 'q', paramLocation: 'query', source: 'a' }];
    const b = [{ url: 'https://x/y', method: 'GET', paramName: 'q', paramLocation: 'query', source: 'b' }];
    const merged = mergeDiscoveries(a, b);
    assert.strictEqual(merged.length, 1);
  });

  it('keeps differing entries', () => {
    const a = [{ url: 'https://x/y', method: 'GET', paramName: 'q', paramLocation: 'query', source: 'a' }];
    const b = [{ url: 'https://x/y', method: 'POST', paramName: 'q', paramLocation: 'body', source: 'b' }];
    const merged = mergeDiscoveries(a, b);
    assert.strictEqual(merged.length, 2);
  });
});
