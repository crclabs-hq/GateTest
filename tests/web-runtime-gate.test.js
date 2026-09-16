'use strict';

// =============================================================================
// WEB RUNTIME GATE — the hosted browser pass fails CLOSED and says so (KI #111)
// =============================================================================
// Before this module (2026-09-15) the hosted web scan's runtime half had three
// silent defaults: /api/web/scan dispatched whenever a callback base URL was
// set — token or no token — and echoed the dispatcher's string (env-var names,
// platform name, 300 bytes of a remote error body) to the browser; the stream
// routes never dispatched and hard-coded "Runtime worker wiring pending"; and a
// queued job whose callback never arrived was polled forever. The platform
// team confirmed the same day that no /api/jobs/web-runtime-scan handler
// exists, so every hosted dispatch was a 404 or a skipped step.
//
// Doctrine #1 / #3 / #6: three control pairs — env absent (no fetch, says
// not-configured), env present + 404 (says dispatch-failed:404), env present +
// 202 (queued, signed) — plus the source-text contract that every route and
// the UI carry the third state.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const gate = require('../website/app/lib/web-runtime-gate');
const { SIGNATURE_HEADER, TIMESTAMP_HEADER } = require('../website/app/lib/vapron-dispatch');

const FULL_ENV = Object.freeze({
  TALLRIG_BASE_URL: 'https://platform.test',
  TALLRIG_API_TOKEN: 'tok_secret_value',
  TALLRIG_DISPATCH_SECRET: 'hmac_secret_value',
  GATETEST_PUBLIC_BASE_URL: 'https://gatetest.example',
});

const JOB = Object.freeze({ scanId: 'scn_0123456789abcdef01', targetUrl: 'https://customer.example', suite: 'web' });

function countingFetch(response) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return response;
  };
  return { fn, calls };
}

function collectWarn() {
  const lines = [];
  return { warn: (line) => lines.push(line), lines };
}

describe('web-runtime-gate — (a) prerequisites absent: nothing is dispatched', () => {
  it('empty env → no fetch, status unavailable / not-configured / checked false', async () => {
    const { fn, calls } = countingFetch({ ok: true, status: 202, json: async () => ({ jobId: 'never' }) });
    const { warn, lines } = collectWarn();
    const r = await gate.gateRuntimeScan({ ...JOB, env: {}, fetchFn: fn, warn });
    assert.equal(calls.length, 0, 'fetch must not be attempted');
    assert.deepEqual(r, { status: 'unavailable', reason: 'not-configured', checked: false, jobId: null, pollUrl: null });
    assert.equal(lines.length, 1, 'exactly one structured warning');
  });

  it("production today (base URL + callback base, no token/secret) → still no fetch", async () => {
    const { fn, calls } = countingFetch({ ok: true, status: 202, json: async () => ({ jobId: 'never' }) });
    const env = { TALLRIG_BASE_URL: FULL_ENV.TALLRIG_BASE_URL, GATETEST_PUBLIC_BASE_URL: FULL_ENV.GATETEST_PUBLIC_BASE_URL };
    const r = await gate.gateRuntimeScan({ ...JOB, env, fetchFn: fn, warn: () => {} });
    assert.equal(calls.length, 0);
    assert.equal(r.reason, 'not-configured');
    assert.deepEqual(gate.missingRuntimePrerequisites(env), ['TALLRIG_API_TOKEN', 'TALLRIG_DISPATCH_SECRET']);
  });

  it('secrets present but no callback base → no fetch (the worker could never report back)', async () => {
    const { fn, calls } = countingFetch({ ok: true, status: 202, json: async () => ({ jobId: 'never' }) });
    const env = { ...FULL_ENV, GATETEST_PUBLIC_BASE_URL: undefined };
    const r = await gate.gateRuntimeScan({ ...JOB, env, fetchFn: fn, warn: () => {} });
    assert.equal(calls.length, 0);
    assert.equal(r.reason, 'not-configured');
    assert.deepEqual(gate.missingRuntimePrerequisites(env), ['GATETEST_PUBLIC_BASE_URL']);
  });

  it('the VAPRON_* aliases satisfy the prerequisites (the box has not renamed its variables)', () => {
    const env = {
      VAPRON_BASE_URL: 'https://platform.test', VAPRON_API_TOKEN: 't', VAPRON_DISPATCH_SECRET: 's',
      NEXT_PUBLIC_BASE_URL: 'https://gatetest.example',
    };
    assert.deepEqual(gate.missingRuntimePrerequisites(env), []);
  });

  it('the warning names the missing variables and never carries a value or hostname', async () => {
    const { warn, lines } = collectWarn();
    const env = { TALLRIG_BASE_URL: 'https://hidden-host.test', TALLRIG_API_TOKEN: 'tok_leak_me', GATETEST_PUBLIC_BASE_URL: 'https://gatetest.example' };
    await gate.gateRuntimeScan({ ...JOB, env, warn });
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.event, 'web-runtime-scan.not-dispatched');
    assert.deepEqual(parsed.missing, ['TALLRIG_DISPATCH_SECRET']);
    assert.ok(!lines[0].includes('hidden-host'), 'hostname must not be logged');
    assert.ok(!lines[0].includes('tok_leak_me'), 'token must not be logged');
  });
});

describe('web-runtime-gate — (b) prerequisites present, platform rejects', () => {
  it('404 → one fetch, unavailable / dispatch-failed:404, no upstream text in the response', async () => {
    const { fn, calls } = countingFetch({ ok: false, status: 404, text: async () => 'Cannot POST /api/jobs/web-runtime-scan on host platform.test' });
    const { warn, lines } = collectWarn();
    const r = await gate.gateRuntimeScan({ ...JOB, env: FULL_ENV, fetchFn: fn, warn });
    assert.equal(calls.length, 1);
    assert.deepEqual(r, { status: 'unavailable', reason: 'dispatch-failed:404', checked: false, jobId: null, pollUrl: null });
    assert.ok(!JSON.stringify(r).includes('platform.test'), 'client response must not carry the upstream body or host');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).httpStatus, 404);
  });

  it('503 → dispatch-failed:503', async () => {
    const { fn } = countingFetch({ ok: false, status: 503, text: async () => 'down' });
    const r = await gate.gateRuntimeScan({ ...JOB, env: FULL_ENV, fetchFn: fn, warn: () => {} });
    assert.equal(r.reason, 'dispatch-failed:503');
  });

  it('network failure → dispatch-failed:network; dispatcher timeout → dispatch-failed:timeout', async () => {
    const boom = async () => { throw new Error('ECONNREFUSED'); };
    const r1 = await gate.gateRuntimeScan({ ...JOB, env: FULL_ENV, fetchFn: boom, warn: () => {} });
    assert.equal(r1.reason, 'dispatch-failed:network');
    assert.equal(gate.dispatchFailureReason({ ok: false, reason: 'Dispatch timed out after 5000ms' }), 'dispatch-failed:timeout');
    assert.equal(gate.dispatchFailureReason({ ok: false, status: 0, reason: 'x' }), 'dispatch-failed:network');
  });

  it('2xx without a jobId is a failure, not a queued job', async () => {
    const { fn } = countingFetch({ ok: true, status: 202, json: async () => ({}) });
    const r = await gate.gateRuntimeScan({ ...JOB, env: FULL_ENV, fetchFn: fn, warn: () => {} });
    assert.equal(r.status, 'unavailable');
    assert.equal(r.reason, 'dispatch-failed:202');
  });

  it('a dispatcher that throws is contained — never bubbles to the route', async () => {
    const r = await gate.gateRuntimeScan({ ...JOB, env: FULL_ENV, dispatch: async () => { throw new Error('kaboom'); }, warn: () => {} });
    assert.equal(r.status, 'unavailable');
    assert.match(r.reason, /^dispatch-failed:/);
  });
});

describe('web-runtime-gate — (c) prerequisites present, platform accepts', () => {
  it('202 + jobId → queued, signed dispatch, poll URL and timeout budget', async () => {
    const { fn, calls } = countingFetch({ ok: true, status: 202, json: async () => ({ jobId: 'job_42', queuedAt: '2026-09-15T00:00:00Z' }) });
    const { warn, lines } = collectWarn();
    const r = await gate.gateRuntimeScan({ ...JOB, env: FULL_ENV, fetchFn: fn, warn });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://platform.test/api/jobs/web-runtime-scan');
    assert.equal(calls[0].opts.method, 'POST');
    assert.match(calls[0].opts.headers[SIGNATURE_HEADER], /^[0-9a-f]{64}$/, 'X-GateTest-Signature present');
    assert.ok(Number(calls[0].opts.headers[TIMESTAMP_HEADER]) > 0);
    assert.equal(calls[0].opts.headers.Authorization, 'Bearer tok_secret_value');
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.callbackUrl, 'https://gatetest.example/api/web/scan/runtime-callback');
    assert.equal(body.deadlineSec, gate.RUNTIME_DEADLINE_SEC);
    assert.deepEqual(r, {
      status: 'queued', reason: null, checked: false, jobId: 'job_42',
      pollUrl: `/api/web/scan/runtime-status?scanId=${JOB.scanId}`,
      timeoutSec: gate.RUNTIME_DEADLINE_SEC + gate.CALLBACK_GRACE_SEC,
    });
    assert.equal(lines.length, 0, 'a successful dispatch logs nothing');
  });

  it('auth rides inside the signed body when supplied, and is absent otherwise', async () => {
    const { fn, calls } = countingFetch({ ok: true, status: 202, json: async () => ({ jobId: 'j' }) });
    await gate.gateRuntimeScan({ ...JOB, env: FULL_ENV, fetchFn: fn, warn: () => {}, auth: { cookie: 'session=abc' } });
    await gate.gateRuntimeScan({ ...JOB, env: FULL_ENV, fetchFn: fn, warn: () => {} });
    assert.deepEqual(JSON.parse(calls[0].opts.body).auth, { cookie: 'session=abc' });
    assert.ok(!('auth' in JSON.parse(calls[1].opts.body)));
  });
});

describe('web-runtime-gate — callback-timeout', () => {
  it('a queued job is timed out only after deadline + grace', () => {
    const queuedAtMs = 1_000_000;
    const limit = (gate.RUNTIME_DEADLINE_SEC + gate.CALLBACK_GRACE_SEC) * 1000;
    assert.equal(gate.callbackTimedOut({ queuedAtMs, nowMs: queuedAtMs + limit }), false);
    assert.equal(gate.callbackTimedOut({ queuedAtMs, nowMs: queuedAtMs + limit + 1 }), true);
    assert.equal(gate.callbackTimedOut({ queuedAtMs: NaN, nowMs: 5 }), false);
  });
});

describe('web-runtime-gate — source-text contract: every surface carries the third state', () => {
  const routes = [
    'website/app/api/web/scan/route.ts',
    'website/app/api/web/scan/stream/route.ts',
    'website/app/api/wp/scan/stream/route.ts',
  ];

  it('every web/wp scan route resolves runtime through the gate and no silent default remains', () => {
    for (const rel of routes) {
      const src = read(rel);
      assert.match(src, /@\/app\/lib\/web-runtime-gate/, `${rel} must use web-runtime-gate`);
      assert.match(src, /gateRuntimeScan\(/, `${rel} must call gateRuntimeScan`);
      assert.ok(!src.includes('Runtime worker wiring pending'), `${rel} still carries the hard-coded default`);
      assert.ok(!/require\("@\/app\/lib\/vapron-dispatch"\)/.test(src), `${rel} must not dispatch around the gate`);
    }
  });

  it('the JSON route only claims the session was forwarded when a job was actually queued', () => {
    const src = read('website/app/api/web/scan/route.ts');
    assert.match(src, /sanitizedAuth && runtimeGate\.status === "queued"/);
  });

  it('the poll route reports checked:true only for a landed callback', () => {
    const src = read('website/app/api/web/scan/runtime-status/route.ts');
    assert.equal((src.match(/checked: true/g) || []).length, 1);
    assert.ok((src.match(/checked: false/g) || []).length >= 3);
    assert.ok(!/reason: err instanceof Error \? err\.message/.test(src), 'DB error text must not reach the client');
  });

  it('the UI prints the plain-English line and maps every reason code the gate can emit', () => {
    const ui = read('website/app/components/url-scan-flow-progress.tsx');
    assert.match(ui, /Runtime checks \(real-browser errors, headers under load\) were not run: \{describeRuntimeReason\(reason\)\}\. Static checks ran\./);
    for (const code of Object.values(gate.RUNTIME_REASONS)) {
      assert.ok(ui.includes(`"${code}"`), `UI must map reason code ${code}`);
    }
    assert.ok(ui.includes(`"${gate.DISPATCH_FAILED_PREFIX}"`), 'UI must map dispatch-failed:<status>');
    assert.ok(!/\{reason\}<\/p>/.test(ui), 'the raw reason code must not be rendered verbatim');
    assert.ok(!/tallrig|vapron|crontech/i.test(ui), 'UI copy must be platform-neutral');
    assert.match(ui, /onTimeoutRef\.current\(\)/, 'the poller must give up and report callback-timeout');
    const flow = read('website/app/components/UrlScanFlow.tsx');
    assert.match(flow, /reason: "callback-timeout", checked: false/);
    assert.match(flow, /onTimeout=\{markRuntimeTimedOut\}/);
  });
});
