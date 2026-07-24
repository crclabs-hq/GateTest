'use strict';
/**
 * Hosted authed-crawl support (Craig-authorized 2026-07-25) — the website
 * half of the crawler-auth feature. Covers:
 *   1. GateTestConfig.set — the dot-path setter the web-scan route depends
 *      on (its absence made the route's targetUrl injection dead code).
 *   2. url-prober authHeaders — same-origin only, dropped on cross-origin
 *      redirects.
 *   3. Route source-text contract — auth validated, threaded into
 *      modules.liveCrawler, never logged, honesty flag present.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { GateTestConfig } = require('../src/core/config');
const { probeUrl } = require('../website/app/lib/reliability/url-prober');

describe('GateTestConfig.set — dot-path setter', () => {
  it('sets a top-level key readable by get()', () => {
    const c = new GateTestConfig(process.cwd());
    c.set('targetUrl', 'https://example.com');
    assert.strictEqual(c.get('targetUrl'), 'https://example.com');
  });

  it('creates intermediate objects and feeds getModuleConfig()', () => {
    const c = new GateTestConfig(process.cwd());
    c.set('modules.liveCrawler.cookie', 'session=abc');
    c.set('modules.liveCrawler.headers', { Authorization: 'Bearer t' });
    const crawlCfg = c.getModuleConfig('liveCrawler');
    assert.strictEqual(crawlCfg.cookie, 'session=abc');
    assert.deepStrictEqual(crawlCfg.headers, { Authorization: 'Bearer t' });
  });

  it('does not clobber sibling keys on a deep set', () => {
    const c = new GateTestConfig(process.cwd());
    const before = Object.keys(c.getModuleConfig('liveCrawler') || {}).length;
    c.set('modules.liveCrawler.cookie', 'x=1');
    const after = c.getModuleConfig('liveCrawler');
    assert.ok(Object.keys(after).length >= before, 'existing module config must survive');
    assert.strictEqual(after.cookie, 'x=1');
  });
});

describe('url-prober — authHeaders same-origin gating', () => {
  function fakeFetchRecorder(responses) {
    const calls = [];
    let i = 0;
    const impl = async (url, opts) => {
      calls.push({ url, headers: { ...(opts.headers || {}) } });
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return {
        status: r.status,
        headers: {
          get: (name) => (r.headers && r.headers[name.toLowerCase()]) || null,
          getSetCookie: () => [],
        },
      };
    };
    impl.calls = calls;
    return impl;
  }

  it('sends authHeaders to the target origin', async () => {
    const fetchImpl = fakeFetchRecorder([{ status: 200, headers: {} }]);
    await probeUrl({
      url: 'https://example.com/',
      _fetch: fetchImpl,
      authHeaders: { Authorization: 'Bearer tok', Cookie: 'session=x' },
    });
    assert.strictEqual(fetchImpl.calls[0].headers.Authorization, 'Bearer tok');
    assert.strictEqual(fetchImpl.calls[0].headers.Cookie, 'session=x');
  });

  it('drops authHeaders when a redirect leaves the origin', async () => {
    const fetchImpl = fakeFetchRecorder([
      // Cross-origin hop must be a real, resolvable public host — probeUrl
      // re-validates every hop through the SSRF guard (real DNS lookup).
      { status: 302, headers: { location: 'https://example.org/landing' } },
      { status: 200, headers: {} },
    ]);
    await probeUrl({
      url: 'https://example.com/',
      _fetch: fetchImpl,
      authHeaders: { Authorization: 'Bearer tok' },
    });
    assert.strictEqual(fetchImpl.calls.length, 2);
    assert.strictEqual(fetchImpl.calls[0].headers.Authorization, 'Bearer tok');
    assert.strictEqual(fetchImpl.calls[1].headers.Authorization, undefined,
      'auth header must not follow a cross-origin redirect');
  });

  it('unauthenticated probes are unchanged (no auth keys at all)', async () => {
    const fetchImpl = fakeFetchRecorder([{ status: 200, headers: {} }]);
    await probeUrl({ url: 'https://example.com/', _fetch: fetchImpl });
    assert.strictEqual(fetchImpl.calls[0].headers.Authorization, undefined);
    assert.strictEqual(fetchImpl.calls[0].headers.Cookie, undefined);
  });
});

describe('web-scan route — authed-scan contract (source text)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../website/app/api/web/scan/route.ts'), 'utf8');

  it('validates auth via sanitizeAuth and 400s on malformed input', () => {
    assert.match(src, /function sanitizeAuth/);
    assert.match(src, /sanitizedAuth && "error" in sanitizedAuth/);
  });

  it('caps header count/value size and rejects CR/LF injection', () => {
    assert.match(src, /AUTH_MAX_HEADERS/);
    assert.match(src, /AUTH_MAX_VALUE_LEN/);
    assert.match(src, /\[\\r\\n\]/);
  });

  it('threads auth into modules.liveCrawler config', () => {
    assert.match(src, /modules\.liveCrawler\.headers/);
    assert.match(src, /modules\.liveCrawler\.cookie/);
  });

  it('passes session to the live probe as authHeaders', () => {
    assert.match(src, /authHeaders/);
  });

  it('exposes the authenticatedScan honesty flag and forwards the session to the runtime worker', () => {
    assert.match(src, /authenticatedScan: Boolean\(sanitizedAuth\)/);
    // Session is forwarded to the runtime worker (KI #70 follow-up closed).
    assert.match(src, /\.\.\.\(sanitizedAuth \? \{ auth: sanitizedAuth \} : \{\}\)/);
    assert.match(src, /forwarded to the runtime browser worker/);
  });

  it('never logs the auth material', () => {
    // Every console.* call in the route must be free of auth references.
    const logCalls = src.match(/console\.[a-z]+\([^)]*\)/g) || [];
    for (const call of logCalls) {
      assert.ok(!/auth|cookie|header/i.test(call), `auth material must never be logged: ${call}`);
    }
  });
});
