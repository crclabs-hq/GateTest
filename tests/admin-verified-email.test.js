'use strict';
/**
 * Admin access by a provider-verified email (owner requirement, 30 Sep 2026).
 *
 * The owner signs in with Google (or GitHub, Gluecron, email + password) and
 * expects to be the admin because his address is on the allowlist — he put
 * it into GATETEST_ADMIN_USERNAMES next to his GitHub login. Before this,
 * only the gt_admin password cookie or the separate GitHub admin OAuth
 * session opened /admin; a customer sign-in never did.
 *
 * The one allowlist is website/app/lib/admin-allowlist.ts; the one "who is
 * the admin" answer is getAdminLoginFromCookies (admin-session.ts), shared by
 * the /admin page, the admin layout and requireAdminRoute (admin-guard.ts).
 *
 * Every module is the real source, transpiled with the vendored `typescript`
 * (the harness tests/admin-route-guard.test.js uses). Only Next's runtime
 * pieces (NextResponse, cookies()) and the network (`fetch`, stubbed —
 * nothing leaves this process) are stood in for. Addresses are example.com.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'website');
const LIB = path.join(WEB, 'app', 'lib');
const TS_COMPILER_PATH = path.join(WEB, 'node_modules', 'typescript', 'lib', 'typescript.js');
const read = (p) => fs.readFileSync(p, 'utf8');

// ─── harness ────────────────────────────────────────────────────────────────

function loadTs(file, mocks = {}) {
  const ts = require(TS_COMPILER_PATH);
  const { outputText } = ts.transpileModule(read(file), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: file,
  });
  const m = new Module(file, module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  const realRequire = m.require.bind(m);
  m.require = (id) => (Object.prototype.hasOwnProperty.call(mocks, id) ? mocks[id] : realRequire(id));
  m._compile(outputText, file);
  return m.exports;
}

const fakeNextServer = {
  NextResponse: {
    json(body, init = {}) {
      return { body, status: init.status ?? 200, headers: { ...(init.headers || {}) } };
    },
    redirect(url, status = 307) {
      return { status, url: String(url), headers: new Headers({ location: String(url) }) };
    },
  },
};

function cookieReader(cookies = {}) {
  return {
    get(name) {
      return Object.prototype.hasOwnProperty.call(cookies, name) ? { name, value: cookies[name] } : undefined;
    },
  };
}

function fakeReq({ method = 'GET', cookies = {}, headers = {} } = {}) {
  return { method, headers: new Headers(headers), cookies: cookieReader(cookies) };
}

/** A browser cookie jar shared by the start route and the callback. */
function cookieJar() {
  const jar = new Map();
  return {
    jar,
    get(name) { return jar.has(name) ? { name, value: jar.get(name) } : undefined; },
    set(name, value) { jar.set(name, value); },
    delete(name) { jar.delete(name); },
  };
}

const OWNER_LOGIN = 'owner-login';
const OWNER_EMAIL = 'owner@example.com';
const SECOND_EMAIL = 'second-admin@example.com';
const STRANGER_EMAIL = 'someone@example.com';
const BASE = 'https://gatetest.example';

const ENV_KEYS = [
  'GATETEST_ADMIN_PASSWORD', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'NEXT_PUBLIC_BASE_URL',
  'GITHUB_OAUTH_REDIRECT_URI', 'SESSION_SECRET', 'GATETEST_ADMIN_USERNAMES', 'GATETEST_ADMIN_EMAILS',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
];
const PASSWORD = 'verified-email-test-' + crypto.randomBytes(6).toString('hex');
const SESSION_SECRET = crypto.randomBytes(24).toString('hex');
const passwordToken = (pw) => crypto.createHmac('sha256', pw).update('gatetest-admin-v1').digest('hex');

let allowlistMod, cs, session, guard, saved;

before(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.GATETEST_ADMIN_PASSWORD = PASSWORD;
  process.env.GITHUB_CLIENT_ID = 'test-client';
  process.env.GITHUB_CLIENT_SECRET = 'test-client-value';
  process.env.NEXT_PUBLIC_BASE_URL = BASE;
  delete process.env.GITHUB_OAUTH_REDIRECT_URI;
  process.env.SESSION_SECRET = SESSION_SECRET;
  // The owner's box shape: ONE line, a GitHub login and an email, comma-separated.
  process.env.GATETEST_ADMIN_USERNAMES = `${OWNER_LOGIN}, ${OWNER_EMAIL}`;
  delete process.env.GATETEST_ADMIN_EMAILS;
  process.env.GOOGLE_CLIENT_ID = 'google-test-client';
  process.env.GOOGLE_CLIENT_SECRET = 'google-test-client-value';

  const policy = require(path.join(LIB, 'password-auth-policy.js'));
  const { siteUrl } = require(path.join(LIB, 'site-url.js'));
  // Same call as csrfOk() in password-auth-http.ts (pinned in admin-route-guard.test.js).
  const csrfOk = (req) => {
    const h = req.headers;
    return policy.checkSameOrigin({
      origin: h.get('origin'), secFetchSite: h.get('sec-fetch-site'), host: h.get('host'),
      forwardedHost: h.get('x-forwarded-host'), forwardedProto: h.get('x-forwarded-proto'),
    }, siteUrl()).ok;
  };
  const auth = loadTs(path.join(LIB, 'admin-auth.ts'), { 'next/server': fakeNextServer });
  allowlistMod = loadTs(path.join(LIB, 'admin-allowlist.ts'));
  cs = loadTs(path.join(LIB, 'customer-session.ts'));
  session = loadTs(path.join(LIB, 'admin-session.ts'), {
    './admin-auth': auth, './admin-allowlist': allowlistMod, './customer-session': cs,
  });
  guard = loadTs(path.join(LIB, 'admin-guard.ts'), {
    'next/server': fakeNextServer, './admin-auth': auth, './admin-session': session,
    './password-auth-http': { csrfOk },
  });
});

after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** A customer session cookie exactly as a sign-in callback signs it. */
function customerCookie(email, verified, { login = 'someone', secret = SESSION_SECRET } = {}) {
  return cs.signCustomerSession(login, email, secret, undefined, verified);
}
const adminOf = (cookies) => session.getAdminLoginFromCookies(cookieReader(cookies));
const withCustomer = (token) => ({ gatetest_customer: token });

function withEnv(over, fn) {
  const before = Object.fromEntries(Object.keys(over).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ─── 1. the one allowlist ───────────────────────────────────────────────────

describe('getAdminAllowlist — one definition, two variables', () => {
  it('the box shape "login, email" on one line: the login is a login, the email an email', () => {
    const a = allowlistMod.getAdminAllowlist({ GATETEST_ADMIN_USERNAMES: `${OWNER_LOGIN}, ${OWNER_EMAIL}` });
    assert.deepEqual(a, { logins: [OWNER_LOGIN], emails: [OWNER_EMAIL] });
  });

  it('GATETEST_ADMIN_EMAILS adds addresses; entries are trimmed, lower-cased, de-duplicated', () => {
    const a = allowlistMod.getAdminAllowlist({
      GATETEST_ADMIN_USERNAMES: ' Owner-Login ,Owner@Example.com',
      GATETEST_ADMIN_EMAILS: ` ${SECOND_EMAIL.toUpperCase()} , owner@example.com,,`,
    });
    assert.deepEqual(a, { logins: [OWNER_LOGIN], emails: [OWNER_EMAIL, SECOND_EMAIL] });
  });

  it('CONTROL — junk is neither: a bare "@", two @s, a non-address in the EMAILS list', () => {
    const a = allowlistMod.getAdminAllowlist({
      GATETEST_ADMIN_USERNAMES: '@, a@b@example.com, @example.com, owner@',
      GATETEST_ADMIN_EMAILS: 'not-an-address',
    });
    assert.deepEqual(a, { logins: [], emails: [] });
  });

  it('unset → empty', () => {
    assert.deepEqual(allowlistMod.getAdminAllowlist({}), { logins: [], emails: [] });
  });
});

// ─── 2. who is the admin ────────────────────────────────────────────────────

describe('getAdminLoginFromCookies — customer sign-in with a verified, allowlisted email', () => {
  it('allowlisted + provider-verified (a Google session) → admin, labelled by the email', () => {
    assert.equal(adminOf(withCustomer(customerCookie(OWNER_EMAIL, true))), OWNER_EMAIL);
  });

  it('the address matches case-insensitively and is reported lower-cased', () => {
    assert.equal(adminOf(withCustomer(customerCookie('Owner@Example.COM', true))), OWNER_EMAIL);
  });

  it('allowlisted but NOT verified → not admin (flag false, and flag absent)', () => {
    assert.equal(adminOf(withCustomer(customerCookie(OWNER_EMAIL, false))), null);
    assert.equal(adminOf(withCustomer(cs.signCustomerSession('someone', OWNER_EMAIL, SESSION_SECRET))), null);
  });

  it('verified but NOT allowlisted → not admin', () => {
    assert.equal(adminOf(withCustomer(customerCookie(STRANGER_EMAIL, true))), null);
  });

  it('the email entry inside GATETEST_ADMIN_USERNAMES works; GATETEST_ADMIN_EMAILS works too', () => {
    assert.equal(adminOf(withCustomer(customerCookie(OWNER_EMAIL, true))), OWNER_EMAIL);
    withEnv({ GATETEST_ADMIN_EMAILS: SECOND_EMAIL }, () => {
      assert.equal(adminOf(withCustomer(customerCookie(SECOND_EMAIL, true))), SECOND_EMAIL);
    });
    assert.equal(adminOf(withCustomer(customerCookie(SECOND_EMAIL, true))), null, 'only while listed');
  });

  it('a verified session signed with another secret, or no SESSION_SECRET at all → not admin', () => {
    const forged = customerCookie(OWNER_EMAIL, true, { secret: crypto.randomBytes(24).toString('hex') });
    assert.equal(adminOf(withCustomer(forged)), null);
    const good = customerCookie(OWNER_EMAIL, true);
    withEnv({ SESSION_SECRET: undefined }, () => assert.equal(adminOf(withCustomer(good)), null));
  });

  it('CONTROL — a customer sign-in whose LOGIN is allowlisted is still not admin (logins admit only the GitHub admin OAuth)', () => {
    assert.equal(adminOf(withCustomer(customerCookie(STRANGER_EMAIL, true, { login: OWNER_LOGIN }))), null);
  });

  it('getCustomerAdminStatus says "signed in, not admin" for a non-admin session and nothing when signed out', () => {
    assert.deepEqual(session.getCustomerAdminStatus(cookieReader(withCustomer(customerCookie(STRANGER_EMAIL, true)))),
      { signedIn: true, email: null });
    assert.deepEqual(session.getCustomerAdminStatus(cookieReader({})), { signedIn: false, email: null });
  });
});

describe('getAdminLoginFromCookies — the GitHub admin OAuth and the password cookie behave as before', () => {
  it('GitHub admin session on the login allowlist → the login; off it → null; forged → null', () => {
    assert.equal(adminOf({ gatetest_admin_session: session.signSession(OWNER_LOGIN, SESSION_SECRET) }), OWNER_LOGIN);
    assert.equal(adminOf({ gatetest_admin_session: session.signSession('someone-else', SESSION_SECRET) }), null);
    assert.equal(adminOf({ gatetest_admin_session: session.signSession(OWNER_LOGIN, 'wrong-secret') }), null);
  });

  it('getAdminConfig().allowlist holds the GitHub logins (the email entry is not a login)', () => {
    const status = session.getAdminConfig();
    assert.equal(status.ok, true);
    assert.deepEqual(status.config.allowlist, [OWNER_LOGIN]);
  });

  it('the password cookie → "admin"; a wrong one → null; with the password unset → null', () => {
    assert.equal(adminOf({ gt_admin: passwordToken(PASSWORD) }), 'admin');
    assert.equal(adminOf({ gt_admin: passwordToken('not-the-password') }), null);
    withEnv({ GATETEST_ADMIN_PASSWORD: undefined }, () => assert.equal(adminOf({ gt_admin: passwordToken(PASSWORD) }), null));
  });

  it('a GitHub admin session wins over a customer email, which wins over the password cookie (the label)', () => {
    const all = {
      gatetest_admin_session: session.signSession(OWNER_LOGIN, SESSION_SECRET),
      gatetest_customer: customerCookie(OWNER_EMAIL, true),
      gt_admin: passwordToken(PASSWORD),
    };
    assert.equal(adminOf(all), OWNER_LOGIN);
    delete all.gatetest_admin_session;
    assert.equal(adminOf(all), OWNER_EMAIL);
    delete all.gatetest_customer;
    assert.equal(adminOf(all), 'admin');
  });
});

describe('requireAdminRoute accepts the same session', () => {
  const owner = () => withCustomer(customerCookie(OWNER_EMAIL, true));

  it('GET with an allowlisted, verified customer session → passes; adminLoginOf names the email', () => {
    assert.equal(guard.requireAdminRoute(fakeReq({ cookies: owner() })), null);
    assert.equal(guard.adminLoginOf(fakeReq({ cookies: owner() })), OWNER_EMAIL);
  });

  it('unverified, or not allowlisted → 401', () => {
    assert.equal(guard.requireAdminRoute(fakeReq({ cookies: withCustomer(customerCookie(OWNER_EMAIL, false)) })).status, 401);
    assert.equal(guard.requireAdminRoute(fakeReq({ cookies: withCustomer(customerCookie(STRANGER_EMAIL, true)) })).status, 401);
  });

  it('writes still need same-origin: cross-site POST → 403, same-origin POST → passes', () => {
    const cross = fakeReq({ method: 'POST', cookies: owner(), headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(guard.requireAdminRoute(cross, { mutating: true }).status, 403);
    const same = fakeReq({ method: 'POST', cookies: owner(), headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(guard.requireAdminRoute(same, { mutating: true }), null);
  });
});

// ─── 3. the verified flag, per provider ─────────────────────────────────────

describe('githubSessionEmail — GitHub says whether the address is verified', () => {
  const list = [
    { email: OWNER_EMAIL, primary: true, verified: true },
    { email: STRANGER_EMAIL, primary: false, verified: false },
  ];
  it('public email found verified in /user/emails → verified', () => {
    assert.deepEqual(cs.githubSessionEmail(OWNER_EMAIL, list), { email: OWNER_EMAIL, verified: true });
  });
  it('public email listed unverified, or missing from the list, or the list unreadable → NOT verified', () => {
    assert.deepEqual(cs.githubSessionEmail(STRANGER_EMAIL, list), { email: STRANGER_EMAIL, verified: false });
    assert.deepEqual(cs.githubSessionEmail(SECOND_EMAIL, list), { email: SECOND_EMAIL, verified: false });
    assert.deepEqual(cs.githubSessionEmail(OWNER_EMAIL, { message: 'Bad credentials' }), { email: OWNER_EMAIL, verified: false });
  });
  it('no public email: the primary verified address; else the first listed, verified only if GitHub says so', () => {
    assert.deepEqual(cs.githubSessionEmail(null, list), { email: OWNER_EMAIL, verified: true });
    assert.deepEqual(cs.githubSessionEmail('', [{ email: STRANGER_EMAIL, primary: true, verified: false }]),
      { email: STRANGER_EMAIL, verified: false });
    assert.deepEqual(cs.githubSessionEmail('', []), { email: '', verified: false });
  });
});

describe('each sign-in records verification the way its provider proves it (source pins)', () => {
  const src = (rel) => read(path.join(WEB, rel));
  it('GitHub: the verified flag from githubSessionEmail rides into the session', () => {
    const s = src('app/api/auth/callback/route.ts');
    assert.match(s, /const picked = githubSessionEmail\(profileEmail, emails\);/);
    assert.match(s, /signCustomerSession\(login, email, sessionSecret, accessToken, emailVerified\)/);
  });
  it('Google: verified_email / email_verified must be exactly true', () => {
    const s = src('app/api/auth/google/callback/route.ts');
    assert.match(s, /emailVerified = Boolean\(email\) && \(user\.verified_email === true \|\| user\.email_verified === true\);/);
    assert.match(s, /signCustomerSession\(login, email, sessionSecret, undefined, emailVerified\)/);
  });
  it('Gluecron: signed verified only after profileFromUserinfo refused unverified addresses', () => {
    const s = src('app/api/auth/gluecron/callback/route.ts');
    assert.ok(s.indexOf('profileFromUserinfo(') < s.indexOf('signCustomerSession(login, email, sessionSecret, undefined, true)'));
    assert.match(read(path.join(LIB, 'gluecron-oauth.js')), /if \(!email \|\| u\.email_verified !== true\) return \{ ok: false, reason: 'email_unverified' \};/);
  });
  it('email + password: signed verified, and login() refuses an address without email_verified_at', () => {
    assert.match(src('app/lib/password-auth-http.ts'), /signCustomerSession\(sessionLogin\(customer\), customer\.email, sessionSecret\(\), undefined, true\)/);
    assert.match(read(path.join(LIB, 'password-auth-core.js')), /if \(!customer\.email_verified_at\) \{[\s\S]{0,400}return result\(false, 403, 'unverified'\);/);
  });
  it('CONTROL — GitLab records no verification, so a GitLab sign-in never opens /admin', () => {
    assert.match(src('app/api/auth/gitlab/callback/route.ts'), /signCustomerSession\(login, email, sessionSecret\);/);
  });
});

// ─── 4. Google from the admin login page, end to end ────────────────────────

describe('"Sign in with Google" on /admin: next=/admin rides through the OAuth round-trip', () => {
  let startRoute, callbackRoute, jar, realFetch;

  before(() => {
    const sessionGate = require(path.join(LIB, 'session-gate.js'));
    jar = cookieJar();
    const headersMock = { cookies: async () => jar };
    startRoute = loadTs(path.join(WEB, 'app', 'api', 'auth', 'google', 'route.ts'), {
      'next/server': fakeNextServer, 'next/headers': headersMock,
      '../../../lib/customer-session': cs, '../../../lib/session-gate': sessionGate,
      '../../../lib/auth-unavailable': { authUnavailable: (p) => ({ status: 503, provider: p }) },
    });
    callbackRoute = loadTs(path.join(WEB, 'app', 'api', 'auth', 'google', 'callback', 'route.ts'), {
      'next/server': fakeNextServer, 'next/headers': headersMock,
      '../../../../lib/customer-session': cs, '../../../../lib/session-gate': sessionGate,
    });
    realFetch = globalThis.fetch;
  });
  after(() => { globalThis.fetch = realFetch; });

  /** Run start → Google (stubbed) → callback; return the landing and the session cookie. */
  async function roundTrip(profile) {
    jar.jar.clear();
    const startRes = await startRoute.GET({ nextUrl: new URL(`${BASE}/api/auth/google?next=%2Fadmin`) });
    assert.match(startRes.url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    const state = new URL(startRes.url).searchParams.get('state');
    assert.equal(jar.get('goog_oauth_next').value, '/admin', 'the start route stored next=/admin');

    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (String(url) === 'https://oauth2.googleapis.com/token') return { json: async () => ({ access_token: 'stub-access' }) };
      if (String(url) === 'https://www.googleapis.com/oauth2/v2/userinfo') return { json: async () => profile };
      throw new Error(`unexpected fetch ${url}`);
    };
    try {
      const res = await callbackRoute.GET({ url: `${BASE}/api/auth/google/callback?code=stub-code&state=${state}` });
      assert.deepEqual(calls, ['https://oauth2.googleapis.com/token', 'https://www.googleapis.com/oauth2/v2/userinfo']);
      const setCookie = res.headers.get('set-cookie') || '';
      const token = (setCookie.match(/^gatetest_customer=([^;]+)/) || [])[1] || null;
      return { landing: res.url, token };
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  it('allowlisted + verified_email:true → lands on /admin AS the admin', async () => {
    const { landing, token } = await roundTrip({ email: OWNER_EMAIL, verified_email: true, name: 'Owner' });
    assert.equal(landing, `${BASE}/admin`);
    assert.ok(token, 'a session cookie was set');
    assert.equal(adminOf(withCustomer(token)), OWNER_EMAIL);
  });

  it('allowlisted but verified_email:false → lands on /admin, NOT the admin, "not an admin" state', async () => {
    const { landing, token } = await roundTrip({ email: OWNER_EMAIL, verified_email: false, name: 'Owner' });
    assert.equal(landing, `${BASE}/admin`);
    assert.equal(adminOf(withCustomer(token)), null);
    assert.deepEqual(session.getCustomerAdminStatus(cookieReader(withCustomer(token))), { signedIn: true, email: null });
  });

  it('not allowlisted → lands on /admin, never the admin', async () => {
    const { landing, token } = await roundTrip({ email: STRANGER_EMAIL, verified_email: true, name: 'Someone' });
    assert.equal(landing, `${BASE}/admin`);
    assert.equal(adminOf(withCustomer(token)), null);
  });

  it('CONTROL — an off-site next is dropped by safeNext: the landing is /dashboard', async () => {
    jar.jar.clear();
    await startRoute.GET({ nextUrl: new URL(`${BASE}/api/auth/google?next=https%3A%2F%2Fevil.example%2F`) });
    assert.equal(jar.get('goog_oauth_next'), undefined);
  });
});

// ─── 5. the admin login page ────────────────────────────────────────────────

describe('/admin login page — Google button and the not-an-admin message', () => {
  let React, renderToStaticMarkup, AdminLogin, page, jarStore;

  before(() => {
    React = require(path.join(WEB, 'node_modules', 'react'));
    ({ renderToStaticMarkup } = require(path.join(WEB, 'node_modules', 'react-dom', 'server')));
    const link = { __esModule: true, default: ({ href, children, className }) => React.createElement('a', { href, className }, children) };
    AdminLogin = loadTs(path.join(WEB, 'app', 'admin', 'AdminLogin.tsx'), { 'next/link': link });
    jarStore = { cookies: {} };
    page = loadTs(path.join(WEB, 'app', 'admin', 'page.tsx'), {
      'next/headers': { cookies: async () => cookieReader(jarStore.cookies) },
      '../lib/admin-session': session,
      '../lib/customer-session': cs,
      './AdminPanel': { __esModule: true, default: ({ adminLogin }) => React.createElement('main', { 'data-admin': adminLogin }, 'ADMIN PANEL') },
      './AdminLogin': AdminLogin,
    });
  });

  const renderLogin = (props) => renderToStaticMarkup(React.createElement(AdminLogin.default, { hasGitHubOAuth: true, hasPasswordAuth: true, ...props }));
  async function renderPage(cookies) {
    jarStore.cookies = cookies;
    return renderToStaticMarkup(await page.default({ searchParams: Promise.resolve({}) }));
  }

  it('AdminLogin: the Google button is there only when hasGoogleOAuth, and it starts Google with next=/admin', () => {
    const on = renderLogin({ hasGoogleOAuth: true });
    assert.match(on, /<a href="\/api\/auth\/google\?next=%2Fadmin"[^>]*>Sign in with Google<\/a>/);
    assert.match(on, /Sign in with GitHub/);
    assert.match(on, /id="admin-password"/);
    const off = renderLogin({ hasGoogleOAuth: false });
    assert.doesNotMatch(off, /Sign in with Google/);
  });

  it('AdminLogin: "This account is not an admin." only when signedInNotAdmin', () => {
    assert.match(renderLogin({ signedInNotAdmin: true }), /This account is not an admin\./);
    assert.doesNotMatch(renderLogin({ signedInNotAdmin: false }), /not an admin/);
  });

  it('/admin page: Google configured → button; GOOGLE_CLIENT_ID unset → no button', async () => {
    assert.match(await renderPage({}), /Sign in with Google/);
    const id = process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_ID;
    try {
      assert.doesNotMatch(await renderPage({}), /Sign in with Google/);
    } finally {
      process.env.GOOGLE_CLIENT_ID = id;
    }
  });

  it('/admin page: a signed-in non-admin sees the message; an allowlisted verified one gets the panel', async () => {
    const stranger = await renderPage(withCustomer(customerCookie(STRANGER_EMAIL, true)));
    assert.match(stranger, /This account is not an admin\./);
    assert.doesNotMatch(stranger, /ADMIN PANEL/);
    const unverified = await renderPage(withCustomer(customerCookie(OWNER_EMAIL, false)));
    assert.match(unverified, /This account is not an admin\./);
    const owner = await renderPage(withCustomer(customerCookie(OWNER_EMAIL, true)));
    assert.match(owner, /<main data-admin="owner@example\.com">ADMIN PANEL<\/main>/);
    assert.doesNotMatch(await renderPage({}), /not an admin/, 'signed out: no message');
  });
});

// ─── 6. documented ──────────────────────────────────────────────────────────

describe('GATETEST_ADMIN_EMAILS is documented and reserved', () => {
  it('.env.example, env-catalogue.js (with a why) and the secrets panel reserved list', () => {
    assert.match(read(path.join(WEB, '.env.example')), /^GATETEST_ADMIN_EMAILS=$/m);
    const cat = require(path.join(LIB, 'env-catalogue.js'));
    const flat = JSON.stringify(cat);
    assert.ok(flat.includes('GATETEST_ADMIN_EMAILS'), 'catalogue names it');
    assert.match(read(path.join(LIB, 'env-catalogue.js')), /\{ name: "GATETEST_ADMIN_EMAILS", why: "[^"]{20,}" \}/);
    assert.match(read(path.join(LIB, 'secrets', 'reserved.js')), /name: 'GATETEST_ADMIN_EMAILS', reason: /);
  });
});
