'use strict';
// Live probe for the composite readiness endpoint (#809). Skipped unless
// GATETEST_LIVE_URL is set (e.g. https://gatetest.io or a local `next start`):
//   GATETEST_LIVE_URL=https://gatetest.io npm run test:heavy -- health-deep-live
// It asserts the SHAPE and the honesty rules from outside — it cannot know
// which sub-checks a given deployment should have green, so a 503 is a valid
// answer as long as the body names the required check that took it there.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { CHECK_NAMES, REQUIRED_CHECKS, STATUSES } = require('../../website/app/lib/health-composite.js');

const BASE = (process.env.GATETEST_LIVE_URL || '').replace(/\/$/, '');
const skip = BASE ? false : 'set GATETEST_LIVE_URL to probe a running site';

// The runner (scripts/run-tests.js) treats a file that reports zero tests as
// a failure, and a `{ skip }` describe reports zero named tests under
// `node --test`. This one always-run test keeps the file honest either way:
// it states whether the live probe is armed and against what.
describe('composite health live probe — arming', () => {
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

describe('GET /api/health/deep against a running site', { skip }, () => {
  let res; let body; let text; let elapsedMs;
  async function load() {
    if (res) return;
    const started = Date.now();
    res = await fetch(BASE + '/api/health/deep', { headers: { 'User-Agent': 'GateTest-live-probe', accept: 'application/json' } });
    elapsedMs = Date.now() - started;
    text = await res.text();
    body = JSON.parse(text);
  }

  it('answers JSON in under 6 s with 200 or 503 — never a hang, never a 500', async () => {
    await load();
    assert.ok(res.status === 200 || res.status === 503, `got ${res.status}`);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    assert.ok(elapsedMs < 6000, `took ${elapsedMs} ms`);
  });

  it('reports every sub-check with a status, latency and reason, and `ok` matches the HTTP status', async () => {
    await load();
    assert.equal(typeof body.ok, 'boolean');
    assert.equal(body.ok, res.status === 200);
    assert.ok(['ok', 'degraded', 'down'].includes(body.status), `status ${body.status}`);
    assert.ok(Array.isArray(body.failing));
    for (const name of CHECK_NAMES) {
      const c = body.checks[name];
      assert.ok(c, `missing sub-check ${name}`);
      assert.ok(STATUSES.includes(c.status), `${name}.status ${c.status}`);
      assert.ok(c.latencyMs === null || typeof c.latencyMs === 'number', `${name}.latencyMs`);
      assert.equal(typeof c.reason, 'string');
      assert.equal(c.required, REQUIRED_CHECKS.includes(name));
    }
  });

  it('a 503 is explained: a required sub-check is down and named in `failing`', async () => {
    await load();
    const requiredDown = REQUIRED_CHECKS.filter((n) => ['down', 'not-configured'].includes(body.checks[n].status));
    if (res.status === 503) {
      assert.ok(requiredDown.length > 0, 'a 503 with every required check up would be a lie');
      for (const n of requiredDown) assert.ok(body.failing.includes(n), `${n} is down but not listed`);
    } else {
      assert.equal(requiredDown.length, 0, `200 while ${requiredDown.join(', ')} is down`);
    }
  });

  it('carries names only — no env var name, hostname, URL, IP, key prefix or pre-rename platform name', async () => {
    await load();
    assert.ok(!/vapron/i.test(text));
    assert.ok(!/https?:\/\//i.test(text), 'no URL in the body');
    assert.ok(!/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(text), 'no IP in the body');
    assert.ok(!/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/.test(text), 'no env var name in the body');
    assert.ok(!/\b(?:sk|rk|pk|re|whsec|ghp)_[A-Za-z0-9]+/.test(text), 'no key prefix in the body');
    assert.ok(!/anthropic|claude|openai|resend|neon/i.test(text), 'no vendor name in the body');
  });

  it('/api/health is still the bare liveness ping beside it', async () => {
    const r = await fetch(BASE + '/api/health', { headers: { 'User-Agent': 'GateTest-live-probe' } });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
  });
});
