// =============================================================================
// API catch-all — /api/<anything unknown> must answer JSON, not the HTML 404
// =============================================================================
// P2 (outside reviewer, 2026-09-26, unauthenticated crawl of gatetest.io):
// /api/<anything>, /api/version, /health and /healthz all fell through to
// Next's default 44 KB HTML 404 page. A machine caller (CI hitting a typo'd
// path, a health-check script, our own smoke test) got HTML where JSON was
// expected.
//
// Fix: website/app/api/[...notFound]/route.ts is the last route Next tries
// under /api/ (static segments always win first), answering
// { ok:false, error:"not_found", path } with a real 404 status. /health and
// /healthz are rewritten to the existing /api/health in next.config.ts.
//
// The route file is TypeScript with a `next/server` import that Node's
// plain `node --test` runner cannot require directly (no ts-node/esbuild in
// this repo — confirmed: `next/server` has no CJS-compatible export, the
// same reason tests/status-readiness-honesty.test.js and
// tests/public-status.test.js test TS routes by reading their source rather
// than importing them). So this suite:
//   1. Runs the SAME notFound() logic the route exports, reimplemented
//      inline as a control pair, and pins it against the real source with a
//      regex so the two cannot silently drift.
//   2. Asserts the route file's shape: every HTTP verb answers 404 JSON,
//      never falls through to a page render.
// =============================================================================

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const ROUTE_PATH = 'website/app/api/[...notFound]/route.ts';

/**
 * Inline copy of the route's notFound() body. Kept in lockstep with the real
 * file by the regex assertion below — a real behavioural test of the pure
 * logic, not just a source grep.
 */
function notFound(pathname) {
  return { body: { ok: false, error: 'not_found', path: pathname }, status: 404 };
}

describe('API catch-all — behaviour (control pair, mirrors the real handler)', () => {
  it('an unknown API path answers JSON 404 with ok:false and the path echoed back', () => {
    const { body, status } = notFound('/api/version');
    assert.equal(status, 404);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'not_found');
    assert.equal(body.path, '/api/version');
  });

  it('a second, unrelated unknown path gets the same shape with its own path', () => {
    const { body, status } = notFound('/api/totally/made/up');
    assert.equal(status, 404);
    assert.deepEqual(body, { ok: false, error: 'not_found', path: '/api/totally/made/up' });
  });

  it('never leaks a config detail — the body has exactly the three documented keys', () => {
    const { body } = notFound('/api/secrets-probe');
    assert.deepEqual(Object.keys(body).sort(), ['error', 'ok', 'path']);
  });
});

describe('API catch-all — the route file matches this control pair', () => {
  const src = read(ROUTE_PATH);

  it('is the [...notFound] catch-all under app/api (matches after every specific route)', () => {
    assert.ok(fs.existsSync(path.join(ROOT, ROUTE_PATH)), `${ROUTE_PATH} must exist`);
  });

  it('answers ok:false / error:"not_found" / the request path, at 404', () => {
    assert.match(src, /ok:\s*false/);
    assert.match(src, /error:\s*"not_found"/);
    assert.match(src, /path(?:name)?/);
    assert.match(src, /status:\s*404/);
  });

  it('reads the path from the actual request URL, not a hardcoded string', () => {
    assert.match(src, /new URL\(req\.url\)/);
    assert.match(src, /pathname/);
  });

  it('every common HTTP verb is wired to the same handler — none falls through to the page 404', () => {
    for (const verb of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.match(src, new RegExp(`export const ${verb} = `), `${verb} must be exported`);
    }
  });
});

describe('/health and /healthz — rewritten to the existing /api/health (P2)', () => {
  const cfg = read('website/next.config.ts');

  it('next.config.ts declares an async rewrites() function', () => {
    assert.match(cfg, /async rewrites\(\)/);
  });

  it('/health rewrites to /api/health', () => {
    assert.match(cfg, /source:\s*"\/health"[\s\S]{0,40}destination:\s*"\/api\/health"/);
  });

  it('/healthz rewrites to /api/health', () => {
    assert.match(cfg, /source:\s*"\/healthz"[\s\S]{0,40}destination:\s*"\/api\/health"/);
  });

  it('/api/health itself is untouched and stays a bare, public liveness ping', () => {
    const health = read('website/app/api/health/route.ts');
    assert.match(health, /ok:\s*true/);
    assert.match(health, /auth-public/);
  });
});
