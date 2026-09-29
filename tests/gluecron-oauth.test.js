'use strict';
// =============================================================================
// "Sign in with Gluecron" — the pure half (website/app/lib/gluecron-oauth.js)
// and the two route handlers at source level. Route handlers cannot be
// require()d outside the Next build; every upstream call here goes through a
// fake fetch. Nothing in this file touches gluecron.com.
// =============================================================================

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'website');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8').replace(/\r\n?/g, '\n');

const glc = require('../website/app/lib/gluecron-oauth.js');

const BASE = 'https://gluecron.com';
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

/** A fake fetch: `answer` is { status, body } or a function, or an Error to reject with. */
function fakeFetch(answer) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const a = typeof answer === 'function' ? answer(url, init) : answer;
    if (a instanceof Error) throw a;
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body };
  };
  fn.calls = calls;
  return fn;
}

describe('PKCE pair — S256 as Gluecron requires', () => {
  it('verifier is 43-128 unreserved characters and the challenge is base64url(sha256(verifier))', () => {
    for (let i = 0; i < 20; i++) {
      const { verifier, challenge, method } = glc.pkcePair();
      assert.equal(method, 'S256');
      assert.ok(verifier.length >= 43 && verifier.length <= 128, `length ${verifier.length}`);
      assert.match(verifier, /^[A-Za-z0-9\-._~]+$/);
      assert.equal(challenge, b64url(crypto.createHash('sha256').update(verifier).digest()));
      assert.ok(glc.isValidVerifier(verifier));
    }
  });

  it('two pairs never repeat', () => {
    assert.notEqual(glc.pkcePair().verifier, glc.pkcePair().verifier);
  });

  it('RFC 7636 appendix B vector', () => {
    assert.equal(glc.pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('isValidVerifier refuses a short, long, or non-unreserved value', () => {
    for (const bad of ['', 'x'.repeat(42), 'x'.repeat(129), 'x'.repeat(43) + '!', undefined, null, 42]) {
      assert.equal(glc.isValidVerifier(bad), false, JSON.stringify(bad));
    }
  });
});

describe('discovery — metadata honoured, fixed URLs when it is not there', () => {
  beforeEach(() => glc.resetDiscoveryCache());

  it('the fixed endpoints are the ones Gluecron verified on 2026-09-29', () => {
    assert.deepEqual(glc.fixedEndpoints(BASE), {
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/oauth/token`,
      revocation_endpoint: `${BASE}/oauth/revoke`,
      userinfo_endpoint: `${BASE}/oauth/userinfo`,
      discovered: false,
    });
    assert.equal(glc.METADATA_PATH, '/.well-known/oauth-authorization-server');
  });

  it('a reachable metadata document renames the endpoints (same origin only)', async () => {
    const fetchImpl = fakeFetch({ status: 200, body: {
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth2/authorize`,
      token_endpoint: `${BASE}/oauth2/token`,
      userinfo_endpoint: `${BASE}/oauth2/userinfo`,
      revocation_endpoint: 'https://evil.test/oauth/revoke',
    } });
    const ep = await glc.discoverEndpoints(BASE, { fetchImpl, timeoutMs: 50 });
    assert.equal(fetchImpl.calls[0].url, `${BASE}/.well-known/oauth-authorization-server`);
    assert.equal(ep.discovered, true);
    assert.equal(ep.authorization_endpoint, `${BASE}/oauth2/authorize`);
    assert.equal(ep.token_endpoint, `${BASE}/oauth2/token`);
    assert.equal(ep.userinfo_endpoint, `${BASE}/oauth2/userinfo`);
    assert.equal(ep.revocation_endpoint, `${BASE}/oauth/revoke`, 'a foreign host never replaces a fixed URL');
  });

  it('unreachable -> the fixed URLs', async () => {
    const ep = await glc.discoverEndpoints(BASE, { fetchImpl: fakeFetch(new Error('ECONNREFUSED')), timeoutMs: 50 });
    assert.equal(ep.discovered, false);
    assert.equal(ep.token_endpoint, `${BASE}/oauth/token`);
  });

  it('a 404 or a non-object body -> the fixed URLs', async () => {
    glc.resetDiscoveryCache();
    assert.equal((await glc.discoverEndpoints(BASE, { fetchImpl: fakeFetch({ status: 404, body: {} }), timeoutMs: 50 })).discovered, false);
    glc.resetDiscoveryCache();
    assert.equal((await glc.discoverEndpoints(BASE, { fetchImpl: fakeFetch({ status: 200, body: 'not json' }), timeoutMs: 50 })).authorization_endpoint, `${BASE}/oauth/authorize`);
  });

  it('a hung metadata read hits the deadline and falls back', async () => {
    const fetchImpl = (url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    const started = Date.now();
    const ep = await glc.discoverEndpoints(BASE, { fetchImpl, timeoutMs: 30 });
    assert.ok(Date.now() - started < 1000);
    assert.equal(ep.discovered, false);
  });

  it('reads the document once per process (second call does not fetch again)', async () => {
    const fetchImpl = fakeFetch({ status: 200, body: { token_endpoint: `${BASE}/oauth2/token` } });
    const a = await glc.discoverEndpoints(BASE, { fetchImpl, timeoutMs: 50 });
    const b = await glc.discoverEndpoints(`${BASE}/`, { fetchImpl, timeoutMs: 50 });
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(a, b);
  });

  it('the default deadline is 5 s and the fixed URLs are the default base', () => {
    assert.equal(glc.GLUECRON_OAUTH_TIMEOUT_MS, 5000);
    assert.equal(glc.DEFAULT_GLUECRON_BASE_URL, 'https://gluecron.com');
  });
});

describe('base URL — one env resolution', () => {
  it('GLUECRON_OAUTH_BASE_URL > GLUECRON_BASE_URL > default; trailing slash dropped; junk -> default', () => {
    assert.equal(glc.gluecronOAuthBaseUrl({}), 'https://gluecron.com');
    assert.equal(glc.gluecronOAuthBaseUrl({ GLUECRON_BASE_URL: 'https://staging.gluecron.com/' }), 'https://staging.gluecron.com');
    assert.equal(glc.gluecronOAuthBaseUrl({ GLUECRON_BASE_URL: 'https://a.test', GLUECRON_OAUTH_BASE_URL: 'https://b.test' }), 'https://b.test');
    assert.equal(glc.gluecronOAuthBaseUrl({ GLUECRON_OAUTH_BASE_URL: 'not a url' }), 'https://gluecron.com');
    assert.equal(glc.gluecronOAuthBaseUrl({ GLUECRON_OAUTH_BASE_URL: 'ftp://x.test' }), 'https://gluecron.com');
  });
});

describe('request shapes', () => {
  it('authorize URL: response_type=code, scope read:user only, S256 challenge, state', () => {
    const u = new URL(glc.authorizeUrl(glc.fixedEndpoints(BASE), {
      clientId: 'cid', redirectUri: 'https://gatetest.io/api/auth/gluecron/callback', state: 'st', challenge: 'ch',
    }));
    assert.equal(u.origin + u.pathname, `${BASE}/oauth/authorize`);
    assert.equal(u.searchParams.get('response_type'), 'code');
    assert.equal(u.searchParams.get('scope'), 'read:user');
    assert.equal(u.searchParams.get('code_challenge'), 'ch');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(u.searchParams.get('state'), 'st');
    assert.equal(u.searchParams.get('client_id'), 'cid');
    assert.equal(u.searchParams.get('redirect_uri'), 'https://gatetest.io/api/auth/gluecron/callback');
  });

  it('token body: authorization_code + code_verifier; client_secret only when set (public client otherwise)', () => {
    const pub = glc.tokenRequestBody({ clientId: 'cid', code: 'c', redirectUri: 'r', verifier: 'v' });
    assert.equal(pub.get('grant_type'), 'authorization_code');
    assert.equal(pub.get('code_verifier'), 'v');
    assert.equal(pub.has('client_secret'), false);
    const conf = glc.tokenRequestBody({ clientId: 'cid', clientSecret: 's', code: 'c', redirectUri: 'r', verifier: 'v' });
    assert.equal(conf.get('client_secret'), 's');
  });
});

describe('userinfo -> session', () => {
  const full = { sub: '42', preferred_username: 'craig', login: 'craig', name: 'Craig', email: 'c@example.test', email_verified: true };

  it('a verified profile yields login + email', () => {
    assert.deepEqual(glc.profileFromUserinfo(200, full), { ok: true, login: 'craig', email: 'c@example.test' });
  });

  it('404 (userinfo not deployed yet) -> user_failed, never a session', () => {
    assert.deepEqual(glc.profileFromUserinfo(404, { error: 'not found' }), { ok: false, reason: 'user_failed' });
    assert.deepEqual(glc.profileFromUserinfo(404, full), { ok: false, reason: 'user_failed' }, 'a body on a 404 is still not a profile');
  });

  it('a non-object body or no login -> user_failed', () => {
    assert.equal(glc.profileFromUserinfo(200, null).reason, 'user_failed');
    assert.equal(glc.profileFromUserinfo(200, 'x').reason, 'user_failed');
    assert.equal(glc.profileFromUserinfo(200, { email: 'c@example.test', email_verified: true }).reason, 'user_failed');
  });

  it('email_verified must be exactly true', () => {
    for (const v of [false, undefined, 'true', 1]) {
      assert.equal(glc.profileFromUserinfo(200, { ...full, email_verified: v }).reason, 'email_unverified', String(v));
    }
    assert.equal(glc.profileFromUserinfo(200, { ...full, email: '' }).reason, 'email_unverified');
  });

  it('login falls back preferred_username -> name -> sub', () => {
    assert.equal(glc.profileFromUserinfo(200, { ...full, login: undefined }).login, 'craig');
    assert.equal(glc.profileFromUserinfo(200, { ...full, login: undefined, preferred_username: undefined }).login, 'Craig');
    assert.equal(glc.profileFromUserinfo(200, { sub: '42', email: 'c@example.test', email_verified: true }).login, '42');
  });
});

describe('route wiring (source level)', () => {
  const init = read('app/api/auth/gluecron/route.ts');
  const cb = read('app/api/auth/gluecron/callback/route.ts');

  it('initiate: PKCE pair, S256 challenge in the redirect, verifier + state + next in httpOnly cookies (600 s)', () => {
    assert.match(init, /pkcePair\(\)/);
    assert.match(init, /authorizeUrl\(endpoints, \{ clientId, redirectUri, state, challenge \}\)/);
    for (const cookie of ['glc_oauth_state', 'glc_oauth_pkce', 'glc_oauth_next']) {
      assert.match(init, new RegExp(`cookieStore\\.set\\("${cookie}", \\w+, \\{\\s*httpOnly: true`), `${cookie} is httpOnly`);
    }
    assert.match(init, /const COOKIE_MAX_AGE = 600;/);
    assert.match(init, /authUnavailable\("Gluecron"\)/);
    assert.match(init, /discoverEndpoints\(gluecronBaseUrl\)/);
  });

  it('callback: state + verifier re-checked, PKCE verifier sent, userinfo read, session signed like Google', () => {
    assert.match(cb, /state !== storedState \|\| !isValidVerifier\(verifier\)/);
    assert.match(cb, /tokenRequestBody\(\{ clientId, clientSecret, code, redirectUri, verifier/);
    assert.match(cb, /endpoints\.token_endpoint/);
    assert.match(cb, /endpoints\.userinfo_endpoint/);
    assert.match(cb, /profileFromUserinfo\(userRes\.status, body\)/);
    assert.match(cb, /signCustomerSession\(login, email, sessionSecret\)/);
    // Same cookie shape as the Google callback.
    const google = read('app/api/auth/google/callback/route.ts');
    const cookieBlock = (s) => s.match(/response\.headers\.set\(\s*"Set-Cookie",[\s\S]*?\);/)[0];
    assert.equal(cookieBlock(cb), cookieBlock(google));
  });

  it('callback: every transient cookie is deleted on every path, every failure is /login?error=gluecron_<code>', () => {
    for (const cookie of ['glc_oauth_state', 'glc_oauth_pkce', 'glc_oauth_next']) {
      assert.match(cb, new RegExp(`cookieStore\\.delete\\("${cookie}"\\)`));
    }
    const codes = [...cb.matchAll(/\/login\?error=(\w+)`/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(codes)].sort(), ['gluecron_email_unverified', 'gluecron_invalid_state', 'gluecron_not_configured', 'gluecron_token_failed', 'gluecron_user_failed']);
    assert.doesNotMatch(cb, /\/dashboard\?error=/);
    const { ERROR_COPY } = require('../website/app/lib/sign-in-providers.js');
    for (const c of codes) assert.equal(typeof ERROR_COPY[c], 'string', `copy for ${c}`);
    assert.equal(ERROR_COPY.gluecron_user_failed, 'Gluecron did not return your profile. Start again.');
  });

  it('both upstream calls carry the 5 s deadline; nothing logs a token', () => {
    assert.equal((cb.match(/await fetchWithTimeout\(/g) || []).length, 2);
    assert.equal((cb.match(/^ {6}GLUECRON_OAUTH_TIMEOUT_MS,$/gm) || []).length, 2, 'each call passes the shared deadline');
    assert.doesNotMatch(cb, /console\./);
    assert.doesNotMatch(init, /console\./);
  });

  it('the getter: ok needs client id + SESSION_SECRET + NEXT_PUBLIC_BASE_URL; the secret is optional', () => {
    const src = read('app/lib/customer-session.ts');
    assert.match(src, /export function getGluecronOAuthConfig\(\)/);
    assert.match(src, /missing\.push\("GLUECRON_OAUTH_CLIENT_ID"\)/);
    assert.doesNotMatch(src, /missing\.push\("GLUECRON_OAUTH_CLIENT_SECRET"\)/);
    assert.match(src, /\/api\/auth\/gluecron\/callback/);
  });

  it('/api/status names the client id as IMPORTANT with a customer-visible why; secret + base URL are optional', () => {
    const src = read('app/api/status/route.ts');
    const important = src.slice(src.indexOf('export const IMPORTANT'), src.indexOf('const OPTIONAL'));
    assert.match(important, /\{ name: "GLUECRON_OAUTH_CLIENT_ID", why: "customer 'Sign in with Gluecron' button is absent from \/login until set/);
    const optional = src.slice(src.indexOf('const OPTIONAL'), src.indexOf('const ALIASES'));
    assert.match(optional, /"GLUECRON_OAUTH_CLIENT_SECRET", "GLUECRON_OAUTH_BASE_URL"/);
  });

  it('legal cookie table lists the three Gluecron cookies', () => {
    const facts = read('app/legal/_facts.js');
    for (const c of ['glc_oauth_state', 'glc_oauth_pkce', 'glc_oauth_next']) assert.match(facts, new RegExp(c));
  });
});
