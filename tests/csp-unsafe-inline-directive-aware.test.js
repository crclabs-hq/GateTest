'use strict';

/**
 * Issue #681 item 3 — CSP `'unsafe-inline'` must be directive-aware, not a
 * whole-string test. A site serving `script-src 'self' 'nonce-…'` (scripts
 * locked down) and keeping `'unsafe-inline'` only in `style-src` (a
 * deliberate, documented choice for inline style assets — no script
 * execution risk) got the SAME warning as a site that actually allows
 * inline `<script>` execution, in both `src/scanners/server-scanner.js`
 * (~line 245) and the live header check in `src/modules/web-headers.js`
 * (~line 167).
 *
 * Both now go through the ONE shared classifier, `src/core/csp-analyzer.js`
 * (Doctrine #4) — this file tests that shared classifier directly for the
 * three CSP shapes the issue names, then proves both call sites actually
 * use it end to end:
 *   1. 'unsafe-inline' in script-src -> warning
 *   2. 'unsafe-inline' in default-src, no script-src declared -> warning
 *      (CSP fallback-list semantics: default-src governs script when
 *      script-src is absent)
 *   3. 'unsafe-inline' ONLY in style-src -> info, naming the directive
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { classifyUnsafeInline, parseCsp } = require('../src/core/csp-analyzer');
const ServerScanner = require('../src/scanners/server-scanner');
const { liveHeaderChecks } = require('../src/modules/web-headers');

const SCRIPT_SRC_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'";
const DEFAULT_SRC_CSP = "default-src 'self' 'unsafe-inline'; style-src 'self'";
const STYLE_SRC_ONLY_CSP = "default-src 'self'; script-src 'self' 'nonce-abc123'; style-src 'self' 'unsafe-inline'";
const CLEAN_CSP = "default-src 'self'; script-src 'self' 'nonce-abc123'; style-src 'self'";

describe('csp-analyzer.js — parseCsp', () => {
  it('lower-cases directive names and keeps source tokens verbatim', () => {
    const parsed = parseCsp("Default-Src 'self'; SCRIPT-SRC 'self' 'unsafe-inline'");
    assert.deepEqual(parsed['default-src'], ["'self'"]);
    assert.deepEqual(parsed['script-src'], ["'self'", "'unsafe-inline'"]);
  });

  it('returns an empty map for a falsy/non-string input', () => {
    assert.deepEqual(parseCsp(null), {});
    assert.deepEqual(parseCsp(undefined), {});
    assert.deepEqual(parseCsp(''), {});
  });
});

describe('csp-analyzer.js — classifyUnsafeInline (the three shapes)', () => {
  it('shape 1: unsafe-inline in script-src -> warning naming script-src', () => {
    const r = classifyUnsafeInline(SCRIPT_SRC_CSP);
    assert.deepEqual(r, { severity: 'warning', directive: 'script-src' });
  });

  it('shape 2: unsafe-inline in default-src with no script-src declared -> warning naming default-src', () => {
    const r = classifyUnsafeInline(DEFAULT_SRC_CSP);
    assert.deepEqual(r, { severity: 'warning', directive: 'default-src' });
  });

  it('shape 3: unsafe-inline ONLY in style-src -> info naming style-src', () => {
    const r = classifyUnsafeInline(STYLE_SRC_ONLY_CSP);
    assert.deepEqual(r, { severity: 'info', directive: 'style-src' });
  });

  it('a CSP with no unsafe-inline anywhere -> null', () => {
    assert.equal(classifyUnsafeInline(CLEAN_CSP), null);
  });

  it('unsafe-inline in style-src is NOT promoted to warning just because default-src also exists (without the token)', () => {
    // default-src is present but does NOT itself carry 'unsafe-inline';
    // script-src is present (nonce only) so default-src's fallback role
    // for scripts doesn't even apply. Only style-src carries the token.
    const r = classifyUnsafeInline("default-src 'self'; script-src 'self' 'nonce-x'; style-src 'unsafe-inline'");
    assert.deepEqual(r, { severity: 'info', directive: 'style-src' });
  });
});

describe('web-headers.js — liveHeaderChecks is directive-aware (live check, ~line 167)', () => {
  function headersWith(csp) {
    return new Headers({
      'content-security-policy': csp,
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
    });
  }

  it('shape 1 (script-src): live-csp-unsafe-inline fires as warning, names script-src', () => {
    const findings = liveHeaderChecks(headersWith(SCRIPT_SRC_CSP));
    const f = findings.find((x) => x.id === 'live-csp-unsafe-inline');
    assert.ok(f, 'expected live-csp-unsafe-inline');
    assert.equal(f.severity, 'warning');
    assert.match(f.message, /script-src/);
    assert.ok(!findings.find((x) => x.id === 'live-csp-unsafe-inline-style-only'));
  });

  it('shape 2 (default-src, no script-src): live-csp-unsafe-inline fires as warning, names default-src', () => {
    const findings = liveHeaderChecks(headersWith(DEFAULT_SRC_CSP));
    const f = findings.find((x) => x.id === 'live-csp-unsafe-inline');
    assert.ok(f, 'expected live-csp-unsafe-inline');
    assert.equal(f.severity, 'warning');
    assert.match(f.message, /default-src/);
  });

  it('shape 3 (style-src only): fires the NEW info-level id naming style-src, never the warning id', () => {
    const findings = liveHeaderChecks(headersWith(STYLE_SRC_ONLY_CSP));
    assert.ok(!findings.find((x) => x.id === 'live-csp-unsafe-inline'), 'must not fire the warning id');
    const f = findings.find((x) => x.id === 'live-csp-unsafe-inline-style-only');
    assert.ok(f, 'expected live-csp-unsafe-inline-style-only');
    assert.equal(f.severity, 'info');
    assert.match(f.message, /style-src/);
  });

  it('a clean CSP (nonce-based script-src, no unsafe-inline anywhere) fires neither id', () => {
    const findings = liveHeaderChecks(headersWith(CLEAN_CSP));
    assert.ok(!findings.find((x) => x.id === 'live-csp-unsafe-inline'));
    assert.ok(!findings.find((x) => x.id === 'live-csp-unsafe-inline-style-only'));
  });

  it('unsafe-eval is unaffected by this change — still its own error-severity finding', () => {
    const findings = liveHeaderChecks(headersWith("default-src 'self'; script-src 'self' 'unsafe-eval'"));
    const f = findings.find((x) => x.id === 'live-csp-unsafe-eval');
    assert.ok(f);
    assert.equal(f.severity, 'error');
  });
});

describe('server-scanner.js — _checkHeaders CSP check is directive-aware (~line 245)', () => {
  let servers = [];

  function startServerWithCsp(csp) {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/html',
          'Content-Security-Policy': csp,
          'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
        });
        res.end('<html><body>ok</body></html>');
      });
      server.listen(0, '127.0.0.1', () => {
        servers.push(server);
        resolve(`http://127.0.0.1:${server.address().port}/`);
      });
    });
  }

  after(() => { for (const s of servers) s.close(); });

  function headersModuleResult(results) {
    const mod = results.modules.find((m) => m.name === 'headers');
    assert.ok(mod, 'expected a headers module result');
    return mod;
  }

  it('shape 1 (script-src): warns, names script-src, counts as an issue', async () => {
    const url = await startServerWithCsp(SCRIPT_SRC_CSP);
    const results = await new ServerScanner().scan(url);
    const mod = headersModuleResult(results);
    const line = mod.details.find((d) => /unsafe-inline/i.test(d));
    assert.ok(line, `expected an unsafe-inline detail line, got: ${JSON.stringify(mod.details)}`);
    assert.match(line, /^warning: CSP contains 'unsafe-inline' in script-src/);
  });

  it('shape 2 (default-src, no script-src): warns, names default-src', async () => {
    const url = await startServerWithCsp(DEFAULT_SRC_CSP);
    const results = await new ServerScanner().scan(url);
    const mod = headersModuleResult(results);
    const line = mod.details.find((d) => /unsafe-inline/i.test(d));
    assert.ok(line);
    assert.match(line, /^warning: CSP contains 'unsafe-inline' in default-src/);
  });

  it('shape 3 (style-src only): drops to an info note naming style-src, does not count as an issue', async () => {
    const before = await startServerWithCsp(STYLE_SRC_ONLY_CSP);
    const results = await new ServerScanner().scan(before);
    const mod = headersModuleResult(results);
    const line = mod.details.find((d) => /unsafe-inline/i.test(d));
    assert.ok(line, `expected an unsafe-inline detail line, got: ${JSON.stringify(mod.details)}`);
    assert.match(line, /^info: CSP contains 'unsafe-inline' in style-src/);
    assert.ok(!/^warning:.*unsafe-inline/.test(line));
  });

  it('a clean CSP produces no unsafe-inline detail line at all', async () => {
    const url = await startServerWithCsp(CLEAN_CSP);
    const results = await new ServerScanner().scan(url);
    const mod = headersModuleResult(results);
    assert.ok(!mod.details.find((d) => /unsafe-inline/i.test(d)));
  });
});
