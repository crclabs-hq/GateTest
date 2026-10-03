// Rules for Tallrig corpus entries 054, 055 and 059 (2026-10-03). Each
// vulnerable shape fires and its fix stays quiet; the corpus itself is
// private and never committed here, so the shapes below are re-typed.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { maskSource } = require('../src/core/source-strip');
const { unsetCredentialAllows } = require('../src/core/account-state-rules');
const { clientIdentityHeader, wildcardBind } = require('../src/core/access-scope-rules');

const lines = (src) => { const m = maskSource(src, 'a.ts').split('\n'); m.raw = src.split('\n'); return m; };
const fire = (rule, src) => rule('a.ts', lines(src)).map((f) => f.line);

describe('unset-credential-allows (054)', () => {
  const head = ['export const auth = async (c, next) => {', '  const expected = process.env["WORKERS_KV_API_KEY"];'];
  it('fires when the unset branch lets the request through outside production', () => {
    assert.deepStrictEqual(fire(unsetCredentialAllows, [...head,
      '  if (!expected) {', '    if (process.env["NODE_ENV"] === "production") {', '      return c.json({ error: "x" }, 500);', '    }', '    return next();', '  }',
      '  await next();', '};'].join('\n')), [3]);
  });
  it('quiet when the unset branch refuses in every environment', () => {
    assert.deepStrictEqual(fire(unsetCredentialAllows, [...head,
      '  if (!expected) {', '    return c.json({ error: "not configured" }, 503);', '  }', '  await next();', '};'].join('\n')), []);
  });
  it('quiet for a non-credential env var', () => {
    assert.deepStrictEqual(fire(unsetCredentialAllows, ['const region = process.env.AWS_REGION;', 'if (!region) {', '  return next();', '}'].join('\n')), []);
  });
});

describe('client-identity-header: an optional verifier is no verification (055)', () => {
  const read = 'const resolve = (req) => req.headers.get("x-tenant-id");';
  it('fires when the only verifier sits behind if (deps.verifyBearer)', () => {
    assert.deepStrictEqual(fire(clientIdentityHeader, [read, 'app.get("/stats", (c) => {', '  if (deps.verifyBearer) {', '    if (!deps.verifyBearer(t, b)) return c.json({}, 401);', '  }', '});'].join('\n')), [1]);
  });
  it('quiet when a missing verifier fails closed', () => {
    assert.deepStrictEqual(fire(clientIdentityHeader, [read, 'const gate = async (c, next) => {', '  const verify = deps.verifyReader;', '  if (!verify) return c.json({}, 503);', '  if (!verify(t, b)) return c.json({}, 401);', '};'].join('\n')), []);
  });
});

describe('wildcard-bind (059)', () => {
  it('fires on Bun.serve with a port and no hostname', () => {
    assert.deepStrictEqual(fire(wildcardBind, ['bun.serve({', '  port: config.port,', '  fetch: app.fetch,', '});'].join('\n')), [1]);
  });
  it('fires on a Bun default-export server', () => {
    assert.deepStrictEqual(fire(wildcardBind, ['export default {', '  port: 8080,', '  fetch: app.fetch,', '};'].join('\n')), [1]);
  });
  it('quiet with an explicit hostname', () => {
    assert.deepStrictEqual(fire(wildcardBind, ['bun.serve({', '  port: config.port,', '  hostname: config.hostname,', '  fetch: app.fetch,', '});'].join('\n')), []);
  });
  it('quiet when hostname follows a long inline fetch handler', () => {
    const body = Array.from({ length: 60 }, (_, k) => `    const v${k} = ${k};`);
    assert.deepStrictEqual(fire(wildcardBind, ['Bun.serve({', '  port,', '  async fetch(req) {', ...body, '    return new Response("ok");', '  },', '  hostname: "127.0.0.1",', '});'].join('\n')), []);
  });
  it('quiet when a spread may carry the hostname', () => {
    assert.deepStrictEqual(fire(wildcardBind, ['Bun.serve({', '  fetch: app.fetch,', '  port,', '  ...resolveBindOptions(),', '});'].join('\n')), []);
  });
  it('quiet for a default-export config object that is not a server', () => {
    assert.deepStrictEqual(fire(wildcardBind, ['export default {', '  port: 3000,', '  plugins: [],', '};'].join('\n')), []);
  });
});
