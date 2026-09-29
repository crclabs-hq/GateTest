'use strict';
// =============================================================================
// SIGN-IN JOURNEY — issues #810 and #812.
// =============================================================================
// Before: /register, /signup, /sign-up 404'd; anonymous /login bounced to
// /dashboard, which answered 200 with a 48 KB shell and decided sign-in in the
// browser; /docs answered 307 with a 16 KB `__next_error__` body; GET /api was
// a 404. The gate is ONE definition, website/app/lib/session-gate.js, called
// by website/proxy.ts (Next 16's middleware). Route handlers cannot be
// require()d outside the Next build, so this file tests the shared modules
// directly and the wiring (proxy, next.config, pages) at source level; the
// live half is tests/heavy/signin-journey-live.test.js.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'website');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

const { requireSession, isProtectedPath, safeNext } = require('../website/app/lib/session-gate.js');
const { apiRootBody } = require('../website/app/lib/api-root.js');
const { DEFAULT_SITE_URL } = require('../website/app/lib/site-url.js');

// The app's own signing helper is TypeScript. Node 22.18+ / 24 load it
// directly; on an older Node the cookie tests skip loudly rather than fake it.
let customerSession = null;
try { customerSession = require('../website/app/lib/customer-session.ts'); } catch { /* error-ok — this Node cannot load .ts; the cookie tests skip loudly via `ts` below */ }
const SECRET = 'signin-gate-test-secret-not-a-real-credential-0123456789';
const ts = { skip: customerSession ? false : 'this Node cannot load .ts (needs 22.18+)' };

function gate(over) {
  return requireSession({
    pathname: '/dashboard', search: '', cookie: undefined, secret: SECRET,
    verify: customerSession && customerSession.verifyCustomerSession, ...over,
  });
}

describe('requireSession — anonymous requests are sent to /login, never served', () => {
  it('anonymous /dashboard -> 307 target /login?next=%2Fdashboard', () => {
    assert.deepEqual(gate({}), { ok: false, location: '/login?next=%2Fdashboard' });
  });

  it('keeps the sub-path and query in next', () => {
    assert.equal(gate({ pathname: '/dashboard/usage', search: '?window=30' }).location,
      '/login?next=%2Fdashboard%2Fusage%3Fwindow%3D30');
  });

  it('a cookie that is not a valid session is anonymous', ts, () => {
    assert.equal(gate({ cookie: 'v2.a.b.c.d' }).ok, false);
    assert.equal(gate({ cookie: 'garbage' }).ok, false);
  });

  it('a cookie signed with another secret is anonymous', ts, () => {
    const cookie = customerSession.signCustomerSession('someone', 'a@example.test', 'a-different-secret-entirely-0123456789');
    assert.equal(gate({ cookie }).ok, false);
  });

  it('fails closed with no SESSION_SECRET, even for a well-formed cookie', ts, () => {
    const cookie = customerSession.signCustomerSession('someone', 'a@example.test', SECRET);
    assert.equal(gate({ cookie, secret: '' }).ok, false);
  });

  it('CONTROL — a valid session cookie (app signing helper) is let through', ts, () => {
    const cookie = customerSession.signCustomerSession('someone', 'a@example.test', SECRET);
    const out = gate({ cookie });
    assert.equal(out.ok, true);
    assert.equal(out.session.u, 'someone');
    assert.equal(gate({ cookie, pathname: '/dashboard/usage' }).ok, true);
  });

  it('CONTROL — public pages are never gated', () => {
    for (const p of ['/', '/login', '/developers', '/pricing', '/playground', '/docs/api', '/api/health', '/dashboardx']) {
      assert.equal(gate({ pathname: p }).ok, true, `${p} must stay public`);
    }
  });

  it('CONTROL — the emailed unsubscribe link (?token=) works without sign-in; the settings page does not', () => {
    assert.equal(gate({ pathname: '/account/notifications', search: '?token=abc' }).ok, true);
    assert.equal(gate({ pathname: '/account/notifications' }).ok, false);
    assert.equal(isProtectedPath('/account/notifications', '?token='), true, 'an empty token is no proof');
  });
});

describe('safeNext — next is a same-origin path or nothing', () => {
  it('accepts plain paths with query', () => {
    assert.equal(safeNext('/dashboard'), '/dashboard');
    assert.equal(safeNext('/scan/status?id=1'), '/scan/status?id=1');
  });
  it('rejects every open-redirect shape', () => {
    for (const bad of ['https://evil.test/', '//evil.test', '/\\evil.test', 'dashboard', '', null, undefined,
      '/ok\r\nSet-Cookie: x=1', '/login', '/login?next=/dashboard', '/api/auth/github', 'x'.repeat(600)]) {
      assert.equal(safeNext(bad), null, `must reject ${JSON.stringify(bad)}`);
    }
  });
});

describe('GET /api root body', () => {
  const body = apiRootBody(DEFAULT_SITE_URL);
  it('says where the docs are and that api.<host> is not a host', () => {
    assert.equal(body.ok, true);
    assert.equal(body.docs, `${DEFAULT_SITE_URL}/developers`);
    const host = new URL(DEFAULT_SITE_URL).host;
    assert.equal(body.note, `the API lives under ${host}/api; api.${host} is not a host`);
  });
  it('the route serves it as JSON and imports the one definition', () => {
    const src = read('app/api/route.ts');
    assert.match(src, /NextResponse\.json\(apiRootBody\(siteUrl\(\)\)\)/);
    assert.doesNotMatch(src, /https:\/\/gatetest\./, 'no domain literal in runtime code');
  });
});

describe('wiring', () => {
  it('proxy.ts gates with the one requireSession and answers 307 with no body', () => {
    const src = read('proxy.ts');
    assert.match(src, /require\("\.\/app\/lib\/session-gate\.js"\)/);
    assert.match(src, /new NextResponse\(null,\s*\{\s*status: 307/);
    assert.match(src, /verifyCustomerSession/);
    assert.match(src, /CUSTOMER_COOKIE_NAME/);
  });

  it('there is exactly one session-gate definition (no second isProtectedPath / requireSession)', () => {
    const hits = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.next') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(ts|tsx|js)$/.test(e.name) && /function (requireSession|isProtectedPath)\b/.test(fs.readFileSync(full, 'utf8'))) hits.push(path.relative(WEB, full));
      }
    })(WEB);
    assert.deepEqual(hits, [path.join('app', 'lib', 'session-gate.js')]);
  });

  it('/login is a page (not a config redirect) that sends a signed-in visitor on to next or /dashboard', () => {
    assert.ok(fs.existsSync(path.join(WEB, 'app/login/page.tsx')));
    const page = read('app/login/page.tsx');
    assert.match(page, /redirect\(next \?\? "\/dashboard"\)/);
    // The provider list is the one definition in sign-in-providers.js; the
    // page renders it server-side (no client fetch of /api/auth/providers).
    assert.match(page, /signInProviders\(\{/);
    assert.doesNotMatch(page, /fetch\(/);
    assert.match(providersSrc, /Sign in with GitHub/);
    assert.match(providersSrc, /\/api\/auth\/github/);
    assert.doesNotMatch(read('next.config.ts'), /source: "\/login"/, 'a config redirect would shadow the page');
  });

  // GitHub (#819), Google and GitLab (owner directive 2026-09-29) all carry
  // next through a validated httpOnly cookie and land failures on /login.
  for (const [label, initiate, callback, cookie] of [
    ['GitHub', 'app/api/auth/github/route.ts', 'app/api/auth/callback/route.ts', 'gh_oauth_next'],
    ['Google', 'app/api/auth/google/route.ts', 'app/api/auth/google/callback/route.ts', 'goog_oauth_next'],
    ['GitLab', 'app/api/auth/gitlab/route.ts', 'app/api/auth/gitlab/callback/route.ts', 'gl_oauth_next'],
  ]) {
    it(`the ${label} OAuth round trip carries next and validates it both ways`, () => {
      const init = read(initiate);
      assert.match(init, /safeNext\(request\.nextUrl\.searchParams\.get\("next"\)\)/);
      assert.match(init, new RegExp(`cookieStore\\.set\\("${cookie}", next, \\{\\s*httpOnly: true`), 'next travels in an httpOnly cookie');
      const cb = read(callback);
      assert.match(cb, new RegExp(`safeNext\\(cookieStore\\.get\\("${cookie}"\\)\\?\\.value\\) \\?\\? "/dashboard"`));
      assert.match(cb, /NextResponse\.redirect\(`\$\{baseUrl\}\$\{landing\}`\)/, 'success lands on next');
      assert.match(cb, /\/login\?error=/, 'callback failures land where the message is shown');
      assert.doesNotMatch(cb, /\/dashboard\?error=/, 'anonymous /dashboard is gated - an error there is never seen');
    });
  }
});

// ── Providers on /login (owner directive 2026-09-29) ─────────────────────────
const providers = require('../website/app/lib/sign-in-providers.js');
const providersSrc = read('app/lib/sign-in-providers.js');

// The real getters, with the environment set per case. Every provider needs
// NEXT_PUBLIC_BASE_URL + SESSION_SECRET plus its own client id and secret.
function withEnv(vars, fn) {
  const keys = ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITLAB_CLIENT_ID', 'GITLAB_CLIENT_SECRET',
    'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'NEXT_PUBLIC_BASE_URL', 'SESSION_SECRET'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, vars);
  try { return fn(); } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

function available() {
  return {
    github: customerSession.getOAuthConfig().ok,
    google: customerSession.getGoogleOAuthConfig().ok,
    gitlab: customerSession.getGitLabOAuthConfig().ok,
  };
}

const BASE = { NEXT_PUBLIC_BASE_URL: 'https://example.test', SESSION_SECRET: SECRET };
const linksOf = (list) => list.filter((e) => e.href).map((e) => e.id);
const soonOf = (list) => list.filter((e) => !e.href).map((e) => e.id);

describe('/login providers — a button iff the provider is configured', () => {
  it('nothing configured: no buttons, only the honest coming-soon lines', ts, () => {
    const list = withEnv({}, () => providers.signInProviders({ available: available() }));
    assert.deepEqual(linksOf(list), []);
    assert.deepEqual(soonOf(list), ['gluecron', 'password']);
  });

  it('GitHub only (production today)', ts, () => {
    const list = withEnv({ ...BASE, GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 's' },
      () => providers.signInProviders({ available: available(), next: '/dashboard/usage' }));
    assert.deepEqual(linksOf(list), ['github']);
    assert.equal(list[0].label, 'Sign in with GitHub');
    assert.equal(list[0].href, '/api/auth/github?next=%2Fdashboard%2Fusage');
  });

  it('GitHub + Google (production once GOOGLE_CLIENT_ID/SECRET are set)', ts, () => {
    const list = withEnv({ ...BASE, GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 's', GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 'gs' },
      () => providers.signInProviders({ available: available() }));
    assert.deepEqual(linksOf(list), ['github', 'google']);
    assert.equal(list[1].label, 'Continue with Google');
    assert.equal(list[1].href, '/api/auth/google');
  });

  it('all three OAuth providers, GitLab last', ts, () => {
    const list = withEnv({ ...BASE, GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 's', GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 'gs', GITLAB_CLIENT_ID: 'l', GITLAB_CLIENT_SECRET: 'ls' },
      () => providers.signInProviders({ available: available(), next: '/scan/status?id=1' }));
    assert.deepEqual(linksOf(list), ['github', 'google', 'gitlab']);
    assert.equal(list[2].href, '/api/auth/gitlab?next=%2Fscan%2Fstatus%3Fid%3D1');
  });

  it('a provider with only a client id (no secret) is NOT offered', ts, () => {
    const list = withEnv({ ...BASE, GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 's', GOOGLE_CLIENT_ID: 'g' },
      () => providers.signInProviders({ available: available() }));
    assert.deepEqual(linksOf(list), ['github']);
  });

  it('no SESSION_SECRET: nothing is offered, whatever else is set', ts, () => {
    const list = withEnv({ NEXT_PUBLIC_BASE_URL: 'https://example.test', GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 's', GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 'gs' },
      () => providers.signInProviders({ available: available() }));
    assert.deepEqual(linksOf(list), []);
  });

  it('Gluecron is a muted line with no href and is not gated on any env var', () => {
    const list = providers.signInProviders({ available: { github: true, google: true, gitlab: true } });
    const glue = list.find((e) => e.id === 'gluecron');
    assert.equal(glue.href, undefined);
    assert.equal(glue.label, 'Sign in with Gluecron');
    assert.equal(glue.note, 'coming soon');
    assert.doesNotMatch(providersSrc, /process\.env/, 'the list is pure; the page passes the getters in');
    assert.doesNotMatch(read('app/login/page.tsx'), /GLUECRON_OAUTH/);
  });

  it('email + password links to /login/password only behind PASSWORD_AUTH_ENABLED', () => {
    const off = providers.signInProviders({ available: {}, passwordAuth: false }).find((e) => e.id === 'password');
    assert.equal(off.href, undefined);
    assert.equal(off.label, 'Email and password');
    const on = providers.signInProviders({ available: {}, passwordAuth: true, next: '/dashboard' }).find((e) => e.id === 'password');
    assert.equal(on.href, '/login/password?next=%2Fdashboard');
  });

  it('PASSWORD_AUTH_ENABLED is a boolean constant, and true only once /login/password exists', () => {
    const flags = read('app/lib/auth-features.ts');
    const m = flags.match(/export const PASSWORD_AUTH_ENABLED = (true|false);/);
    assert.ok(m, 'auth-features.ts must export a literal PASSWORD_AUTH_ENABLED');
    assert.match(read('app/login/page.tsx'), /passwordAuth: PASSWORD_AUTH_ENABLED/);
    if (m[1] === 'true') {
      assert.ok(fs.existsSync(path.join(WEB, 'app/login/password/page.tsx')), 'flag is on but app/login/password/page.tsx is missing');
    }
  });

  it('every error code a callback redirects with has copy', () => {
    for (const rel of ['app/api/auth/callback/route.ts', 'app/api/auth/google/callback/route.ts', 'app/api/auth/gitlab/callback/route.ts']) {
      const codes = [...read(rel).matchAll(/\/login\?error=(\w+)`/g)].map((m) => m[1]);
      assert.ok(codes.length >= 4, `${rel} redirects with ${codes.length} codes`);
      for (const code of codes) {
        assert.equal(typeof providers.ERROR_COPY[code], 'string', `${rel}: no copy for ${code}`);
        assert.notEqual(providers.errorMessage(code), providers.GENERIC_ERROR, `${rel}: ${code} falls through to the generic line`);
      }
    }
    assert.match(providers.errorMessage('google_token_failed'), /^Google /);
    assert.match(providers.errorMessage('gitlab_user_failed'), /^GitLab /);
    assert.equal(providers.errorMessage('nonsense'), providers.GENERIC_ERROR);
    assert.equal(providers.errorMessage(undefined), null);
  });

  it('copy: an account starts with any sign-in; no provider "needs" another; Gluecron spelled exactly', () => {
    const page = read('app/login/page.tsx');
    assert.match(page, /the first sign-in with any provider is how an account\s+starts/);
    assert.doesNotMatch(page, /signing in with GitHub is how an account starts/);
    for (const src of [page, providersSrc]) {
      assert.doesNotMatch(src, /needs? Gluecron/i);
      assert.doesNotMatch(src, /GlueCron|Glue Cron|glue cron/);
      assert.doesNotMatch(src, /Vapron/);
    }
  });
});

// ── Header CTA (owner directive 2026-09-29) ──────────────────────────────────
describe('header: Install Gluecron replaces Install GitHub App', () => {
  const nav = read('app/components/site-nav.ts');
  const navbar = read('app/components/Navbar.tsx');

  it('NAV_ACTIONS.install is pinned to Gluecron, external', () => {
    assert.match(nav, /install: \{ label: "Install Gluecron", href: "https:\/\/gluecron\.com", external: true \}/);
    assert.doesNotMatch(nav, /Install GitHub App/);
  });

  it('Navbar renders an external action as a new-tab anchor with rel="noopener", desktop and drawer', () => {
    assert.match(navbar, /action\.external \? \(\s*<a href=\{action\.href\}[^>]*target="_blank" rel="noopener noreferrer">/);
    assert.equal((navbar.match(/<ActionLink action=\{NAV_ACTIONS\.install\}/g) || []).length, 2, 'desktop + phone drawer');
    assert.doesNotMatch(navbar, /<Link href=\{NAV_ACTIONS\.install\.href\}/, 'a Next Link would not open a new tab');
  });

  it('no other header/nav surface still says "Install GitHub App"', () => {
    for (const rel of ['app/components/Navbar.tsx', 'app/components/Footer.tsx', 'app/components/SiteChrome.tsx', 'app/components/site-nav.ts']) {
      assert.doesNotMatch(read(rel), /Install GitHub App/, rel);
    }
  });

  it('the home hero keeps the GitHub App as the primary button and adds Install Gluecron beside it', () => {
    const home = read('app/page.tsx');
    assert.match(home, /<a href=\{appInstallUrl\(\)\} className="v2-btn v2-btn-primary">Install the GitHub App<\/a>\s*<a href="https:\/\/gluecron\.com" className="v2-btn" target="_blank" rel="noopener noreferrer">Install Gluecron<\/a>/);
  });
});

describe('next.config redirects', () => {
  const cfg = read('next.config.ts');

  it('/register, /signup, /sign-up -> /login with an explicit 301', () => {
    assert.match(cfg, /\["\/register", "\/signup", "\/sign-up"\]\.map\(\(source\) => \(\{\s*source,\s*destination: "\/login",\s*statusCode: 301,/);
    assert.match(cfg, /\.\.\.SIGNUP_URLS,/);
  });

  it('/docs, /scan, /scans are config redirects (307, empty body), not pages that call redirect()', () => {
    for (const [source, destination] of [['/docs', '/developers'], ['/scan', '/playground'], ['/scans', '/precision']]) {
      assert.match(cfg, new RegExp(`\\{ source: "${source}", destination: "${destination}", permanent: false \\}`), source);
      assert.ok(!fs.existsSync(path.join(WEB, 'app', source, 'page.tsx')), `${source}/page.tsx must not exist - a prerendered redirect page ships an __next_error__ body`);
    }
    assert.match(cfg, /\.\.\.REDIRECT_ONLY_ROUTES,/);
  });

  it('CONTROL — no other public page.tsx redirects unconditionally at top level', () => {
    const offenders = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.next' || e.name === 'admin' || e.name === 'api') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name === 'page.tsx') {
          const src = fs.readFileSync(full, 'utf8');
          // `export default function X() { redirect("/y"); }` and nothing else.
          if (/export default (async )?function \w+\([^)]*\)\s*\{\s*redirect\("[^"]+"\);?\s*\}/.test(src)) offenders.push(path.relative(WEB, full));
        }
      }
    })(path.join(WEB, 'app'));
    assert.deepEqual(offenders, []);
  });
});
