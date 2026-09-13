/**
 * Unit tests for integrations/smoke/empire-smoke.js
 *
 * Run with: node --test tests/empire-smoke.test.js
 *
 * MOVED HERE 2026-08-29, and the move is part of the fix. This file used to
 * sit next to the module in integrations/smoke/, where NOTHING RAN IT: every
 * sweep and every CI job globs `tests/*.test.js`. So the probe rotted for two
 * months behind a test suite that was never executed — the module was
 * invisible AND its tests were invisible. Living in tests/ means the next
 * rename breaks a build instead of waiting to be discovered.
 *
 * All network primitives (fetch, DNS resolve, TLS connect) are injected as
 * mocks; these tests never touch the network.
 *
 * TARGETS CORRECTED 2026-08-29 — and the corrections are what these tests
 * mostly guard. Crontech was renamed Vapron on 2026-06-12; this probe was
 * never updated and, because nothing ever ran it, nothing said so. Three of
 * its five probes could not have passed:
 *
 *   - api.crontech.ai and gluecron.crontech.ai no longer resolve at all.
 *   - The homepage probe demanded the body contain "Crontech"; vapron.ai
 *     serves "Vapron", so a perfectly healthy site read as FAIL.
 *   - The health probe demanded `ok:true`; Vapron answers
 *     `{"status":"ok","checks":[...]}` — right host, still red.
 *
 * A probe nobody runs is worse than no probe: it rots in place and you find
 * out the day you need it. Hence the assertions below on BOTH health-payload
 * shapes and on the rename redirect itself.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runEmpireSmoke,
  probeApiHealth,
  probeRedirect,
  probePlatformStatus,
  DEFAULT_URLS,
  SLOW_MS,
  DEFAULT_TIMEOUT_MS,
} = require('../integrations/smoke/empire-smoke');

/**
 * Build a mock fetch that dispatches on URL prefix. Responses are plain
 * objects shaped like the subset of the Fetch Response contract our probes
 * actually consume.
 */
function makeFetch(responses) {
  return async (url) => {
    for (const [prefix, builder] of Object.entries(responses)) {
      if (url.startsWith(prefix)) {
        return builder();
      }
    }
    throw new Error(`mock fetch: no handler for ${url}`);
  };
}

function okText(body, { httpVersion = '2.0' } = {}) {
  return {
    status: 200,
    httpVersion,
    text: async () => body,
    headers: { get: () => null },
  };
}

function okJson(obj) {
  return {
    status: 200,
    httpVersion: '2.0',
    json: async () => obj,
    headers: { get: () => null },
  };
}

function status(code) {
  return {
    status: code,
    httpVersion: '2.0',
    text: async () => '',
    json: async () => ({}),
    headers: { get: () => null },
  };
}

function redirect(code, location) {
  return {
    status: code,
    httpVersion: '2.0',
    text: async () => '',
    json: async () => ({}),
    headers: { get: (h) => (String(h).toLowerCase() === 'location' ? location : null) },
  };
}

// A resolve() that always succeeds (apex DNS exists).
const resolveOk = async () => ['1.2.3.4'];

// A resolve() that simulates NXDOMAIN.
const resolveNxdomain = async () => {
  const err = new Error('ENOTFOUND gluecron.com');
  err.code = 'ENOTFOUND';
  throw err;
};

// Build a TLS mock that reports a cert expiring N days from now.
function tlsConnectInDays(days) {
  return async () => {
    const notAfter = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    return { valid_to: notAfter.toUTCString() };
  };
}

/** The all-healthy world, mirroring what the live estate actually returns. */
function healthyFetch(overrides = {}) {
  return makeFetch(
    Object.assign(
      {
        'https://vapron.ai/api/health': () =>
          okJson({ status: 'ok', checks: [{ name: 'database', ok: true }] }),
        'https://api.vapron.ai/api/health': () =>
          okJson({ status: 'ok', checks: [{ name: 'database', ok: true }] }),
        'https://vapron.ai/': () => okText('<html>Welcome to Vapron</html>'),
        'https://crontech.ai/': () => redirect(301, 'https://vapron.ai/'),
        'https://gluecron.com/api/platform-status': () =>
          okJson({ product: 'gluecron', healthy: true, commit: 'unknown' }),
        'https://gluecron.com/': () => okText('<html>Gluecron</html>'),
        'https://gatetest.io/api/platform-status': () =>
          okJson({ product: 'gatetest', healthy: true, commit: '37d3ba20596eac' }),
      },
      overrides
    )
  );
}

function run(overrides = {}, opts = {}) {
  return runEmpireSmoke({
    fetch: healthyFetch(overrides),
    resolve: opts.resolve || resolveOk,
    tlsConnect: opts.tlsConnect || tlsConnectInDays(90),
    timeoutMs: 1000,
    ...(opts.urls ? { urls: opts.urls } : {}),
  });
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

test('all probes pass -> green', async () => {
  const report = await run();
  assert.equal(report.status, 'green', JSON.stringify(report.probes, null, 2));
  assert.equal(report.probes.length, 7);
  assert.ok(report.probes.every((p) => p.status === 'pass'));
});

test('a dead host -> red', async () => {
  const report = await run({ 'https://api.vapron.ai/api/health': () => status(503) });
  assert.equal(report.status, 'red');
  const probe = report.probes.find((p) => p.name === 'vapron-api-health');
  assert.equal(probe.status, 'fail');
});

test('gluecron apex NXDOMAIN -> skip (soft info), overall still green', async () => {
  const report = await run({}, { resolve: resolveNxdomain });
  const apex = report.probes.find((p) => p.name === 'gluecron-apex');
  assert.equal(apex.status, 'skip');
  assert.equal(report.status, 'green', 'a skip must not degrade the rollup');
});

test('cert expiring inside the warning window -> warn -> yellow', async () => {
  const report = await run({}, { tlsConnect: tlsConnectInDays(7) });
  assert.equal(report.status, 'yellow');
  // The exact day count is floor()'d against elapsed ms, so 7 can render as
  // 6 — pin the behaviour (a warning inside the window), not the rounding.
  assert.match(report.probes.find((p) => p.name === 'cert-vapron').detail, /expires in \d+d/);
});

test('an already-expired cert fails rather than warns', async () => {
  const report = await run({}, { tlsConnect: tlsConnectInDays(-3) });
  assert.equal(report.status, 'red');
  assert.match(report.probes.find((p) => p.name === 'cert-vapron').detail, /expired/);
});

test('markdown report shape includes table header and all probes', async () => {
  const report = await run();
  assert.match(report.markdown, /\| Probe \| Status \| Latency \| Detail \|/);
  for (const p of report.probes) {
    assert.ok(report.markdown.includes(p.name), `markdown missing ${p.name}`);
  }
});

// ---------------------------------------------------------------------------
// SLOW IS NOT DOWN
//
// Measured 2026-08-29: vapron.ai's 365KB homepage took 1.5s / 9.2s / 19.8s
// from a New Zealand dev box and ~300ms from a GitHub runner — the same page,
// the same minute, with TTFB fast (0.5-3.7s) in both. The server answers
// promptly; bulk transfer over one network path drags.
//
// So under the original 5s hard timeout, a perfectly healthy site read as
// FAIL depending only on WHERE you probed from. Latency belongs to the path
// as much as the server and must not mean "outage" — a monitor that cries
// wolf gets muted, and a muted monitor protects nobody.
// ---------------------------------------------------------------------------

test('a successful but slow probe warns instead of passing', async () => {
  const slowFetch = async (url) => {
    await new Promise((r) => setTimeout(r, 60));
    return healthyFetch()(url);
  };
  const report = await runEmpireSmoke({
    fetch: slowFetch,
    resolve: resolveOk,
    tlsConnect: tlsConnectInDays(90),
    timeoutMs: 2000,
    slowMs: 30, // everything is "slow" at this budget
  });
  assert.equal(report.status, 'yellow');
  // cert-vapron goes through the TLS mock, not fetch, so it is not delayed
  // and legitimately still passes — every fetch-backed probe must warn.
  const fetchBacked = report.probes.filter((p) => p.name !== 'cert-vapron');
  assert.ok(
    fetchBacked.every((p) => p.status === 'warn'),
    JSON.stringify(report.probes.map((p) => [p.name, p.status]))
  );
  assert.match(report.probes[0].detail, /slow: \d+ms > 30ms/);
});

test('slow does not mask a real failure', async () => {
  // A failing probe stays red no matter how the latency budget is set.
  const report = await runEmpireSmoke({
    fetch: healthyFetch({ 'https://api.vapron.ai/api/health': () => status(500) }),
    resolve: resolveOk,
    tlsConnect: tlsConnectInDays(90),
    timeoutMs: 2000,
    slowMs: 1,
  });
  assert.equal(report.status, 'red');
  assert.equal(report.probes.find((p) => p.name === 'vapron-api-health').status, 'fail');
});

test('the hard timeout is well above the slow budget', () => {
  // If these ever cross, "slow" becomes unreachable and every slow site is
  // reported as down again — the exact bug this split fixed.
  assert.ok(
    DEFAULT_TIMEOUT_MS > SLOW_MS * 2,
    `hard timeout ${DEFAULT_TIMEOUT_MS}ms must leave room above the ${SLOW_MS}ms slow budget`
  );
});

// ---------------------------------------------------------------------------
// THE RENAME — the reason this file was wrong for two months.
// ---------------------------------------------------------------------------

test('no probe still targets a crontech host except the redirect guard', () => {
  const targets = Object.entries(DEFAULT_URLS)
    .filter(([, v]) => typeof v === 'string' && v.includes('crontech'));
  assert.deepEqual(
    targets.map(([k]) => k),
    ['crontechRedirect'],
    'crontech.ai was renamed to vapron.ai on 2026-06-12; the only legitimate ' +
      'remaining reference is the probe asserting the redirect still works'
  );
});

test('the homepage keyword matches the CURRENT brand, not the old one', async () => {
  // The exact stale-target failure: a healthy site whose body says "Vapron"
  // was failed for not saying "Crontech".
  const report = await run({ 'https://vapron.ai/': () => okText('<html>Welcome to Vapron</html>') });
  assert.equal(report.probes.find((p) => p.name === 'vapron-home').status, 'pass');

  // Negative control: a parked page or misrouted vhost is still caught.
  const parked = await run({ 'https://vapron.ai/': () => okText('<html>Default Web Page</html>') });
  assert.equal(parked.probes.find((p) => p.name === 'vapron-home').status, 'fail');
});

test('the rename redirect is asserted, and a broken one fails', async () => {
  const ok = await run();
  assert.equal(ok.probes.find((p) => p.name === 'crontech-redirect').status, 'pass');

  // Redirect quietly repointed somewhere else.
  const wrong = await run({ 'https://crontech.ai/': () => redirect(301, 'https://example.com/') });
  const probe = wrong.probes.find((p) => p.name === 'crontech-redirect');
  assert.equal(probe.status, 'fail');
  assert.match(probe.detail, /expected vapron\.ai/);

  // Redirect gone entirely — serving 200 instead of hopping.
  const gone = await run({ 'https://crontech.ai/': () => status(200) });
  assert.equal(gone.probes.find((p) => p.name === 'crontech-redirect').status, 'fail');
});

// The platform is being renamed (Vapron → Tallrig, 2026-09). During the
// window crontech.ai will 301 to the previous name, which 301s to the new
// one. The probe follows the chain and judges the FINAL destination, read
// from platform-config (env-driven), tolerating an intermediate hop.
test('the rename redirect passes on the final destination, through one intermediate hop', async () => {
  const twoHop = await run({
    'https://crontech.ai/': () => redirect(301, 'https://old-name.example/'),
    'https://old-name.example/': () => redirect(301, 'https://vapron.ai/'),
  });
  const probe = twoHop.probes.find((p) => p.name === 'crontech-redirect');
  assert.equal(probe.status, 'pass', probe.detail);
  assert.match(probe.detail, /old-name\.example.*vapron\.ai/);

  // A chain that never reaches the canonical host fails and names the last host.
  const stuck = await run({
    'https://crontech.ai/': () => redirect(301, 'https://old-name.example/'),
    'https://old-name.example/': () => status(200),
  });
  const stuckProbe = stuck.probes.find((p) => p.name === 'crontech-redirect');
  assert.equal(stuckProbe.status, 'fail');
  assert.match(stuckProbe.detail, /old-name\.example.*expected vapron\.ai/);

  // The expected host is env-driven: a deployment that has flipped asserts the new host.
  const flipped = await run(
    {
      'https://crontech.ai/': () => redirect(301, 'https://vapron.ai/'),
      'https://vapron.ai/': () => redirect(301, 'https://new-name.example/'),
    },
    { urls: { redirectHost: 'new-name.example' } },
  );
  assert.equal(flipped.probes.find((p) => p.name === 'crontech-redirect').status, 'pass');
});

// ---------------------------------------------------------------------------
// Health payload shapes — both are in use across the estate.
// ---------------------------------------------------------------------------

test('probeApiHealth accepts BOTH {status:"ok"} and {ok:true}', async () => {
  const shapes = [{ status: 'ok' }, { ok: true }, { healthy: true }];
  for (const body of shapes) {
    const res = await probeApiHealth(makeFetch({ 'https://x/': () => okJson(body) }), 'https://x/');
    assert.equal(res.status, 'pass', JSON.stringify(body));
  }
});

test('probeApiHealth rejects a payload that claims nothing', async () => {
  const res = await probeApiHealth(
    makeFetch({ 'https://x/': () => okJson({ status: 'degraded' }) }),
    'https://x/'
  );
  assert.equal(res.status, 'fail');
});

test('a failing subcheck degrades to warn, not pass', async () => {
  // The service answers, but its database is down. Neither green nor red.
  const res = await probeApiHealth(
    makeFetch({
      'https://x/': () => okJson({ status: 'ok', checks: [{ name: 'database', ok: false }] }),
    }),
    'https://x/'
  );
  assert.equal(res.status, 'warn');
  assert.match(res.detail, /database/);
});

// ---------------------------------------------------------------------------
// platform-status contract
// ---------------------------------------------------------------------------

test('platform-status requires healthy:true', async () => {
  const res = await probePlatformStatus(
    makeFetch({ 'https://x/': () => okJson({ healthy: false }) }),
    'https://x/'
  );
  assert.equal(res.status, 'fail');
});

test('a deployment that cannot name its own commit warns (KI #79 class)', async () => {
  // Healthy, serving traffic, and nobody can tell what build it is.
  const res = await probePlatformStatus(
    makeFetch({ 'https://x/': () => okJson({ healthy: true, commit: 'unknown' }) }),
    'https://x/',
    { requireCommit: true }
  );
  assert.equal(res.status, 'warn');
  assert.match(res.detail, /unknown/);
});

test('requireCommit is off by default, so a known-open gap is not noise', async () => {
  // Gluecron reports commit "unknown" today (KI #81). That is tracked there;
  // failing this probe on it every run would train everyone to ignore it.
  const res = await probePlatformStatus(
    makeFetch({ 'https://x/': () => okJson({ healthy: true, commit: 'unknown' }) }),
    'https://x/'
  );
  assert.equal(res.status, 'pass');
});

test('probeRedirect rejects a 3xx with no Location header', async () => {
  const res = await probeRedirect(
    makeFetch({ 'https://x/': () => ({ status: 301, headers: { get: () => null } }) }),
    'https://x/',
    'vapron.ai'
  );
  assert.equal(res.status, 'fail');
  assert.match(res.detail, /no Location/);
});
