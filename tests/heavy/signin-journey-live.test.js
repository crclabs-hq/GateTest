'use strict';
// Live probe for the first-hour sign-in journey (#810, #812). Skipped unless
// GATETEST_LIVE_URL is set (e.g. https://gatetest.io or a local `next start`):
//   GATETEST_LIVE_URL=https://gatetest.io npm run test:heavy -- signin-journey-live
// The authenticated half (valid session cookie -> 200) needs SESSION_SECRET and
// lives in tests/signin-gate.test.js; a probe from outside cannot mint one.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const BASE = (process.env.GATETEST_LIVE_URL || '').replace(/\/$/, '');
const skip = BASE ? false : 'set GATETEST_LIVE_URL to probe a running site';

async function probe(p) {
  const res = await fetch(BASE + p, { redirect: 'manual', headers: { 'User-Agent': 'GateTest-live-probe' } });
  const body = await res.text();
  const location = res.headers.get('location');
  return { status: res.status, location: location && new URL(location, BASE).pathname + new URL(location, BASE).search, body };
}

// The runner (scripts/run-tests.js) treats a file that reports zero tests as
// a failure, and a `{ skip }` describe reports zero named tests under
// `node --test`. This one always-run test keeps the file honest either way:
// it states whether the live probe is armed and against what.
describe('sign-in journey live probe — arming', () => {
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

describe('sign-in journey against a running site', { skip }, () => {
  it('anonymous /dashboard -> 3xx to /login?next=/dashboard, never a 200 shell', async () => {
    const r = await probe('/dashboard');
    assert.ok(r.status >= 300 && r.status < 400, `got ${r.status}`);
    assert.equal(r.location, '/login?next=%2Fdashboard');
    assert.ok(r.body.length < 1024, `redirect body should be empty or tiny, got ${r.body.length} bytes`);
  });

  it('anonymous /login -> 200 with the GitHub sign-in entry', async () => {
    const r = await probe('/login');
    assert.equal(r.status, 200);
    assert.match(r.body, /Sign in with GitHub/);
  });

  for (const p of ['/register', '/signup', '/sign-up']) {
    it(`${p} -> 301 -> /login`, async () => {
      const r = await probe(p);
      assert.equal(r.status, 301);
      assert.equal(r.location, '/login');
    });
  }

  it('/docs -> 307 -> /developers with an empty body (no __next_error__ shell)', async () => {
    const r = await probe('/docs');
    assert.equal(r.status, 307);
    assert.equal(r.location, '/developers');
    assert.equal(r.body.length, 0, `redirect body should be empty, got ${r.body.length} bytes`);
    assert.ok(!r.body.includes('__next_error__'));
  });

  it('GET /api -> 200 JSON pointing at the docs', async () => {
    const res = await fetch(BASE + '/api');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const j = await res.json();
    assert.equal(j.ok, true);
    assert.match(j.docs, /\/developers$/);
    assert.match(j.note, /is not a host/);
  });
});
