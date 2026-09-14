'use strict';

// =============================================================================
// cookieSecurity — a framework's defaults file defines the setting; an
// application misconfigures it
// =============================================================================
// django/django @ main, scanned 2026-09-14: `django/conf/global_settings.py:581`
// reads `CSRF_COOKIE_HTTPONLY = False` — the framework's own documented default
// — and the rule reported it at confidence 1.0, gate-BLOCKING, as "cookie
// readable from JS. XSS becomes session takeover."
//
// Two things are true about that line, and the rule now knows both:
//   1. `global_settings.py` DEFINES the default. The place an application
//      turns a cookie flag off is its own `settings.py`; a defaults file is a
//      framework's starting point, not a deployment. Every Python cookie rule
//      drops to info there and the message says why.
//   2. `CSRF_COOKIE_HTTPONLY = False` is Django's documented default anywhere:
//      the CSRF token is not a session credential, page JS reads it for AJAX,
//      and Django's docs say HttpOnly on it "doesn't offer any practical
//      protection". Written out in an application it is a warning to look at,
//      not a gate. `SESSION_COOKIE_HTTPONLY = False` in an application keeps
//      blocking — that one IS session takeover.
// =============================================================================

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const CookieSecurityModule = require('../src/modules/cookie-security');

function makeResult() {
  return { checks: [], addCheck(name, passed, details = {}) { this.checks.push({ name, passed, ...details }); } };
}
function run(projectRoot) {
  const mod = new CookieSecurityModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}
function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
const fired = (r, prefix) => r.checks.filter((c) => !c.passed && c.name.startsWith(prefix));

// django/conf/global_settings.py, the CSRF block verbatim (lines 575-585).
const DJANGO_GLOBAL_SETTINGS = [
  '# Settings for CSRF cookie.',
  'CSRF_COOKIE_NAME = "csrftoken"',
  'CSRF_COOKIE_AGE = 60 * 60 * 24 * 7 * 52',
  'CSRF_COOKIE_DOMAIN = None',
  'CSRF_COOKIE_PATH = "/"',
  'CSRF_COOKIE_SECURE = False',
  'CSRF_COOKIE_HTTPONLY = False',
  'CSRF_COOKIE_SAMESITE = "Lax"',
  'CSRF_HEADER_NAME = "HTTP_X_CSRFTOKEN"',
  'CSRF_TRUSTED_ORIGINS = []',
  'CSRF_USE_SESSIONS = False',
  '',
].join('\n');

describe('cookieSecurity — framework defaults files', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cookie-defaults-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('django/conf/global_settings.py — every cookie finding is info, and says it is a defaults file', async () => {
    write(tmp, 'django/conf/global_settings.py', DJANGO_GLOBAL_SETTINGS);
    const r = await run(tmp);
    const hits = fired(r, 'cookie-sec:py-');
    assert.strictEqual(hits.length, 2, 'both the SECURE and the HTTPONLY line are still on the report');
    for (const h of hits) {
      assert.strictEqual(h.severity, 'info', `${h.name} must not block`);
      assert.match(h.message, /framework defaults file/);
    }
    const httponly = hits.find((h) => h.name === 'cookie-sec:py-cookie-httponly-false:django/conf/global_settings.py:7');
    assert.ok(httponly, 'the finding keeps its line');
  });

  for (const name of ['app/default_settings.py', 'pkg/conf/defaults.py', 'ext/settings_defaults.py']) {
    it(`${name} — SESSION_COOKIE_HTTPONLY = False is info in a defaults file`, async () => {
      write(tmp, name, 'SESSION_COOKIE_HTTPONLY = False\n');
      const r = await run(tmp);
      const hits = fired(r, 'cookie-sec:py-cookie-httponly-false:');
      assert.strictEqual(hits.length, 1);
      assert.strictEqual(hits[0].severity, 'info');
    });
  }

  it('POSITIVE CONTROL — SESSION_COOKIE_HTTPONLY = False in an application settings.py still blocks', async () => {
    write(tmp, 'mysite/settings.py', 'SESSION_COOKIE_HTTPONLY = False\n');
    const r = await run(tmp);
    const hits = fired(r, 'cookie-sec:py-cookie-httponly-false:');
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].severity, 'error');
    assert.match(hits[0].message, /session takeover/);
    assert.doesNotMatch(hits[0].message, /framework defaults file/);
  });

  it('POSITIVE CONTROL — httponly=False on set_cookie in application code still blocks', async () => {
    write(tmp, 'app/views.py', 'response.set_cookie("sid", sid, httponly=False)\n');
    const r = await run(tmp);
    const hits = fired(r, 'cookie-sec:py-fastapi-httponly-false:');
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].severity, 'error');
  });

  it('NEGATIVE CONTROL — `defaults` as a directory, not the basename, is not a defaults file', async () => {
    write(tmp, 'defaults/settings.py', 'SESSION_COOKIE_HTTPONLY = False\n');
    const r = await run(tmp);
    assert.strictEqual(fired(r, 'cookie-sec:py-cookie-httponly-false:')[0].severity, 'error');
  });
});

describe('cookieSecurity — CSRF_COOKIE_HTTPONLY = False is Django\'s documented default', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cookie-csrf-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('in an application settings.py it is a warning, and the message explains why', async () => {
    write(tmp, 'mysite/settings.py', 'CSRF_COOKIE_HTTPONLY = False\n');
    const r = await run(tmp);
    const hits = fired(r, 'cookie-sec:py-cookie-httponly-false:');
    assert.strictEqual(hits.length, 1, 'still reported — someone wrote it out explicitly');
    assert.strictEqual(hits[0].severity, 'warning');
    assert.match(hits[0].message, /documented default/);
    assert.strictEqual(hits[0].setting, 'CSRF_COOKIE_HTTPONLY');
  });

  it('in a test path it drops one more step, to info', async () => {
    write(tmp, 'tests/settings.py', 'CSRF_COOKIE_HTTPONLY = False\n');
    const r = await run(tmp);
    assert.strictEqual(fired(r, 'cookie-sec:py-cookie-httponly-false:')[0].severity, 'info');
  });

  it('CONTROL PAIR — the two settings on adjacent lines get their own severities', async () => {
    write(tmp, 'mysite/settings.py', 'CSRF_COOKIE_HTTPONLY = False\nSESSION_COOKIE_HTTPONLY = False\n');
    const r = await run(tmp);
    const bySetting = Object.fromEntries(fired(r, 'cookie-sec:py-cookie-httponly-false:').map((h) => [h.setting, h.severity]));
    assert.deepStrictEqual(bySetting, { CSRF_COOKIE_HTTPONLY: 'warning', SESSION_COOKIE_HTTPONLY: 'error' });
  });
});
