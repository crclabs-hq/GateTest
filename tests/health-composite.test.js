// =============================================================================
// /api/health/deep — the composite readiness verdict can go red (issue #809)
// =============================================================================
// /api/health, /api/v1/health and /health are liveness pings: constant bodies
// that read green through a dead database, a silent queue and a rejected AI
// key (AlecRae, 2026-09-28). website/app/lib/health-composite.js is the pure
// verdict behind the new composite route. This pins:
//
//   1. CONTROL PAIRS — every required sub-check green → 200; one required
//      sub-check down → 503 naming that check; an optional sub-check that is
//      not configured → still 200; unknown → degraded but 200.
//   2. NO LEAK — a reason carrying an env var name, hostname, IP, URL or
//      error text is replaced before it ships (same guard as /status).
//   3. NO HANG — a probe that never answers is cut off at its ceiling and
//      reported with the status its caller chose; a throw is not a 500.
//   4. WIRING — the route imports the composer, keeps /api/health a bare
//      liveness ping, and the docs describe the endpoint.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const {
  CHECK_NAMES, REQUIRED_CHECKS, OPTIONAL_CHECKS, STATUSES, HEALTH_TTL_SECONDS, UNKNOWN_DETAIL,
  runCheck, runChecks, composeHealth, httpStatusOf,
} = require('../website/app/lib/health-composite.js');

const green = () => ({
  db: { status: 'ok', latencyMs: 12, reason: 'connected' },
  queue: { status: 'ok', latencyMs: 20, reason: '0 queued, 0 running, none stuck.' },
  ai: { status: 'ok', latencyMs: 8, reason: 'last successful AI call 4 min ago' },
  mail: { status: 'ok', latencyMs: 300, reason: 'mail provider accepted the key' },
  runtime: { status: 'ok', latencyMs: 250, reason: 'runtime worker platform reports healthy' },
});

describe('health-composite: the check roster', () => {
  it('is db, queue, ai, mail, runtime — required + optional partition it exactly', () => {
    assert.deepStrictEqual([...CHECK_NAMES], ['db', 'queue', 'ai', 'mail', 'runtime']);
    assert.deepStrictEqual([...REQUIRED_CHECKS, ...OPTIONAL_CHECKS].sort(), [...CHECK_NAMES].sort());
    assert.deepStrictEqual([...REQUIRED_CHECKS], ['db', 'queue', 'ai']);
    assert.deepStrictEqual([...OPTIONAL_CHECKS], ['mail', 'runtime']);
    assert.ok(STATUSES.includes('not-configured') && STATUSES.includes('down'));
  });
});

describe('health-composite: control pairs', () => {
  it('every sub-check ok → ok:true, status ok, HTTP 200, nothing failing', () => {
    const v = composeHealth(green(), { now: 1_700_000_000_000 });
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.status, 'ok');
    assert.strictEqual(httpStatusOf(v), 200);
    assert.deepStrictEqual(v.failing, []);
    assert.strictEqual(v.checkedAt, '2023-11-14T22:13:20.000Z');
    assert.strictEqual(v.ttlSeconds, HEALTH_TTL_SECONDS);
    for (const name of CHECK_NAMES) {
      assert.strictEqual(v.checks[name].status, 'ok');
      assert.strictEqual(typeof v.checks[name].latencyMs, 'number');
      assert.strictEqual(typeof v.checks[name].reason, 'string');
      assert.strictEqual(v.checks[name].required, REQUIRED_CHECKS.includes(name));
    }
  });

  for (const name of REQUIRED_CHECKS) {
    it(`required ${name} down → ok:false, HTTP 503, "${name}" named in failing`, () => {
      const results = green();
      results[name] = { status: 'down', latencyMs: 2000, reason: 'connection failed' };
      const v = composeHealth(results);
      assert.strictEqual(v.ok, false);
      assert.strictEqual(v.status, 'down');
      assert.strictEqual(httpStatusOf(v), 503);
      assert.deepStrictEqual(v.failing, [name]);
      assert.strictEqual(v.checks[name].status, 'down');
      assert.strictEqual(v.checks[name].reason, 'connection failed');
    });
  }

  it('a required check reported not-configured is down for readiness (503)', () => {
    const results = green();
    results.db = { status: 'not-configured', reason: 'database not configured' };
    const v = composeHealth(results);
    assert.strictEqual(v.status, 'down');
    assert.strictEqual(httpStatusOf(v), 503);
    assert.deepStrictEqual(v.failing, ['db']);
  });

  for (const name of OPTIONAL_CHECKS) {
    it(`optional ${name} not-configured → still ok:true / 200 and not listed as failing`, () => {
      const results = green();
      results[name] = { status: 'not-configured', latencyMs: 0, reason: 'not configured on this deployment' };
      const v = composeHealth(results);
      assert.strictEqual(v.ok, true);
      assert.strictEqual(v.status, 'ok');
      assert.strictEqual(httpStatusOf(v), 200);
      assert.deepStrictEqual(v.failing, []);
      assert.strictEqual(v.checks[name].status, 'not-configured');
    });

    it(`optional ${name} down → degraded, HTTP 200 (never 503 for an augmentation)`, () => {
      const results = green();
      results[name] = { status: 'down', latencyMs: 2500, reason: 'unreachable' };
      const v = composeHealth(results);
      assert.strictEqual(v.ok, true);
      assert.strictEqual(v.status, 'degraded');
      assert.strictEqual(httpStatusOf(v), 200);
      assert.deepStrictEqual(v.failing, [name]);
    });
  }

  it('ai unknown (no call recorded) → degraded, HTTP 200 — the issue\'s third control', () => {
    const results = green();
    results.ai = { status: 'unknown', latencyMs: 9, reason: 'no AI call recorded yet' };
    const v = composeHealth(results);
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.status, 'degraded');
    assert.strictEqual(httpStatusOf(v), 200);
    assert.deepStrictEqual(v.failing, ['ai']);
  });

  it('a required down outranks everything else: db down + ai unknown is down', () => {
    const results = green();
    results.db = { status: 'down', reason: 'connection failed' };
    results.ai = { status: 'unknown', reason: 'no call ledger without a database' };
    const v = composeHealth(results);
    assert.strictEqual(v.status, 'down');
    assert.deepStrictEqual(v.failing, ['db', 'ai']);
  });

  it('a check with no reading is reported unknown, never omitted or fabricated', () => {
    const v = composeHealth({ db: { status: 'ok', reason: 'connected' } });
    for (const name of CHECK_NAMES.filter((n) => n !== 'db')) {
      assert.strictEqual(v.checks[name].status, 'unknown');
      assert.strictEqual(v.checks[name].latencyMs, null);
    }
    assert.strictEqual(v.status, 'degraded');
    assert.strictEqual(httpStatusOf(v), 200);
  });

  it('garbage in → a verdict out (null, a string, an unknown status)', () => {
    for (const bad of [null, undefined, 'x', 42, []]) {
      const v = composeHealth(bad);
      assert.strictEqual(v.status, 'degraded');
      assert.strictEqual(v.ok, true);
    }
    const v = composeHealth({ ...green(), db: { status: 'SHINY', reason: 'x' } });
    assert.strictEqual(v.checks.db.status, 'unknown');
    assert.strictEqual(httpStatusOf(null), 503, 'no verdict is not a 200');
  });
});

describe('health-composite: no internal name leaves the body', () => {
  const hostile = [
    'DATABASE_URL is not set',
    'getaddrinfo ENOTFOUND db.internal.example.com',
    'connect ECONNREFUSED 10.0.1.1:5432',
    'https://api.tallrig.com/api/health/status answered 502',
    'Error: relation "usage_events" does not exist at /opt/gatetest/website/app/lib/db.ts',
    'sk_live_abcdef0123456789 rejected',
  ];
  for (const reason of hostile) {
    it(`replaces "${reason.slice(0, 40)}…"`, () => {
      const v = composeHealth({ ...green(), db: { status: 'down', reason } });
      assert.strictEqual(v.checks.db.reason, UNKNOWN_DETAIL);
      assert.ok(!JSON.stringify(v).includes(reason.split(' ')[0]));
    });
  }
  it('keeps the templated reasons the route writes', () => {
    const v = composeHealth(green());
    assert.strictEqual(v.checks.db.reason, 'connected');
    assert.strictEqual(v.checks.ai.reason, 'last successful AI call 4 min ago');
  });
});

describe('health-composite: runCheck / runChecks never hang, never throw', () => {
  it('a probe that never answers is cut off at its ceiling with the chosen status', async () => {
    const never = () => new Promise(() => {});
    const r = await runCheck(never, { timeoutMs: 40, onTimeout: 'down' });
    assert.strictEqual(r.status, 'down');
    assert.match(r.reason, /no answer within 40 ms/);
    assert.ok(r.latencyMs >= 35 && r.latencyMs < 1000, `latency ${r.latencyMs}`);
  });

  it('a throwing probe becomes the chosen status with a fixed reason — never its message', async () => {
    const boom = async () => { throw new Error('connect ECONNREFUSED 10.0.1.1:5432'); };
    const r = await runCheck(boom, { timeoutMs: 500, onError: 'down' });
    assert.strictEqual(r.status, 'down');
    assert.strictEqual(r.reason, 'check failed');
    assert.ok(!r.reason.includes('10.0.1.1'));
  });

  it('a synchronous throw and a non-function are handled the same way', async () => {
    const r1 = await runCheck(() => { throw new Error('sync'); }, { timeoutMs: 500 });
    assert.strictEqual(r1.status, 'unknown');
    const r2 = await runCheck(null, { timeoutMs: 500 });
    assert.strictEqual(r2.status, 'unknown');
  });

  it('a healthy probe reports ok with a measured latency', async () => {
    const r = await runCheck(async () => ({ status: 'ok', reason: 'connected' }), { timeoutMs: 500 });
    assert.strictEqual(r.status, 'ok');
    assert.strictEqual(r.reason, 'connected');
    assert.strictEqual(typeof r.latencyMs, 'number');
  });

  it('runChecks runs probes in parallel: three 60 ms probes finish in well under 180 ms', async () => {
    const slow = () => new Promise((resolve) => setTimeout(() => resolve({ status: 'ok', reason: 'connected' }), 60));
    const started = Date.now();
    const out = await runChecks({ db: slow, queue: slow, ai: slow }, { timeouts: { db: 500, queue: 500, ai: 500 } });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 170, `elapsed ${elapsed} ms`);
    assert.deepStrictEqual(Object.keys(out), ['db', 'queue', 'ai']);
    assert.strictEqual(out.queue.status, 'ok');
  });

  it('one hung probe does not hold the others: the verdict names it and answers on time', async () => {
    const never = () => new Promise(() => {});
    const fine = async () => ({ status: 'ok', reason: 'connected' });
    const started = Date.now();
    const out = await runChecks(
      { db: fine, queue: fine, ai: fine, mail: fine, runtime: never },
      { timeouts: { runtime: 50 }, onTimeout: { runtime: 'down' } },
    );
    assert.ok(Date.now() - started < 1000);
    const v = composeHealth(out);
    assert.strictEqual(v.status, 'degraded');
    assert.deepStrictEqual(v.failing, ['runtime']);
    assert.strictEqual(httpStatusOf(v), 200);
  });
});

describe('health-composite: wiring', () => {
  const route = read('website/app/api/health/deep/route.ts');
  const lib = read('website/app/lib/health-composite.js');

  it('GET /api/health/deep composes through the one definition and answers its HTTP status', () => {
    assert.match(route, /require\("@\/app\/lib\/health-composite"\)/);
    assert.match(route, /export async function GET\(/);
    assert.match(route, /composite\.composeHealth\(results\)/);
    assert.match(route, /status: composite\.httpStatusOf\(verdict\)/);
    assert.match(route, /auth-public/, 'a customer monitor polls it credential-free, on purpose');
  });

  it('the route gathers exactly the five sub-checks, each under its own ceiling', () => {
    assert.match(route, /\{ db: probeDb, queue: probeQueue, ai: probeAi, mail: probeMail, runtime: probeRuntime \}/);
    assert.match(route, /timeouts: \{ db: DB_TIMEOUT_MS, queue: DB_TIMEOUT_MS, ai: DB_TIMEOUT_MS, mail: HTTP_TIMEOUT_MS, runtime: HTTP_TIMEOUT_MS \}/);
    for (const c of [/const DB_TIMEOUT_MS = (\d+);/, /const HTTP_TIMEOUT_MS = (\d+);/]) {
      const m = route.match(c);
      assert.ok(m && Number(m[1]) <= 2500, `${c} must keep the route under a 5 s monitor budget`);
    }
  });

  it('the ai reading is the usage ledger, never a live call; the queue reading reuses the /status mappers', () => {
    assert.match(route, /FROM usage_events WHERE ai_calls > 0/);
    assert.ok(!/\/v1\/messages/.test(route), 'no live AI call on a health poll');
    assert.match(route, /_mappers\.mapHostedScans/);
    assert.match(route, /_mappers\.mapScanWorker/);
  });

  it('optional checks answer not-configured rather than down when unset', () => {
    assert.match(route, /status: "not-configured", reason: "no mail provider configured"/);
    assert.match(route, /status: "not-configured", reason: "runtime worker not configured on this deployment"/);
  });

  it('the verdict is cached for the TTL the composer declares', () => {
    assert.match(route, /unstable_cache\(/);
    assert.match(route, /revalidate: composite\.HEALTH_TTL_SECONDS/);
    assert.match(lib, /const HEALTH_TTL_SECONDS = 30;/);
  });

  it('/api/health stays a bare liveness ping — the container HEALTHCHECK must not restart on a DB blip', () => {
    const liveness = read('website/app/api/health/route.ts');
    assert.match(liveness, /\{ ok: true \}/);
    assert.ok(!/getDb|health-composite/.test(liveness));
  });

  it('nothing customer-visible names the pre-rename platform or an AI vendor', () => {
    const docs = read('docs/api/v1.md');
    const start = docs.indexOf('### `GET /api/health/deep`');
    assert.ok(start > 0, 'the endpoint section exists in docs/api/v1.md');
    const section = docs.slice(start, docs.indexOf('\n### ', start + 1));
    for (const [rel, src] of [['route', route], ['lib', lib], ['docs section', section]]) {
      assert.ok(!/vapron/i.test(src), `${rel} must not say the old platform name`);
      assert.ok(!/anthropic|claude|openai/i.test(src.replace(/ANTHROPIC_API_KEY/g, '')), `${rel} must not name an AI vendor`);
    }
  });

  it('the developer docs describe the endpoint, its sub-checks and the 503 rule', () => {
    const docs = read('docs/api/v1.md');
    assert.match(docs, /GET \/api\/health\/deep/);
    for (const name of CHECK_NAMES) assert.match(docs, new RegExp(`\`${name}\``));
    assert.match(docs, /503/);
    assert.match(docs, /not-configured/);
  });
});
