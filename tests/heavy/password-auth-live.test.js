'use strict';
// Live probe for email + password sign-in. Skipped unless GATETEST_LIVE_URL is
// set (e.g. https://gatetest.io or a local `next start`):
//   GATETEST_LIVE_URL=https://gatetest.io npm run test:heavy -- password-auth-live
// Nothing here creates an account or sends mail: it checks the pages render,
// the routes refuse a cross-site POST, and a wrong password gets the generic
// answer. Pattern: tests/heavy/signin-journey-live.test.js.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const BASE = (process.env.GATETEST_LIVE_URL || '').replace(/\/$/, '');
const skip = BASE ? false : 'set GATETEST_LIVE_URL to probe a running site';

async function probe(p, init) {
  const res = await fetch(BASE + p, { redirect: 'manual', headers: { 'User-Agent': 'GateTest-live-probe' }, ...init });
  const body = await res.text();
  const location = res.headers.get('location');
  return { status: res.status, location: location && new URL(location, BASE).pathname + new URL(location, BASE).search, body, headers: res.headers };
}

// The runner (scripts/run-tests.js) treats a file that reports zero tests as
// a failure, and a `{ skip }` describe reports zero named tests under
// `node --test`. This always-run test states whether the probe is armed.
describe('password sign-in live probe — arming', () => {
  it('is armed by GATETEST_LIVE_URL and says so when it is not', () => {
    if (BASE) {
      assert.equal(skip, false);
      assert.match(BASE, /^https?:\/\//, 'GATETEST_LIVE_URL must be an absolute http(s) origin');
      assert.ok(!BASE.endsWith('/'), 'trailing slash is stripped');
    } else {
      assert.equal(skip, 'set GATETEST_LIVE_URL to probe a running site');
    }
  });
});

describe('password sign-in against a running site', { skip }, () => {
  for (const p of ['/login/password', '/login/password/register', '/login/password/forgot']) {
    it(`${p} -> 200 with a plain HTML form (or 404 when the feature is off)`, async () => {
      const r = await probe(p);
      if (r.status === 404) return; // PASSWORD_AUTH_ENABLED=false on this deployment
      assert.equal(r.status, 200);
      assert.match(r.body, /<form[^>]+method="post"[^>]+action="\/api\/auth\/password\//i);
    });
  }

  it('/login/password/reset without a token -> 200 and no form', async () => {
    const r = await probe('/login/password/reset');
    if (r.status === 404) return;
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.body, /action="\/api\/auth\/password\/reset"/);
  });

  it('anonymous /account/password -> 3xx to /login?next=%2Faccount%2Fpassword', async () => {
    const r = await probe('/account/password');
    assert.ok(r.status >= 300 && r.status < 400, `got ${r.status}`);
    assert.equal(r.location, '/login?next=%2Faccount%2Fpassword');
  });

  it('a cross-site POST to /api/auth/password/login is refused (403 csrf), or 404 when off', async () => {
    const r = await probe('/api/auth/password/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site', 'User-Agent': 'GateTest-live-probe' },
      body: JSON.stringify({ email: 'probe@example.com', password: 'not-a-real-password-1234' }),
    });
    if (r.status === 404) return;
    assert.equal(r.status, 403);
    assert.equal(JSON.parse(r.body).code, 'csrf');
  });

  it('a same-origin wrong password gets the one generic answer, never a hint', async () => {
    const r = await probe('/api/auth/password/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: BASE, 'User-Agent': 'GateTest-live-probe' },
      body: JSON.stringify({ email: 'probe-no-such-account@example.com', password: 'not-a-real-password-1234' }),
    });
    if (r.status === 404) return;
    assert.ok([401, 429, 503].includes(r.status), `got ${r.status}`);
    const j = JSON.parse(r.body);
    assert.equal(j.ok, false);
    assert.ok(['bad_credentials', 'throttled', 'db_unavailable'].includes(j.code), j.code);
    assert.ok(!r.headers.get('set-cookie'), 'no session cookie on failure');
  });
});
