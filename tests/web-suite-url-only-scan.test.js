'use strict';

/**
 * Issue #643 — six of the fourteen `web`-suite modules are file scanners
 * that reported a PASSED "no files" check on a URL-only hosted scan (0-2ms,
 * green) instead of admitting they never looked at the URL at all
 * (Doctrine #1: clean / found / NOT CHECKED, and the third must be printed).
 *
 * Control pairs, one per module:
 *   1. A URL-only scan (no projectRoot, or a real GateTestConfig-shaped
 *      object with `targetUrl` set) with NO `config.livePage` either →
 *      `<module>:not-checked`, `passed:false`, `severity:'info'`,
 *      `notChecked:true`.
 *   2. A REAL repo scan (`projectRoot` set, no `targetUrl`) with zero
 *      matching files → unchanged: the existing informational PASS
 *      ("no-files" / "files" style check), not a not-checked.
 *   3. Where a live-URL mode was added (webHeaders, seo, accessibility,
 *      cookieSecurity): `config.livePage` present → real findings fire on
 *      a broken fixture, and a clean fixture reports zero issues — never a
 *      fabricated pass.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const WebHeadersModule = require('../src/modules/web-headers');
const TlsSecurityModule = require('../src/modules/tls-security');
const CookieSecurityModule = require('../src/modules/cookie-security');
const AccessibilityModule = require('../src/modules/accessibility');
const SeoModule = require('../src/modules/seo');
const LinksModule = require('../src/modules/links');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) { this.checks.push({ name, passed, ...details }); },
  };
}

const MODULES = [
  { Mod: WebHeadersModule, name: 'webHeaders', noFilesCheck: 'web-headers:no-files' },
  { Mod: TlsSecurityModule, name: 'tlsSecurity', noFilesCheck: 'tls-security:no-files' },
  { Mod: CookieSecurityModule, name: 'cookieSecurity', noFilesCheck: 'cookie-sec:no-files' },
  { Mod: AccessibilityModule, name: 'accessibility', noFilesCheck: 'a11y:files' },
  { Mod: SeoModule, name: 'seo', noFilesCheck: 'seo:files' },
  { Mod: LinksModule, name: 'links', noFilesCheck: 'links:files' },
];

describe('web suite — URL-only scan reports not-checked, never a fabricated pass', () => {
  for (const { Mod, name, noFilesCheck } of MODULES) {
    it(`${name}: no projectRoot, no livePage -> not-checked`, async () => {
      const mod = new Mod();
      const result = makeResult();
      await mod.run(result, {});
      const nc = result.checks.find((c) => c.name === `${name}:not-checked`);
      assert.ok(nc, `expected ${name}:not-checked, got: ${result.checks.map((c) => c.name).join(', ')}`);
      assert.strictEqual(nc.passed, false);
      assert.strictEqual(nc.severity, 'info');
      assert.strictEqual(nc.notChecked, true);
      assert.ok(nc.message && nc.message.length > 0);
    });

    it(`${name}: real repo, projectRoot set, targetUrl absent, zero files -> unchanged informational pass`, async () => {
      const os = require('os');
      const fs = require('fs');
      const path = require('path');
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-urlonly-'));
      try {
        const mod = new Mod();
        const result = makeResult();
        const config = {
          projectRoot: tmp,
          getModuleConfig: () => ({}),
        };
        await mod.run(result, config);
        assert.ok(
          result.checks.find((c) => c.name === noFilesCheck && c.passed === true),
          `expected ${noFilesCheck} passed:true, got: ${JSON.stringify(result.checks)}`,
        );
        assert.ok(!result.checks.find((c) => c.notChecked === true), 'a real repo scan must never report not-checked');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it(`${name}: hosted scan shape (projectRoot set to empty tmp workspace, targetUrl set) -> not-checked, not a fabricated pass`, async () => {
      const os = require('os');
      const fs = require('fs');
      const path = require('path');
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-hosted-'));
      try {
        const mod = new Mod();
        const result = makeResult();
        const config = {
          projectRoot: tmp,
          targetUrl: 'https://example.com',
          getModuleConfig: () => ({}),
        };
        await mod.run(result, config);
        const nc = result.checks.find((c) => c.name === `${name}:not-checked`);
        assert.ok(nc, `expected ${name}:not-checked on a targetUrl scan, got: ${result.checks.map((c) => c.name).join(', ')}`);
        assert.strictEqual(nc.passed, false);
        assert.strictEqual(nc.notChecked, true);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
});

describe('web suite — live-URL mode via config.livePage (real work where cheap)', () => {
  it('webHeaders: fires on a response missing CSP/HSTS/XFO, and a hardened response reports zero issues', async () => {
    const badHeaders = new Headers({ 'x-content-type-options': 'nosniff' });
    const mod1 = new WebHeadersModule();
    const r1 = makeResult();
    await mod1.run(r1, { livePage: { url: 'https://bad.example.com', status: 200, headers: badHeaders, html: '<html></html>' } });
    assert.ok(r1.checks.find((c) => c.name === 'web-headers:live-missing-csp' && c.passed === false));
    assert.ok(r1.checks.find((c) => c.name === 'web-headers:live-missing-hsts' && c.passed === false));
    assert.ok(r1.checks.find((c) => c.name === 'web-headers:live-missing-frame-options' && c.passed === false));

    const goodHeaders = new Headers({
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
      'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
      'x-content-type-options': 'nosniff',
    });
    const mod2 = new WebHeadersModule();
    const r2 = makeResult();
    await mod2.run(r2, { livePage: { url: 'https://good.example.com', status: 200, headers: goodHeaders, html: '<html></html>' } });
    assert.strictEqual(r2.checks.filter((c) => c.passed === false).length, 0, JSON.stringify(r2.checks));
  });

  it('webHeaders: CORS wildcard + credentials fires as error', async () => {
    const headers = new Headers({
      'access-control-allow-origin': '*',
      'access-control-allow-credentials': 'true',
      'content-security-policy': "default-src 'self'",
      'strict-transport-security': 'max-age=31536000',
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
    });
    const mod = new WebHeadersModule();
    const r = makeResult();
    await mod.run(r, { livePage: { url: 'https://x.example.com', headers, html: '' } });
    const c = r.checks.find((c2) => c2.name === 'web-headers:live-cors-wildcard-with-credentials');
    assert.ok(c && c.passed === false && c.severity === 'error');
  });

  it('seo: fires on a page missing <title>, and a well-formed page reports zero issues', async () => {
    const mod1 = new SeoModule();
    const r1 = makeResult();
    await mod1.run(r1, { livePage: { url: 'https://bad.example.com', headers: new Headers(), html: '<html><head></head><body></body></html>' } });
    assert.ok(r1.checks.find((c) => c.name === 'seo:title:https://bad.example.com' && c.passed === false));

    const goodHtml = `<html><head>
      <title>A good page title</title>
      <meta name="description" content="A clear description of this page.">
      <link rel="canonical" href="https://good.example.com/">
      <meta property="og:title" content="t"><meta property="og:description" content="d">
      <meta property="og:image" content="i"><meta property="og:url" content="u">
      <meta name="twitter:card" content="c"><meta name="twitter:title" content="t"><meta name="twitter:description" content="d">
      <script type="application/ld+json">{}</script>
      </head><body><h1>Hello</h1></body></html>`;
    const mod2 = new SeoModule();
    const r2 = makeResult();
    await mod2.run(r2, { livePage: { url: 'https://good.example.com', headers: new Headers(), html: goodHtml } });
    assert.strictEqual(r2.checks.filter((c) => c.passed === false).length, 0, JSON.stringify(r2.checks));
  });

  it('accessibility: fires on a page with an unlabelled image, and a clean page reports zero issues', async () => {
    const mod1 = new AccessibilityModule();
    const r1 = makeResult();
    await mod1.run(r1, { livePage: { url: 'https://bad.example.com', html: '<html lang="en"><head></head><body><img src="a.png"></body></html>' } });
    assert.ok(r1.checks.find((c) => c.name === 'a11y:img-alt:https://bad.example.com' && c.passed === false));

    const mod2 = new AccessibilityModule();
    const r2 = makeResult();
    await mod2.run(r2, { livePage: { url: 'https://good.example.com', html: '<html lang="en"><head></head><body><img src="a.png" alt="a"><h1>Hi</h1><main>content</main></body></html>' } });
    assert.strictEqual(r2.checks.filter((c) => c.passed === false).length, 0, JSON.stringify(r2.checks));
  });

  it('cookieSecurity: fires when Set-Cookie is missing HttpOnly/Secure, and a hardened cookie reports zero issues', async () => {
    const headers1 = new Headers();
    headers1.append('set-cookie', 'session=abc123; Path=/');
    const mod1 = new CookieSecurityModule();
    const r1 = makeResult();
    await mod1.run(r1, { livePage: { url: 'https://bad.example.com', headers: headers1, html: '' } });
    assert.ok(r1.checks.find((c) => c.name === 'cookie-sec:live-httponly-missing:session' && c.passed === false));
    assert.ok(r1.checks.find((c) => c.name === 'cookie-sec:live-secure-missing:session' && c.passed === false));

    const headers2 = new Headers();
    headers2.append('set-cookie', 'session=abc123; Path=/; HttpOnly; Secure; SameSite=Lax');
    const mod2 = new CookieSecurityModule();
    const r2 = makeResult();
    await mod2.run(r2, { livePage: { url: 'https://good.example.com', headers: headers2, html: '' } });
    assert.strictEqual(r2.checks.filter((c) => c.passed === false).length, 0, JSON.stringify(r2.checks));
  });

  it('tlsSecurity: livePage present -> honestly not-checked (needs a raw socket, not just headers+HTML)', async () => {
    const mod = new TlsSecurityModule();
    const r = makeResult();
    await mod.run(r, { livePage: { url: 'https://x.example.com', headers: new Headers(), html: '' } });
    const nc = r.checks.find((c) => c.name === 'tlsSecurity:not-checked');
    assert.ok(nc && nc.passed === false && nc.notChecked === true);
  });

  it('links: livePage present -> honestly not-checked (live crawl not implemented here)', async () => {
    const mod = new LinksModule();
    const r = makeResult();
    await mod.run(r, { livePage: { url: 'https://x.example.com', headers: new Headers(), html: '<a href="/about">About</a>' } });
    const nc = r.checks.find((c) => c.name === 'links:not-checked');
    assert.ok(nc && nc.passed === false && nc.notChecked === true);
  });
});
