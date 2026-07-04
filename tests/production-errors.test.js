// ============================================================================
// PRODUCTION ERRORS AGGREGATOR TEST — src/core/production-errors.js
// ============================================================================
// Fake fetch sequences per vendor; asserts normalisation to the ONE shape
// {source, message, file, line, count, lastSeen, sourceLocation, raw},
// count-desc merge, per-source failure isolation, and env resolution.
// Datadog's client uses global fetch (no DI) — mocked via global.fetch.
// ============================================================================

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const {
  fetchProductionErrors,
  resolveSourcesFromEnv,
  normaliseSentryItem,
  normaliseDatadogItem,
} = require('../src/core/production-errors.js');

const SENTRY_CFG = { orgId: 'crclabs', projectSlug: 'gatetest', accessToken: 'tok' };
const DATADOG_CFG = { apiKey: 'k', appKey: 'a' };

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const SENTRY_ISSUES = [
  {
    id: '1', title: 'TypeError: cannot read x', culprit: 'src/api/checkout.ts in POST',
    count: 420, userCount: 30, lastSeen: '2026-07-03T10:00:00Z',
    metadata: { in_app_frames: [{ filename: 'src/api/checkout.ts', lineno: 44, function: 'POST' }] },
  },
  {
    id: '2', title: 'Minor warning-ish error', culprit: 'src/lib/util.ts',
    count: 3, userCount: 1, lastSeen: '2026-07-01T10:00:00Z',
    metadata: {},
  },
];

const DATADOG_EVENTS = {
  data: [
    {
      id: 'dd1',
      attributes: {
        timestamp: '2026-07-03T12:00:00Z',
        message: 'Error: boom\n    at handler (src/worker/tick.js:88:5)',
        service: 'worker',
        status: 'error',
        tags: [],
      },
    },
  ],
};

describe('normalisers', () => {
  it('sentry: first frame becomes file/line + sourceLocation', () => {
    const item = normaliseSentryItem({
      title: 'T', count: '7', lastSeen: 'x',
      frames: [{ file: 'src/a.ts', lineno: 12 }, { file: 'src/b.ts', lineno: 99 }],
    });
    assert.strictEqual(item.source, 'sentry');
    assert.strictEqual(item.file, 'src/a.ts');
    assert.strictEqual(item.line, 12);
    assert.deepStrictEqual(item.sourceLocation, { file: 'src/a.ts', line: 12 });
    assert.strictEqual(item.count, 7);
  });

  it('sentry: frameless issue keeps message but honest null location', () => {
    const item = normaliseSentryItem({ title: 'No frames', count: 5, frames: [] });
    assert.strictEqual(item.file, null);
    assert.strictEqual(item.sourceLocation, null);
  });

  it('datadog: sourceLocation passes through, first message line kept', () => {
    const item = normaliseDatadogItem({
      message: 'Error: boom\n    at x (src/y.js:5:1)',
      timestamp: 't1',
      sourceLocation: { file: 'src/y.js', line: 5 },
    });
    assert.strictEqual(item.source, 'datadog');
    assert.strictEqual(item.message, 'Error: boom');
    assert.deepStrictEqual(item.sourceLocation, { file: 'src/y.js', line: 5 });
    assert.strictEqual(item.count, 1);
  });
});

describe('fetchProductionErrors', () => {
  const originalFetch = global.fetch;

  afterEach(() => { global.fetch = originalFetch; });

  it('merges vendors sorted by count desc and reports sources ok', async () => {
    global.fetch = async () => jsonResponse(200, DATADOG_EVENTS); // datadog path
    const fetchImpl = async () => jsonResponse(200, SENTRY_ISSUES); // sentry path

    const res = await fetchProductionErrors({
      sentry: SENTRY_CFG,
      datadog: DATADOG_CFG,
      fetchImpl,
    });

    assert.strictEqual(res.sources.sentry, 'ok');
    assert.strictEqual(res.sources.datadog, 'ok');
    assert.strictEqual(res.sources.rollbar, 'skipped');
    assert.strictEqual(res.items.length, 3);
    // count desc: sentry 420 first, then sentry 3, datadog 1
    assert.strictEqual(res.items[0].count, 420);
    assert.strictEqual(res.items[0].source, 'sentry');
    assert.deepStrictEqual(res.items[0].sourceLocation, { file: 'src/api/checkout.ts', line: 44 });
    assert.strictEqual(res.items[2].source, 'datadog');
    assert.deepStrictEqual(res.items[2].sourceLocation, { file: 'src/worker/tick.js', line: 88 });
  });

  it('one vendor failing never sinks the other (isolation)', async () => {
    global.fetch = async () => jsonResponse(500, { error: 'datadog down' });
    const fetchImpl = async () => jsonResponse(200, SENTRY_ISSUES);

    const res = await fetchProductionErrors({
      sentry: SENTRY_CFG,
      datadog: DATADOG_CFG,
      fetchImpl,
    });

    assert.strictEqual(res.sources.sentry, 'ok');
    assert.match(res.sources.datadog, /^error: /);
    assert.strictEqual(res.items.length, 2);
    assert.ok(res.items.every((i) => i.source === 'sentry'));
  });

  it('respects the merged limit', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: String(i), title: `E${i}`, count: 100 - i, frames: [], metadata: {},
    }));
    const fetchImpl = async () => jsonResponse(200, many);
    const res = await fetchProductionErrors({ sentry: SENTRY_CFG, fetchImpl, limit: 5 });
    assert.strictEqual(res.items.length, 5);
    assert.strictEqual(res.items[0].count, 100);
  });

  it('no vendors configured → empty items, all skipped', async () => {
    const res = await fetchProductionErrors({});
    assert.deepStrictEqual(res.items, []);
    assert.deepStrictEqual(res.sources, { sentry: 'skipped', datadog: 'skipped', rollbar: 'skipped' });
  });

  it('explicit rollbar config is reported honestly while the client is absent-or-present', async () => {
    const res = await fetchProductionErrors({ rollbar: { accessToken: 'rb' } });
    // Either the client isn't built yet (not installed) or it is and the
    // fake token fails — both must surface as error:, never silently ok.
    assert.match(res.sources.rollbar, /^error: /);
  });
});

describe('resolveSourcesFromEnv', () => {
  it('resolves sentry only when all three vars present', () => {
    assert.deepStrictEqual(resolveSourcesFromEnv({}), {});
    assert.deepStrictEqual(resolveSourcesFromEnv({ SENTRY_AUTH_TOKEN: 't', SENTRY_ORG: 'o' }), {});
    const full = resolveSourcesFromEnv({ SENTRY_AUTH_TOKEN: 't', SENTRY_ORG: 'o', SENTRY_PROJECT: 'p' });
    assert.deepStrictEqual(full.sentry, { accessToken: 't', orgId: 'o', projectSlug: 'p' });
  });

  it('resolves datadog pair + optional site/service', () => {
    const env = { DATADOG_API_KEY: 'k', DATADOG_APP_KEY: 'a', DD_SITE: 'datadoghq.eu', DD_SERVICE: 'web' };
    const r = resolveSourcesFromEnv(env);
    assert.deepStrictEqual(r.datadog, { apiKey: 'k', appKey: 'a', site: 'datadoghq.eu', service: 'web' });
  });

  it('resolves rollbar read token', () => {
    const r = resolveSourcesFromEnv({ ROLLBAR_READ_TOKEN: 'rb' });
    assert.deepStrictEqual(r.rollbar, { accessToken: 'rb' });
  });
});
