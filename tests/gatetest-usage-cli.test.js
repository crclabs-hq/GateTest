'use strict';

// =============================================================================
// `gatetest usage` — the usage meter on the command line (bin/gatetest-usage.js)
// =============================================================================
// main() is exercised directly with fetch stubbed and console captured, so
// nothing here touches the network; two spawns prove the subcommand is
// routed by bin/gatetest.js. Control pairs throughout (Doctrine #3):
//   - a key + a 200 report → the table (or --json) on stdout, exit 0
//   - no key               → ONE line on stderr, NOTHING on stdout, exit 2,
//                            and fetch is never called (no fake zeros — #1)
//   - the API unreachable / refusing → one line, exit 1, stdout empty
//   - an authenticated account with no events → "No usage recorded yet",
//                            never a $0.00 bill
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const usage = require('../bin/gatetest-usage.js');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'gatetest.js');
const BASE = 'https://usage.test';
const KEY = 'gt_live_' + 'a'.repeat(32);

function captureLogs(fn) {
  const logs = [];
  const errors = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => errors.push(a.join(' '));
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.log = origLog;
      console.error = origError;
    })
    .then((code) => ({ code, logs, errors, stdout: logs.join('\n'), stderr: errors.join('\n') }));
}

/** A fetch stub that records its calls and answers with one canned response. */
function stubFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

function report(overrides = {}) {
  return {
    summary: {
      window: { from: '2026-08-18T00:00:00.000Z', to: '2026-09-16T12:00:00.000Z' },
      events: 3, scans: 2, fixes: 1, modulesRun: 14, findingsTotal: 27, findingsBlocking: 4,
      aiCalls: 5, tokensIn: 12000, tokensOut: 3000, tokensTotal: 15000,
      usdEstimated: 0.0725, usdGatetestPaid: 0.0225, usdByok: 0.05, byokEvents: 1,
      ...overrides.summary,
    },
    series: [
      { day: '2026-09-15', events: 2, aiCalls: 3, tokensIn: 8000, tokensOut: 2000, usdEstimated: 0.0225, findingsTotal: 20 },
      { day: '2026-09-16', events: 1, aiCalls: 2, tokensIn: 4000, tokensOut: 1000, usdEstimated: 0.05, findingsTotal: 7 },
    ],
    bySurface: {
      web: { events: 2, modulesRun: 12, findingsTotal: 20, findingsBlocking: 3, aiCalls: 3, tokensIn: 8000, tokensOut: 2000, usdEstimated: 0.0225, usdByok: 0, byokEvents: 0 },
      'hosted-fix': { events: 1, modulesRun: 2, findingsTotal: 7, findingsBlocking: 1, aiCalls: 2, tokensIn: 4000, tokensOut: 1000, usdEstimated: 0.05, usdByok: 0.05, byokEvents: 1 },
    },
    recent: [
      { id: 9, occurredAt: '2026-09-16T10:12:00.000Z', surface: 'hosted-fix', repo: 'acme/webapp', suite: 'full', tier: null, scanId: 's9', modulesRun: 2, findingsTotal: 7, findingsBlocking: 1, aiCalls: 2, tokensIn: 4000, tokensOut: 1000, usdEstimated: 0.05, keyOwner: 'byok', modelTier: 'deep' },
      { id: 8, occurredAt: '2026-09-15T09:00:00.000Z', surface: 'web', repo: 'acme/api', suite: 'quick', tier: 'standard', scanId: 's8', modulesRun: 6, findingsTotal: 10, findingsBlocking: 1, aiCalls: 1, tokensIn: 4000, tokensOut: 1000, usdEstimated: 0.0125, keyOwner: 'gatetest', modelTier: 'standard' },
    ],
    nextCursor: null,
    ...overrides.top,
  };
}

const ENV_WITH_KEY = { GATETEST_API_KEY: KEY };
const ENV_NO_KEY = {};

describe('gatetest usage — module shape', () => {
  it('exports main and the pure helpers', () => {
    assert.equal(typeof usage.main, 'function');
    assert.equal(typeof usage.formatUsageTable, 'function');
    assert.equal(typeof usage.parseUsageArgs, 'function');
    assert.equal(usage.KEY_ENV, 'GATETEST_API_KEY');
    assert.equal(usage.KEY_PREFIX, 'gt_live_');
  });
});

describe('gatetest usage — parseUsageArgs', () => {
  it('reads --json, --from, --to, --key; collects unknown flags instead of ignoring them', () => {
    const a = usage.parseUsageArgs(['--json', '--from', '2026-09-01', '--to', '2026-09-16', '--key', KEY]);
    assert.equal(a.json, true);
    assert.equal(a.from, '2026-09-01');
    assert.equal(a.to, '2026-09-16');
    assert.equal(a.key, KEY);
    assert.deepEqual(a.problems, []);
    const b = usage.parseUsageArgs(['--nope', 'stray', '--from']);
    assert.deepEqual(b.problems, ['unknown option --nope', 'unexpected argument stray', '--from needs a value']);
  });
});

describe('gatetest usage — formatUsd (exact from integer micros)', () => {
  it('whole cents print with two decimals, sub-cent estimates with four, zero as $0.00', () => {
    assert.equal(usage.formatUsd(0), '$0.00');
    assert.equal(usage.formatUsd(0.02), '$0.02');
    assert.equal(usage.formatUsd(1234.5), '$1,234.50');
    assert.equal(usage.formatUsd(0.0025), '$0.0025');
    assert.equal(usage.formatUsd(0.0725), '$0.0725');
    // Control: float noise from a double never leaks into the string.
    assert.equal(usage.formatUsd(0.1 + 0.2), '$0.30');
    assert.equal(usage.formatUsd(-1), '$0.00');
    assert.equal(usage.formatUsd('nonsense'), '$0.00');
  });
});

describe('gatetest usage — control: authenticated, the API answers', () => {
  it('prints the table with runs, BYOK vs metered cost, surfaces, days and recent rows; exit 0', async () => {
    const fetch = stubFetch(200, report());
    const r = await captureLogs(() => usage.main([], { env: ENV_WITH_KEY, fetch, baseUrl: BASE }));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.errors.length, 0, 'nothing on stderr on success');
    assert.match(r.stdout, /2026-08-18 → 2026-09-16 \(UTC\)/);
    assert.match(r.stdout, /Runs\s+2 scans · 1 fixes · 14 modules run/);
    assert.match(r.stdout, /Findings\s+27 total · 4 blocking/);
    assert.match(r.stdout, /AI\s+5 calls · 12,000 tokens in · 3,000 out · 15,000 total/);
    assert.match(r.stdout, /Cost\s+\$0\.0725 estimated/);
    assert.match(r.stdout, /BYOK \(your own model API key\)\s+\$0\.05\s+· 1 run\b/);
    assert.match(r.stdout, /Metered \(GateTest key\)\s+\$0\.0225\s+· 2 runs/);
    assert.match(r.stdout, /By surface/);
    assert.match(r.stdout, /hosted-fix\s+1\s+7\s+2\s+5,000\s+\$0\.05\s+1/);
    assert.match(r.stdout, /By day \(2 active days; quiet days omitted\)/);
    assert.match(r.stdout, /Recent \(newest first, 2 shown\)/);
    assert.match(r.stdout, /2026-09-16 10:12\s+hosted-fix\s+acme\/webapp\s+full\s+7\s+2\s+5,000\s+\$0\.05\s+BYOK/);
    assert.match(r.stdout, /2026-09-15 09:00\s+web\s+acme\/api\s+quick\s+10\s+1\s+5,000\s+\$0\.0125\s+metered/);
    // Exactly one request, to the v1 usage endpoint, with the key as a Bearer token.
    assert.equal(fetch.calls.length, 1);
    assert.equal(fetch.calls[0].url, `${BASE}/api/v1/usage`);
    assert.equal(fetch.calls[0].init.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(fetch.calls[0].init.method, 'GET');
  });

  it('--from / --to reach the API as query params; --key overrides the environment', async () => {
    const fetch = stubFetch(200, report());
    const other = 'gt_live_' + 'b'.repeat(32);
    const r = await captureLogs(() => usage.main(['--from', '2026-09-01', '--to', '2026-09-10', '--key', other], { env: ENV_WITH_KEY, fetch, baseUrl: BASE }));
    assert.equal(r.code, 0, r.stderr);
    const u = new URL(fetch.calls[0].url);
    assert.equal(u.pathname, '/api/v1/usage');
    assert.equal(u.searchParams.get('from'), '2026-09-01');
    assert.equal(u.searchParams.get('to'), '2026-09-10');
    assert.equal(fetch.calls[0].init.headers.Authorization, `Bearer ${other}`);
  });

  it('--json prints the API body as ONE JSON document on stdout and nothing else', async () => {
    const body = report();
    const fetch = stubFetch(200, body);
    const r = await captureLogs(() => usage.main(['--json'], { env: ENV_WITH_KEY, fetch, baseUrl: BASE }));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.errors.length, 0);
    assert.deepEqual(JSON.parse(r.stdout), body);
  });

  it('an account with no events says "No usage recorded yet" — no table, no $0.00 line', async () => {
    const empty = report({
      summary: { events: 0, scans: 0, fixes: 0, modulesRun: 0, findingsTotal: 0, findingsBlocking: 0, aiCalls: 0, tokensIn: 0, tokensOut: 0, tokensTotal: 0, usdEstimated: 0, usdGatetestPaid: 0, usdByok: 0, byokEvents: 0 },
      top: { series: [{ day: '2026-09-16', events: 0, aiCalls: 0, tokensIn: 0, tokensOut: 0, usdEstimated: 0, findingsTotal: 0 }], bySurface: {}, recent: [] },
    });
    const r = await captureLogs(() => usage.main([], { env: ENV_WITH_KEY, fetch: stubFetch(200, empty), baseUrl: BASE }));
    assert.equal(r.code, 0, 'a verified empty account is a real answer, not a failure');
    assert.match(r.stdout, /No usage recorded yet for this window/);
    assert.doesNotMatch(r.stdout, /\$0\.00/, 'zeros must not be dressed as a bill');
    assert.doesNotMatch(r.stdout, /By surface|Recent \(/);
  });
});

describe('gatetest usage — control: not signed in, offline, or the API is not there', () => {
  it('no GATETEST_API_KEY → one stderr line naming the variable, stdout empty, exit 2, fetch never called', async () => {
    const fetch = stubFetch(200, report());
    const r = await captureLogs(() => usage.main([], { env: ENV_NO_KEY, fetch, baseUrl: BASE }));
    assert.equal(r.code, 2);
    assert.equal(r.logs.length, 0, 'nothing on stdout — no fake zeros');
    assert.equal(r.errors.length, 1, 'exactly one line');
    assert.match(r.stderr, /not signed in/);
    assert.match(r.stderr, /GATETEST_API_KEY/);
    assert.match(r.stderr, /gt_live_/);
    assert.equal(fetch.calls.length, 0, 'no request without a key');
  });

  it('a hosted-MCP (gtmcp_) key is refused before any request, naming the key type the API needs', async () => {
    const fetch = stubFetch(200, report());
    const r = await captureLogs(() => usage.main([], { env: { GATETEST_API_KEY: 'gtmcp_' + 'c'.repeat(64) }, fetch, baseUrl: BASE }));
    assert.equal(r.code, 2);
    assert.equal(r.logs.length, 0);
    assert.match(r.stderr, /hosted-MCP subscription key/);
    assert.match(r.stderr, /gt_live_/);
    assert.equal(fetch.calls.length, 0);
  });

  it('GATETEST_OFFLINE=1 → refused out loud, exit 2, no request (Fifty move 42)', async () => {
    const fetch = stubFetch(200, report());
    const r = await captureLogs(() => usage.main([], { env: { ...ENV_WITH_KEY, GATETEST_OFFLINE: '1' }, fetch, baseUrl: BASE }));
    assert.equal(r.code, 2);
    assert.equal(r.logs.length, 0);
    assert.match(r.stderr, /offline mode/);
    assert.equal(fetch.calls.length, 0);
  });

  it('network failure → one stderr line "could not reach <host>", stdout empty, exit 1', async () => {
    const fetch = async () => { throw new Error('ECONNREFUSED'); };
    const r = await captureLogs(() => usage.main([], { env: ENV_WITH_KEY, fetch, baseUrl: BASE }));
    assert.equal(r.code, 1);
    assert.equal(r.logs.length, 0);
    assert.equal(r.errors.length, 1);
    assert.match(r.stderr, /could not reach usage\.test \(ECONNREFUSED\)/);
  });

  it('401 from the API → relays the server message, hints at the key, exit 1; 503 says nothing was checked', async () => {
    const r401 = await captureLogs(() => usage.main([], { env: ENV_WITH_KEY, fetch: stubFetch(401, { error: 'Invalid API key', code: 'AUTH_FAILED' }), baseUrl: BASE }));
    assert.equal(r401.code, 1);
    assert.equal(r401.logs.length, 0);
    assert.match(r401.stderr, /answered 401: Invalid API key/);
    assert.match(r401.stderr, /GATETEST_API_KEY/);
    const r503 = await captureLogs(() => usage.main([], { env: ENV_WITH_KEY, fetch: stubFetch(503, { error: 'database not configured', code: 'DB_UNAVAILABLE' }), baseUrl: BASE }));
    assert.equal(r503.code, 1);
    assert.match(r503.stderr, /answered 503: database not configured/);
    assert.match(r503.stderr, /nothing was checked/);
  });

  it('a 200 without a summary is not a report — exit 1, not a blank table', async () => {
    const r = await captureLogs(() => usage.main([], { env: ENV_WITH_KEY, fetch: stubFetch(200, { hello: 'world' }), baseUrl: BASE }));
    assert.equal(r.code, 1);
    assert.equal(r.logs.length, 0);
    assert.match(r.stderr, /without a usage summary/);
  });

  it('an unknown flag is a usage error (exit 2), never a silently narrowed report', async () => {
    const fetch = stubFetch(200, report());
    const r = await captureLogs(() => usage.main(['--window', '7d'], { env: ENV_WITH_KEY, fetch, baseUrl: BASE }));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown option --window/);
    assert.equal(fetch.calls.length, 0);
  });
});

describe('gatetest usage — routed by bin/gatetest.js', () => {
  function runCli(args, env) {
    const clean = { ...process.env, GATETEST_NO_TELEMETRY: '1', NO_COLOR: '1' };
    delete clean.GATETEST_API_KEY;
    delete clean.GATETEST_OFFLINE;
    return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 60000, env: { ...clean, ...env } });
  }

  it('`gatetest usage --help` prints the subcommand help and exits 0', () => {
    const r = runCli(['usage', '--help']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /gatetest usage \[options\]/);
    assert.match(r.stdout, /GATETEST_API_KEY/);
  });

  it('`gatetest usage` with no key exits 2 with the one line — and never starts a scan', () => {
    const r = runCli(['usage']);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.equal(r.stdout.trim(), '');
    assert.match(r.stderr, /not signed in/);
    assert.doesNotMatch(r.stdout + r.stderr, /Running|modules loaded|Scanning/i);
  });

  it('bin/gatetest.js lists the subcommand in its route table and its help', () => {
    const src = fs.readFileSync(BIN, 'utf8');
    assert.match(src, /KNOWN_SUBCOMMANDS = new Set\(\[[^\]]*'usage'/);
    assert.match(src, /if \(first === 'usage'\) \{/);
    assert.match(src, /require\('\.\/gatetest-usage'\)/);
    assert.match(src, /gatetest usage \[options\]/);
  });
});

describe('gatetest usage — customer-facing copy is vendor-neutral', () => {
  it('names no AI vendor or model in any string literal', () => {
    const src = fs.readFileSync(path.join(ROOT, 'bin', 'gatetest-usage.js'), 'utf8');
    const strings = (src.match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) || []).join('\n');
    assert.doesNotMatch(strings, /\b(claude|anthropic|fable|sonnet|opus|haiku|openai|gpt-?\d)\b/i);
  });

  it('uses the one definition of the API origin (src/core/site-url), no hard-coded domain', () => {
    const src = fs.readFileSync(path.join(ROOT, 'bin', 'gatetest-usage.js'), 'utf8');
    assert.match(src, /require\('\.\.\/src\/core\/site-url'\)/);
    assert.doesNotMatch(src, /gatetest\.(io|ai)/, 'no domain literal — apiBaseUrl()/siteUrl() own it');
  });
});
