// ============================================================================
// ROLLBAR CLIENT TEST — src/core/rollbar-client.js
// ============================================================================
// Fake fetchImpl sequences (items page + per-item instances). Asserts
// header auth, sort=occurrences query, last-in-app-frame extraction,
// no-trace fallback, per-item failure degradation, 401 error style, and
// correlator integration (rollbar event flips a matching finding LIVE).
// ============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  ROLLBAR_API_BASE,
  fetchTopErrors,
  extractSourceLocation,
} = require('../src/core/rollbar-client.js');

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function sequenceFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    if (queue.length === 0) throw new Error('fetch called more times than mocked');
    return queue.shift();
  };
  impl.calls = calls;
  return impl;
}

const ITEM = (id, occurrences, title) => ({
  id,
  title,
  total_occurrences: occurrences,
  last_occurrence_timestamp: 1751587200, // 2025-07-04T00:00:00Z
});

const INSTANCES = (frames) => jsonResponse(200, {
  result: { instances: [{ data: { body: { trace: { frames } } } }] },
});

describe('extractSourceLocation', () => {
  it('picks the LAST in-app frame (Rollbar lists outermost-first)', () => {
    const loc = extractSourceLocation({
      trace: {
        frames: [
          { filename: 'node_modules/express/lib/router.js', lineno: 10 },
          { filename: 'src/app.ts', lineno: 5 },
          { filename: 'src/api/checkout.ts', lineno: 44 },
        ],
      },
    });
    assert.deepStrictEqual(loc, { file: 'src/api/checkout.ts', line: 44 });
  });

  it('falls back to any frame when all are vendor frames', () => {
    const loc = extractSourceLocation({
      trace: { frames: [{ filename: 'node_modules/a/x.js', lineno: 3 }] },
    });
    assert.deepStrictEqual(loc, { file: 'node_modules/a/x.js', line: 3 });
  });

  it('uses trace_chain[0] when trace is absent', () => {
    const loc = extractSourceLocation({
      trace_chain: [{ frames: [{ filename: 'src/x.py', lineno: 9 }] }],
    });
    assert.deepStrictEqual(loc, { file: 'src/x.py', line: 9 });
  });

  it('returns null for no-trace bodies (message-only items)', () => {
    assert.strictEqual(extractSourceLocation({ message: { body: 'plain log' } }), null);
    assert.strictEqual(extractSourceLocation(null), null);
    assert.strictEqual(extractSourceLocation({ trace: { frames: [] } }), null);
  });
});

describe('fetchTopErrors', () => {
  it('requires accessToken', async () => {
    await assert.rejects(() => fetchTopErrors({}), /accessToken is required/);
  });

  it('sends the read token header and sorts by occurrences', async () => {
    const fetchImpl = sequenceFetch([
      jsonResponse(200, { result: { items: [ITEM(1, 100, 'Boom')] } }),
      INSTANCES([{ filename: 'src/a.ts', lineno: 7 }]),
    ]);
    await fetchTopErrors({ accessToken: 'rb_read', fetchImpl });
    const first = fetchImpl.calls[0];
    assert.match(first.url, /\/items\/\?status=active&environment=production&sort=occurrences/);
    assert.strictEqual(first.init.headers['X-Rollbar-Access-Token'], 'rb_read');
    assert.match(fetchImpl.calls[1].url, new RegExp(`${ROLLBAR_API_BASE.replace(/[/.]/g, '\\$&')}/item/1/instances/`));
  });

  it('normalises items with frames, counts, ISO lastSeen', async () => {
    const fetchImpl = sequenceFetch([
      jsonResponse(200, { result: { items: [ITEM(42, 777, 'TypeError: x is undefined')] } }),
      INSTANCES([
        { filename: 'node_modules/react-dom/index.js', lineno: 1 },
        { filename: 'src/components/Cart.tsx', lineno: 130 },
      ]),
    ]);
    const items = await fetchTopErrors({ accessToken: 't', fetchImpl });
    assert.strictEqual(items.length, 1);
    const item = items[0];
    assert.strictEqual(item.id, '42');
    assert.strictEqual(item.message, 'TypeError: x is undefined');
    assert.strictEqual(item.count, 777);
    assert.deepStrictEqual(item.sourceLocation, { file: 'src/components/Cart.tsx', line: 130 });
    assert.match(item.lastSeen, /^2025-07-04T00:00:00/);
  });

  it('no-trace item stays listed with honest null location', async () => {
    const fetchImpl = sequenceFetch([
      jsonResponse(200, { result: { items: [ITEM(7, 12, 'Plain log message')] } }),
      jsonResponse(200, { result: { instances: [{ data: { body: { message: { body: 'text' } } } }] } }),
    ]);
    const items = await fetchTopErrors({ accessToken: 't', fetchImpl });
    assert.strictEqual(items[0].sourceLocation, null);
    assert.strictEqual(items[0].file, null);
    assert.strictEqual(items[0].message, 'Plain log message');
  });

  it('a single item instances failure degrades that item, not the batch', async () => {
    const fetchImpl = sequenceFetch([
      jsonResponse(200, { result: { items: [ITEM(1, 50, 'A'), ITEM(2, 40, 'B')] } }),
      jsonResponse(500, { err: 1 }),                            // item 1 instances fail
      INSTANCES([{ filename: 'src/b.ts', lineno: 2 }]),          // item 2 ok
    ]);
    const items = await fetchTopErrors({ accessToken: 't', fetchImpl });
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].sourceLocation, null);
    assert.deepStrictEqual(items[1].sourceLocation, { file: 'src/b.ts', line: 2 });
  });

  it('caps instance fan-out at limit', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ITEM(i + 1, 100 - i, `E${i}`));
    const responses = [jsonResponse(200, { result: { items: many } })];
    for (let i = 0; i < 3; i++) responses.push(INSTANCES([{ filename: `src/f${i}.ts`, lineno: i + 1 }]));
    const fetchImpl = sequenceFetch(responses);
    const items = await fetchTopErrors({ accessToken: 't', fetchImpl, limit: 3 });
    assert.strictEqual(items.length, 3);
    assert.strictEqual(fetchImpl.calls.length, 4); // 1 items page + 3 instances, NOT 31
  });

  it('401 throws with truncated body (sentry-client error style)', async () => {
    const fetchImpl = sequenceFetch([jsonResponse(401, { message: 'invalid access token' })]);
    await assert.rejects(
      () => fetchTopErrors({ accessToken: 'bad', fetchImpl }),
      /Rollbar API error \(401\).*invalid access token/,
    );
  });
});

describe('correlator integration', () => {
  it('a rollbar event flips a nearby finding LIVE (±10 lines)', () => {
    const { correlateFindingsWithRuntime } = require('../website/app/lib/static-runtime-correlator.js');
    const rollbarEvent = {
      source: 'rollbar',
      message: 'TypeError in checkout',
      sourceLocation: { file: 'src/api/checkout.ts', line: 44 },
    };
    const res = correlateFindingsWithRuntime({
      findings: [
        { file: 'src/api/checkout.ts', line: 42, severity: 'error', detail: 'unhandled promise rejection' },
        { file: 'src/other.ts', line: 400, severity: 'error', detail: 'unrelated' },
      ],
      datadogErrors: [rollbarEvent], // correlator accepts any normalised runtime events here
    });
    assert.strictEqual(res.liveCount, 1);
    const live = res.findings.find((f) => f.live);
    assert.strictEqual(live.file, 'src/api/checkout.ts');
  });
});
