const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const LiveCrawlerModule = require('../src/modules/live-crawler');
const {
  resolveAuth, authHeadersFor, isLoginUrl, parseCookiesForBrowser, expandEnv,
} = require('../src/modules/live-crawler-auth');

describe('LiveCrawlerModule — baseline shape', () => {
  it('exposes the expected BaseModule shape', () => {
    const mod = new LiveCrawlerModule();
    assert.strictEqual(typeof mod.name, 'string');
    assert.ok(mod.name.length > 0);
    assert.strictEqual(typeof mod.description, 'string');
    assert.ok(mod.description.length > 0);
    assert.strictEqual(typeof mod.run, 'function');
  });
});

describe('live-crawler-auth — unit', () => {
  it('expandEnv substitutes ${VAR} from the environment and leaves unknowns intact', () => {
    process.env.GT_TEST_CRAWL_TOKEN = 'sekret-123';
    assert.strictEqual(expandEnv('Bearer ${GT_TEST_CRAWL_TOKEN}'), 'Bearer sekret-123');
    assert.strictEqual(expandEnv('x-${GT_TEST_NOPE_UNSET}-y'), 'x-${GT_TEST_NOPE_UNSET}-y');
    delete process.env.GT_TEST_CRAWL_TOKEN;
  });

  it('resolveAuth is disabled with no auth config', () => {
    const auth = resolveAuth({}, 'https://example.com');
    assert.strictEqual(auth.enabled, false);
    assert.strictEqual(authHeadersFor('https://example.com/x', auth), undefined);
  });

  it('resolveAuth folds a header literally named Cookie into the cookie field', () => {
    const auth = resolveAuth(
      { headers: { 'Cookie': 'a=1', 'Authorization': 'Bearer t' }, cookie: 'b=2' },
      'https://example.com'
    );
    assert.strictEqual(auth.headers.Cookie, undefined);
    assert.strictEqual(auth.headers.Authorization, 'Bearer t');
    assert.ok(auth.cookie.includes('a=1') && auth.cookie.includes('b=2'));
  });

  it('resolveAuth expands ${ENV_VAR} in header and cookie values', () => {
    process.env.GT_TEST_CRAWL_TOKEN = 'tok-9';
    const auth = resolveAuth(
      { headers: { Authorization: 'Bearer ${GT_TEST_CRAWL_TOKEN}' }, cookie: 'session=${GT_TEST_CRAWL_TOKEN}' },
      'https://example.com'
    );
    assert.strictEqual(auth.headers.Authorization, 'Bearer tok-9');
    assert.strictEqual(auth.cookie, 'session=tok-9');
    delete process.env.GT_TEST_CRAWL_TOKEN;
  });

  it('resolveAuth flags a missing storageState file instead of silently ignoring it', () => {
    const auth = resolveAuth({ storageState: path.join(os.tmpdir(), 'gt-definitely-missing.json') }, 'https://example.com');
    assert.strictEqual(auth.storageStateMissing, true);
    assert.strictEqual(auth.enabled, false);
  });

  it('authHeadersFor NEVER returns auth material for a different origin', () => {
    const auth = resolveAuth(
      { headers: { Authorization: 'Bearer t' }, cookie: 'session=x' },
      'https://app.example.com'
    );
    assert.strictEqual(authHeadersFor('https://evil.example.net/steal', auth), undefined);
    assert.strictEqual(authHeadersFor('https://sub.app.example.com/x', auth), undefined);
    assert.strictEqual(authHeadersFor('http://app.example.com/x', auth), undefined); // scheme change = different origin
    const same = authHeadersFor('https://app.example.com/dashboard', auth);
    assert.strictEqual(same.Authorization, 'Bearer t');
    assert.strictEqual(same.Cookie, 'session=x');
  });

  it('isLoginUrl matches common login paths and nothing else', () => {
    assert.ok(isLoginUrl('https://a.com/login'));
    assert.ok(isLoginUrl('https://a.com/sign-in?next=/dashboard'));
    assert.ok(isLoginUrl('https://a.com/auth'));
    assert.ok(isLoginUrl('https://a.com/wp-login.php'));
    assert.ok(!isLoginUrl('https://a.com/blog/how-to-login-users'));
    assert.ok(!isLoginUrl('https://a.com/dashboard'));
  });

  it('parseCookiesForBrowser splits a cookie string into Playwright addCookies entries', () => {
    const cookies = parseCookiesForBrowser('session=abc; theme=dark', 'https://a.com');
    assert.deepStrictEqual(cookies, [
      { name: 'session', value: 'abc', url: 'https://a.com' },
      { name: 'theme', value: 'dark', url: 'https://a.com' },
    ]);
  });
});

describe('live-crawler — authenticated crawl end-to-end (HTTP engine)', () => {
  const externalHits = [];
  let appServer, extServer, appUrl, extUrl;

  function startServer(handler) {
    return new Promise((resolve) => {
      const server = http.createServer(handler);
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  }

  async function setup() {
    if (appServer) return;
    extServer = await startServer((req, res) => {
      externalHits.push({ url: req.url, headers: { ...req.headers } });
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><title>Ext</title></head><body>external</body></html>');
    });
    extUrl = `http://127.0.0.1:${extServer.address().port}`;

    appServer = await startServer((req, res) => {
      const authed =
        req.headers.authorization === 'Bearer test-token' ||
        (req.headers.cookie || '').includes('session=tok');
      if (req.url.startsWith('/dashboard')) {
        if (!authed) {
          res.writeHead(302, { Location: '/login' });
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><head><title>Dashboard</title></head><body>welcome back, this is the private dashboard area with plenty of visible text</body></html>');
        return;
      }
      if (req.url.startsWith('/login')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><head><title>Login</title></head><body>please log in to continue to your account dashboard page</body></html>');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><head><title>Home</title></head><body>public home page with enough text to not look blank at all
        <a href="/dashboard">dashboard</a>
        <a href="${extUrl}/ext">external</a>
      </body></html>`);
    });
    appUrl = `http://127.0.0.1:${appServer.address().port}/`;
  }

  after(() => {
    if (appServer) appServer.close();
    if (extServer) extServer.close();
  });

  async function crawl(extraConfig) {
    await setup();
    const mod = new LiveCrawlerModule();
    const checks = [];
    const result = { addCheck: (name, passed, details) => checks.push({ name, passed, details }) };
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-crawl-'));
    const config = {
      projectRoot,
      getModuleConfig: () => ({
        url: appUrl,
        maxPages: 10,
        timeout: 5000,
        browser: false,
        checkExternal: true,
        checkSitemap: false,
        checkRobotsTxt: false,
        checkFavicon: false,
        ...extraConfig,
      }),
      get: () => undefined,
    };
    await mod.run(result, config);
    return checks;
  }

  it('without auth: reports the auth wall instead of silently skipping authed pages', async () => {
    const checks = await crawl({});
    const wall = checks.find(c => c.name === 'crawl:auth-wall');
    assert.ok(wall, 'expected a crawl:auth-wall check when pages redirect to login');
    assert.strictEqual(wall.passed, false);
    assert.match(wall.details.suggestion, /--crawl-header|--crawl-cookie|storageState/);
    assert.strictEqual(checks.find(c => c.name === 'crawl:auth'), undefined);
  });

  it('with a bearer header: crawls the dashboard, no auth wall, no leak to external hosts', async () => {
    externalHits.length = 0;
    const checks = await crawl({ headers: { Authorization: 'Bearer test-token' } });
    assert.ok(checks.find(c => c.name === 'crawl:auth' && c.passed), 'expected crawl:auth active check');
    assert.strictEqual(checks.find(c => c.name === 'crawl:auth-wall'), undefined);
    assert.strictEqual(checks.find(c => c.name === 'crawl:auth-rejected'), undefined);
    assert.strictEqual(checks.find(c => c.name === 'crawl:error:http-error'), undefined);
    const scanned = checks.find(c => c.name === 'crawl:pages-scanned');
    assert.match(scanned.details.message, /2 page\(s\)/); // home + dashboard
    assert.ok(externalHits.length > 0, 'external link should have been checked');
    for (const hit of externalHits) {
      assert.strictEqual(hit.headers.authorization, undefined, 'auth header leaked to external host');
      assert.strictEqual(hit.headers.cookie, undefined, 'cookie leaked to external host');
    }
  });

  it('with a session cookie: dashboard is reachable', async () => {
    const checks = await crawl({ cookie: 'session=tok' });
    assert.strictEqual(checks.find(c => c.name === 'crawl:auth-wall'), undefined);
    assert.strictEqual(checks.find(c => c.name === 'crawl:auth-rejected'), undefined);
  });

  it('with a WRONG token: reports auth-rejected (expired/invalid session) as an error', async () => {
    const checks = await crawl({ headers: { Authorization: 'Bearer wrong' } });
    const rejected = checks.find(c => c.name === 'crawl:auth-rejected');
    assert.ok(rejected, 'expected crawl:auth-rejected when configured auth still hits the login wall');
    assert.strictEqual(rejected.passed, false);
    assert.strictEqual(rejected.details.severity, 'error');
  });

  it('with a missing storageState file: fails loudly with crawl:auth-config', async () => {
    const checks = await crawl({ storageState: path.join(os.tmpdir(), 'gt-no-such-state.json') });
    const cfg = checks.find(c => c.name === 'crawl:auth-config');
    assert.ok(cfg);
    assert.strictEqual(cfg.passed, false);
  });
});
