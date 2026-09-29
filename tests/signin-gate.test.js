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
try { customerSession = require('../website/app/lib/customer-session.ts'); } catch { /* skipped below */ }
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
    assert.match(page, /Sign in with GitHub/);
    assert.match(page, /\/api\/auth\/github\?next=/);
    assert.doesNotMatch(read('next.config.ts'), /source: "\/login"/, 'a config redirect would shadow the page');
  });

  it('the OAuth round trip carries next and validates it both ways', () => {
    assert.match(read('app/api/auth/github/route.ts'), /safeNext\(request\.nextUrl\.searchParams\.get\("next"\)\)/);
    const cb = read('app/api/auth/callback/route.ts');
    assert.match(cb, /safeNext\(cookieStore\.get\("gh_oauth_next"\)\?\.value\) \?\? "\/dashboard"/);
    assert.match(cb, /\/login\?error=/, 'callback failures land where the message is shown');
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
