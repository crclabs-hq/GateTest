'use strict';

// Control pairs for the live-site false positives found scanning gluecron.com
// and gatetest.io on 2026-10-03. Each block: the real shape that wrongly fired
// stays quiet, and the genuinely bad shape beside it still fires.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const { liveCookieChecks } = require('../src/modules/cookie-security');
const ApiHealthModule = require('../src/modules/api-health');
const AccessibilityModule = require('../src/modules/accessibility');
const SeoModule = require('../src/modules/seo');
const { isApiEndpointPath } = require('../src/core/api-path');
const { detectTlsIntercept } = require('../src/core/tls-intercept');
const ServerScanner = require('../src/scanners/server-scanner');

// ── 1. cookie-security: CSRF double-submit cookie needs no HttpOnly ────────

const ids = (headers) => liveCookieChecks(headers).map((f) => f.id);
const setCookie = (...v) => ({ 'set-cookie': v });

test('cookie: csrf_token Secure; SameSite=Lax without HttpOnly stays quiet (gluecron.com)', () => {
  assert.deepEqual(ids(setCookie('csrf_token=abc; Path=/; Secure; SameSite=Lax')), []);
  for (const n of ['csrf', 'xsrf', '_csrf', 'XSRF-TOKEN', 'csrftoken', 'CSRF_Token', '__Host-csrf']) {
    assert.deepEqual(ids(setCookie(`${n}=x; Secure; SameSite=Lax`)), [], n);
  }
});

test('cookie CONTROL: session / sid without HttpOnly still fire; lookalike names are not exempt', () => {
  assert.deepEqual(ids(setCookie('session=abc; Secure; SameSite=Lax')), ['live-httponly-missing:session']);
  assert.deepEqual(ids(setCookie('sid=abc; Secure; SameSite=Lax')), ['live-httponly-missing:sid']);
  // substring, not a segment: `csrfx` and `mycsrfsession` are not CSRF cookie names
  assert.deepEqual(ids(setCookie('csrfx_session=a; Secure')), ['live-httponly-missing:csrfx_session']);
  assert.deepEqual(ids(setCookie('mycsrfsession=a; Secure')), ['live-httponly-missing:mycsrfsession']);
});

test('cookie CONTROL: a CSRF cookie is still flagged when not Secure, or SameSite=None without Secure', () => {
  assert.deepEqual(ids(setCookie('csrf_token=a; SameSite=Lax')), ['live-secure-missing:csrf_token']);
  assert.deepEqual(
    ids(setCookie('csrf_token=a; SameSite=None')).sort(),
    ['live-samesite-none-insecure:csrf_token', 'live-secure-missing:csrf_token'],
  );
});

// ── 2. api-health: a broken-endpoint finding names the URL ─────────────────

async function runApiHealth(handler, endpoints) {
  const checks = [];
  const result = { addCheck: (name, passed, details) => checks.push({ name, passed, ...details }) };
  const runner = {
    aborted: false,
    probe: async ({ method, url }) => handler(method, new URL(url).toString()),
    summary: () => ({ totalRequests: 1, aborted: false, abortReason: null, durationMs: 1, hostsTouched: ['example.com'] }),
  };
  const config = {
    getModuleConfig: () => ({ url: 'https://example.com', runner, endpoints, maxEndpoints: 50 }),
    get: () => undefined,
  };
  await new ApiHealthModule().run(result, config);
  return checks.find((c) => c.name === 'api-health:broken-endpoints');
}

const html404 = { ok: true, status: 404, headers: { 'content-type': 'text/html' }, body: 'nf', timeMs: 5 };
const json = (status) => ({ ok: true, status, headers: { 'content-type': 'application/json' }, body: '{}', timeMs: 5 });

test('api-health: a failed request (no status) is reported with its URL in message and details', async () => {
  const broken = await runApiHealth((method, url) => (
    url.endsWith('/api/down') ? { ok: false, status: 0, error: 'ECONNRESET', headers: {} } : html404
  ), [{ path: '/api/down', method: 'GET' }]);
  assert.equal(broken.passed, false);
  assert.match(broken.message, /https:\/\/example\.com\/api\/down/);
  assert.match(broken.message, /ECONNRESET/);
  assert.ok(broken.details.some((d) => d.url.endsWith('/api/down')));
});

test('api-health: a 5xx finding names the URL and the status in the message', async () => {
  const broken = await runApiHealth((method, url) => (url.endsWith('/api/boom') ? json(503) : html404), [{ path: '/api/boom', method: 'GET' }]);
  assert.equal(broken.passed, false);
  assert.match(broken.message, /\/api\/boom \(HTTP 503\)/);
});

test('api-health CONTROL: nothing broken -> passing finding', async () => {
  const ok = await runApiHealth((method, url) => (url.endsWith('/api/fine') ? json(200) : html404), [{ path: '/api/fine', method: 'GET' }]);
  assert.equal(ok.passed, true);
});

// ── 3. API / GraphQL endpoints are not content pages ───────────────────────

test('api-path: segment matching, never substring', () => {
  for (const u of ['https://gluecron.com/api/graphql', 'https://x.io/graphql', 'https://x.io/graphiql', '/api', '/api/playground', 'https://x.io/v1/graphql?x=1']) {
    assert.equal(isApiEndpointPath(u), true, u);
  }
  for (const u of ['https://x.io/apiary', 'https://x.io/', 'https://x.io/pricing', 'https://x.io/docs/api', 'https://x.io/graphqlish', 'https://x.io/playground', 'fetched page', '']) {
    assert.equal(isApiEndpointPath(u), false, u);
  }
});

const PLAYGROUND_HTML = '<!doctype html><html><head><title>GraphiQL</title></head><body><div id="graphiql"></div></body></html>';

async function liveFailures(Mod, url, html) {
  const checks = [];
  const result = { checks, addCheck(name, passed, d = {}) { checks.push({ name, passed, ...d }); } };
  await new Mod().run(result, { livePage: { url, status: 200, headers: {}, html }, getModuleConfig: () => ({}), get: () => undefined });
  return checks.filter((c) => !c.passed);
}

test('a11y live: /api/graphql playground gets no landmark/lang finding; a content page without <main> still does', async () => {
  assert.deepEqual(await liveFailures(AccessibilityModule, 'https://gluecron.com/api/graphql', PLAYGROUND_HTML), []);
  const bad = await liveFailures(AccessibilityModule, 'https://gluecron.com/pricing', PLAYGROUND_HTML);
  assert.ok(bad.some((c) => /lang/i.test(c.message)) && bad.some((c) => /main/i.test(c.message)), JSON.stringify(bad));
});

test('seo live: /api/graphql playground gets no metadata finding; a content page still does', async () => {
  assert.deepEqual(await liveFailures(SeoModule, 'https://gluecron.com/api/graphql', PLAYGROUND_HTML), []);
  const bad = await liveFailures(SeoModule, 'https://gluecron.com/pricing', PLAYGROUND_HTML);
  assert.ok(bad.some((c) => /description/i.test(c.message)), JSON.stringify(bad));
});

// ── 4. TLS intercepted by a local proxy: cert expiry / TTFB not checked ────

const inDays = (n) => new Date(Date.now() + n * 86400000).toUTCString();
const newMod = () => ({ status: 'passed', checks: 0, issues: 0, details: [] });
const scanner = new ServerScanner();

function withLocalCa(t, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-tls-'));
  try {
    const pem = path.join(dir, 'ca.pem');
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', pem,
        '-days', '30', '-subj', '/O=Anthropic/CN=sandbox-egress CA'], { stdio: 'ignore' });
    } catch {
      t.skip('no openssl on this host');
      return;
    }
    fn({ NODE_EXTRA_CA_CERTS: pem });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('tls: a leaf minted by the local intercepting CA -> expiry reported as not checked (info)', (t) => {
  withLocalCa(t, (env) => {
    const cert = { valid_to: inDays(5), issuer: { O: 'Anthropic', CN: 'sandbox-egress CA' } };
    const mod = newMod();
    scanner._checkExpiry(mod, cert, detectTlsIntercept({ cert, env }));
    assert.equal(mod.issues, 0);
    assert.equal(mod.status, 'passed');
    assert.match(mod.details[0], /^info: SSL certificate expiry not checked — TLS intercepted by a local proxy/);
  });
});

test('tls CONTROL: no local CA in play -> a soon-expiring cert still fires', () => {
  const cert = { valid_to: inDays(5), issuer: { O: "Let's Encrypt", CN: 'R11' } };
  const mod = newMod();
  scanner._checkExpiry(mod, cert, detectTlsIntercept({ cert, env: {} }));
  assert.equal(mod.issues, 1);
  assert.match(mod.details[0], /^warning: SSL certificate expires in [45] days/);
});

test('tls CONTROL: a forwarding proxy (HTTPS_PROXY set) passing the site\'s own cert is NOT interception', () => {
  const cert = { valid_to: inDays(5), issuer: { O: "Let's Encrypt", CN: 'R11' } };
  const verdict = detectTlsIntercept({ cert, env: { HTTPS_PROXY: 'http://corp-proxy:3128' } });
  assert.equal(verdict.intercepted, false);
  const mod = newMod();
  scanner._checkExpiry(mod, cert, verdict);
  assert.equal(mod.issues, 1);
});

test('tls: issuer matching a CA in NODE_EXTRA_CA_CERTS is intercepted with no proxy var; a public issuer is not', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-tls-'));
  try {
    const pem = path.join(dir, 'ca.pem');
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', pem,
        '-days', '30', '-subj', '/O=Anthropic/CN=sandbox-egress CA'], { stdio: 'ignore' });
    } catch {
      t.skip('no openssl on this host');
      return;
    }
    const env = { NODE_EXTRA_CA_CERTS: pem };
    const leaf = { valid_to: inDays(29), issuer: { O: 'Anthropic', CN: 'sandbox-egress CA' } };
    assert.equal(detectTlsIntercept({ cert: leaf, hostname: 'gluecron.com', env }).intercepted, true);
    const pub = { valid_to: inDays(29), issuer: { O: "Let's Encrypt", CN: 'R11' } };
    assert.equal(detectTlsIntercept({ cert: pub, hostname: 'gluecron.com', env }).intercepted, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ttfb: skipped when the SSL check found interception; measured otherwise, proxy env or not', async () => {
  const s2 = new ServerScanner();
  s2._tlsVerdict = { intercepted: true, reason: 'the certificate issuer is a CA in the local CA bundle (NODE_EXTRA_CA_CERTS)' };
  const skipped = await s2._checkPerformance('https://gluecron.com/', { sslCheck: Promise.resolve() });
  assert.equal(skipped.issues, 0);
  assert.equal(skipped.checks, 0);
  assert.match(skipped.details[0], /^info: TTFB not checked — TLS intercepted by a local proxy/);

  const srv = http.createServer((q, r) => r.end('ok'));
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  try {
    const measured = await new ServerScanner()._checkPerformance(`http://127.0.0.1:${srv.address().port}/`, {});
    assert.ok(measured.details.some((d) => /TTFB:/.test(d)), measured.details.join('|'));
  } finally {
    srv.close();
  }
});

test('tls CONTROL: a bundle holding only public roots is no evidence — a normal chain is not interception', () => {
  const tls = require('tls');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-tls-pub-'));
  try {
    const pem = path.join(dir, 'system.pem');
    fs.writeFileSync(pem, tls.rootCertificates.slice(0, 40).join('\n'));
    const env = { NODE_EXTRA_CA_CERTS: pem };
    const { extraCaBundle } = require('../src/core/tls-intercept');
    assert.equal(extraCaBundle(env).length, 0);
    const root = new (require('crypto').X509Certificate)(tls.rootCertificates[0]);
    const leaf = { valid_to: inDays(5), issuer: Object.fromEntries(root.subject.split('\n').map((l) => l.split('='))) };
    assert.equal(detectTlsIntercept({ cert: leaf, env }).intercepted, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tls: a leaf signed by an intermediate that chains to a local root is interception', (t) => {
  withLocalCa(t, (env) => {
    const root = { subject: { O: 'Anthropic', CN: 'sandbox-egress CA' }, issuer: { O: 'Anthropic', CN: 'sandbox-egress CA' } };
    root.issuerCertificate = root;
    const intermediate = { subject: { O: 'Anthropic', CN: 'Issuing CA (production)' }, issuer: root.subject, issuerCertificate: root };
    const leaf = { valid_to: inDays(29), issuer: intermediate.subject, issuerCertificate: intermediate };
    assert.equal(detectTlsIntercept({ cert: leaf, env }).intercepted, true);
  });
});
