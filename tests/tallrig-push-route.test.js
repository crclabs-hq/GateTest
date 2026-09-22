// ============================================================================
// TALLRIG-PUSH-ROUTE TEST — Coverage for POST /api/integrations/tallrig/events
// ============================================================================
// Verifies website/app/lib/tallrig-push-events.js (the pure handler the thin
// route at website/app/api/integrations/tallrig/events/route.ts delegates
// to — same shape as processMarketplaceWebhookEvent in marketplace-webhook.js,
// which tests/marketplace-webhook.test.js covers the same way; a .ts route
// file cannot be loaded from node:test, so the logic lives in a plain module
// instead) together with website/app/lib/tallrig-push-event-store.js (the
// persistence layer — a capped JSON-lines file, exercised here through an
// in-memory fake fs so no test touches disk).
//
// Covered:
//   - TALLRIG_PUSH_SECRET unset -> 503, nothing stored
//   - bad signature -> 401, nothing stored
//   - a mismatched X-Tallrig-Key-Id (when TALLRIG_PUSH_KEY_ID is set) -> 401
//   - a valid event -> 200 and exactly one stored record
//   - the same event delivered twice -> stores once (idempotent)
// ============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const path = require('path');

const { processTallrigPushEvent } = require(path.resolve(
  __dirname, '..', 'website', 'app', 'lib', 'tallrig-push-events.js',
));
const eventStore = require(path.resolve(
  __dirname, '..', 'website', 'app', 'lib', 'tallrig-push-event-store.js',
));

const SECRET = 'test-tallrig-push-secret-0123456789abcdef';

function sign(timestamp, rawBody, secret = SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/** In-memory fake fs — same shape as hn-reply-assistant/queue-store's tests:
 * a Map keyed by path standing in for the filesystem, so the store's real
 * fs calls (existsSync/mkdirSync/readFileSync/writeFileSync) work unmodified
 * against it without ever touching disk. */
function makeFakeFs() {
  const files = new Map();
  const dirs = new Set();
  return {
    files,
    existsSync: (p) => files.has(p) || dirs.has(p),
    mkdirSync: (p) => { dirs.add(p); },
    readFileSync: (p) => {
      if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(p);
    },
    writeFileSync: (p, data) => { files.set(p, data); },
  };
}

function deployFinishedPayload(overrides = {}) {
  return {
    id: 'evt_1',
    type: 'deploy.finished',
    sha: 'a'.repeat(40),
    shaSource: 'git',
    ...overrides,
  };
}

function baseArgs({ payload, rawBody, keyIdHeader, signatureHeader, timestampHeader, env, store, now } = {}) {
  const body = rawBody !== undefined ? rawBody : JSON.stringify(payload || deployFinishedPayload());
  const ts = timestampHeader !== undefined ? timestampHeader : String(nowSeconds());
  return {
    rawBody: body,
    keyIdHeader: keyIdHeader !== undefined ? keyIdHeader : 'key_abc',
    timestampHeader: ts,
    signatureHeader: signatureHeader !== undefined ? signatureHeader : sign(ts, body),
    env: env !== undefined ? env : { TALLRIG_PUSH_SECRET: SECRET },
    now,
    store: store || eventStore,
  };
}

describe('processTallrigPushEvent — fails closed', () => {
  it('TALLRIG_PUSH_SECRET unset -> 503, nothing stored', async () => {
    const _fs = makeFakeFs();
    const dataDir = 'C:/fake/data';
    const store = {
      appendEvent: (opts) => eventStore.appendEvent({ ...opts, dataDir, _fs }),
    };
    const result = await processTallrigPushEvent(baseArgs({ env: {}, store }));
    assert.strictEqual(result.status, 503);
    assert.strictEqual(_fs.files.size, 0, 'nothing written when unconfigured');
  });

  it('bad signature -> 401, nothing stored', async () => {
    const _fs = makeFakeFs();
    const dataDir = 'C:/fake/data';
    const store = {
      appendEvent: (opts) => eventStore.appendEvent({ ...opts, dataDir, _fs }),
    };
    const result = await processTallrigPushEvent(baseArgs({ signatureHeader: 'sha256=' + '0'.repeat(64), store }));
    assert.strictEqual(result.status, 401);
    assert.strictEqual(_fs.files.size, 0);
  });

  it('mismatched X-Tallrig-Key-Id (TALLRIG_PUSH_KEY_ID set) -> 401, nothing stored', async () => {
    const _fs = makeFakeFs();
    const dataDir = 'C:/fake/data';
    const store = {
      appendEvent: (opts) => eventStore.appendEvent({ ...opts, dataDir, _fs }),
    };
    const result = await processTallrigPushEvent(baseArgs({
      keyIdHeader: 'wrong_key',
      env: { TALLRIG_PUSH_SECRET: SECRET, TALLRIG_PUSH_KEY_ID: 'key_abc' },
      store,
    }));
    assert.strictEqual(result.status, 401);
    assert.strictEqual(_fs.files.size, 0);
  });

  it('matching X-Tallrig-Key-Id (TALLRIG_PUSH_KEY_ID set) -> 200', async () => {
    const _fs = makeFakeFs();
    const dataDir = 'C:/fake/data';
    const store = {
      appendEvent: (opts) => eventStore.appendEvent({ ...opts, dataDir, _fs }),
    };
    const result = await processTallrigPushEvent(baseArgs({
      keyIdHeader: 'key_abc',
      env: { TALLRIG_PUSH_SECRET: SECRET, TALLRIG_PUSH_KEY_ID: 'key_abc' },
      store,
    }));
    assert.strictEqual(result.status, 200);
  });
});

describe('processTallrigPushEvent — valid event storage', () => {
  it('a valid event -> 200 and exactly one stored record', async () => {
    const _fs = makeFakeFs();
    const dataDir = 'C:/fake/data';
    const store = {
      appendEvent: (opts) => eventStore.appendEvent({ ...opts, dataDir, _fs }),
    };
    const result = await processTallrigPushEvent(baseArgs({ store }));
    assert.strictEqual(result.status, 200);
    assert.deepStrictEqual(result.body, { ok: true, stored: true });

    const recorded = eventStore.listRecent(50, { dataDir, _fs });
    assert.strictEqual(recorded.length, 1);
    assert.strictEqual(recorded[0].type, 'deploy.finished');
    assert.strictEqual(recorded[0].sha, 'a'.repeat(40));
    assert.strictEqual(recorded[0].shaSource, 'git');
    assert.strictEqual(recorded[0].keyId, 'key_abc');
  });

  it('the same event delivered twice stores once (idempotent on event id)', async () => {
    const _fs = makeFakeFs();
    const dataDir = 'C:/fake/data';
    const store = {
      appendEvent: (opts) => eventStore.appendEvent({ ...opts, dataDir, _fs }),
    };
    const payload = deployFinishedPayload();
    const rawBody = JSON.stringify(payload);

    const first = await processTallrigPushEvent(baseArgs({ rawBody, store }));
    // A retry re-signs the identical body with a fresh timestamp, exactly as
    // Tallrig's three-retries-then-dead-letter policy would.
    const second = await processTallrigPushEvent(baseArgs({ rawBody, store }));

    assert.strictEqual(first.status, 200);
    assert.deepStrictEqual(first.body, { ok: true, stored: true });
    assert.strictEqual(second.status, 200);
    assert.deepStrictEqual(second.body, { ok: true, stored: false });

    const recorded = eventStore.listRecent(50, { dataDir, _fs });
    assert.strictEqual(recorded.length, 1, 'exactly one stored record for two deliveries');
  });
});

describe('processTallrigPushEvent — malformed body', () => {
  it('invalid JSON -> 400', async () => {
    const _fs = makeFakeFs();
    const dataDir = 'C:/fake/data';
    const store = {
      appendEvent: (opts) => eventStore.appendEvent({ ...opts, dataDir, _fs }),
    };
    const rawBody = '{not json';
    const result = await processTallrigPushEvent(baseArgs({ rawBody, store }));
    assert.strictEqual(result.status, 400);
    assert.strictEqual(_fs.files.size, 0);
  });
});

describe('tallrig-push-event-store — 500-event cap', () => {
  it('caps stored events at MAX_EVENTS, dropping the oldest first', () => {
    const _fs = makeFakeFs();
    const dataDir = 'C:/fake/data';
    const total = eventStore.MAX_EVENTS + 10;
    for (let i = 0; i < total; i += 1) {
      eventStore.appendEvent({
        rawBody: JSON.stringify({ id: `evt_${i}`, type: 'deploy.started' }),
        payload: { id: `evt_${i}`, type: 'deploy.started' },
        keyId: null,
        dataDir,
        _fs,
      });
    }
    const all = eventStore.listRecent(eventStore.MAX_EVENTS + 100, { dataDir, _fs });
    assert.strictEqual(all.length, eventStore.MAX_EVENTS);
    // Newest-first; the oldest 10 (evt_0..evt_9) must have been dropped.
    assert.ok(!all.some((e) => e.dedupeKey === 'id:evt_0'), 'the oldest event must have been dropped');
    assert.ok(all.some((e) => e.dedupeKey === `id:evt_${total - 1}`), 'the newest event must be present');
  });
});

describe('tallrig-push-event-store — lastTallrigDeploy', () => {
  it('returns the most recent deploy.finished sha, or null if none', () => {
    const _fs = makeFakeFs();
    const dataDir = 'C:/fake/data';
    assert.strictEqual(eventStore.lastTallrigDeploy({ dataDir, _fs }), null);

    eventStore.appendEvent({
      rawBody: JSON.stringify({ id: 'evt_a', type: 'deploy.started' }),
      payload: { id: 'evt_a', type: 'deploy.started' },
      keyId: null,
      dataDir,
      _fs,
    });
    assert.strictEqual(eventStore.lastTallrigDeploy({ dataDir, _fs }), null, 'deploy.started alone is not a finished deploy');

    eventStore.appendEvent({
      rawBody: JSON.stringify({ id: 'evt_b', type: 'deploy.finished', sha: 'b'.repeat(40), shaSource: 'git' }),
      payload: { id: 'evt_b', type: 'deploy.finished', sha: 'b'.repeat(40), shaSource: 'git' },
      keyId: null,
      dataDir,
      _fs,
    });
    const last = eventStore.lastTallrigDeploy({ dataDir, _fs });
    assert.strictEqual(last.sha, 'b'.repeat(40));
    assert.strictEqual(last.shaSource, 'git');
    assert.ok(typeof last.at === 'string');
  });
});
