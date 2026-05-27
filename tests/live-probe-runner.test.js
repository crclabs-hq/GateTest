const { describe, it } = require('node:test');
const assert = require('node:assert');

const { LiveProbeRunner, isForbiddenPayload, FORBIDDEN_PATTERNS } = require('../src/core/live-probe-runner');

describe('live-probe-runner — forbidden payloads', () => {
  it('blocks DROP TABLE', () => {
    assert.strictEqual(isForbiddenPayload('1; DROP TABLE users--'), true);
  });

  it('blocks TRUNCATE', () => {
    assert.strictEqual(isForbiddenPayload("'; TRUNCATE TABLE accounts --"), true);
  });

  it('blocks DELETE FROM x;', () => {
    assert.strictEqual(isForbiddenPayload("'; DELETE FROM orders;"), true);
  });

  it('blocks rm -rf /', () => {
    assert.strictEqual(isForbiddenPayload('; rm -rf /tmp'), true);
  });

  it('blocks fork bomb', () => {
    assert.strictEqual(isForbiddenPayload(':(){:|:&};:'), true);
  });

  it('blocks SELECT INTO OUTFILE', () => {
    assert.strictEqual(isForbiddenPayload("' UNION SELECT * FROM users INTO OUTFILE '/tmp/x'"), true);
  });

  it('blocks long sleeps', () => {
    assert.strictEqual(isForbiddenPayload("' AND sleep(60)--"), true);
  });

  it('blocks WAITFOR DELAY', () => {
    assert.strictEqual(isForbiddenPayload("'; WAITFOR DELAY '0:0:10'--"), true);
  });

  it('allows benign error-trigger', () => {
    assert.strictEqual(isForbiddenPayload("'"), false);
  });

  it('allows boolean probe', () => {
    assert.strictEqual(isForbiddenPayload("' OR '1'='1"), false);
  });

  it('allows short sleep (3s)', () => {
    assert.strictEqual(isForbiddenPayload("' AND sleep(3)--"), false);
  });

  it('returns false for non-string', () => {
    assert.strictEqual(isForbiddenPayload(null), false);
    assert.strictEqual(isForbiddenPayload(123), false);
  });

  it('FORBIDDEN_PATTERNS is a non-empty array', () => {
    assert.ok(Array.isArray(FORBIDDEN_PATTERNS));
    assert.ok(FORBIDDEN_PATTERNS.length >= 5);
  });
});

describe('live-probe-runner — blocked hosts', () => {
  it('blocks localhost', async () => {
    const r = new LiveProbeRunner();
    const result = await r.probe({ url: 'http://localhost:3000/foo' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.blocked, true);
    assert.match(result.reason, /blocked-host: localhost/);
  });

  it('blocks 127.0.0.1', async () => {
    const r = new LiveProbeRunner();
    const result = await r.probe({ url: 'http://127.0.0.1/x' });
    assert.strictEqual(result.blocked, true);
  });

  it('blocks 10.0.0.x', async () => {
    const r = new LiveProbeRunner();
    const result = await r.probe({ url: 'http://10.0.0.5/x' });
    assert.strictEqual(result.blocked, true);
  });

  it('blocks 192.168.x.x', async () => {
    const r = new LiveProbeRunner();
    const result = await r.probe({ url: 'http://192.168.1.1/x' });
    assert.strictEqual(result.blocked, true);
  });

  it('blocks 172.16.x.x', async () => {
    const r = new LiveProbeRunner();
    const result = await r.probe({ url: 'http://172.20.0.1/x' });
    assert.strictEqual(result.blocked, true);
  });

  it('blocks AWS metadata 169.254.169.254', async () => {
    const r = new LiveProbeRunner();
    const result = await r.probe({ url: 'http://169.254.169.254/latest/meta-data/' });
    assert.strictEqual(result.blocked, true);
  });

  it('blocks GCP metadata', async () => {
    const r = new LiveProbeRunner();
    const result = await r.probe({ url: 'http://metadata.google.internal/x' });
    assert.strictEqual(result.blocked, true);
  });
});

describe('live-probe-runner — refuses forbidden payloads', () => {
  it('throws when payload contains DROP TABLE', async () => {
    const r = new LiveProbeRunner();
    await assert.rejects(
      r.probe({ url: 'https://example.com/api', payload: "1; DROP TABLE x--" }),
      /Forbidden payload/,
    );
  });

  it('throws when body contains a destructive pattern', async () => {
    const r = new LiveProbeRunner();
    await assert.rejects(
      r.probe({ url: 'https://example.com/api', method: 'POST', body: "TRUNCATE TABLE u" }),
      /Forbidden body/,
    );
  });
});

describe('live-probe-runner — budgets + summary', () => {
  it('summary reports counters', () => {
    const r = new LiveProbeRunner();
    const s = r.summary();
    assert.strictEqual(s.totalRequests, 0);
    assert.strictEqual(s.aborted, false);
    assert.ok(Array.isArray(s.hostsTouched));
  });

  it('aborts after maxRequestsPerScan', async () => {
    // Force the wallclock check by setting an extremely low max.
    const r = new LiveProbeRunner({ maxRequestsPerScan: 0 });
    const result = await r.probe({ url: 'https://example.com/x' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.aborted, true);
  });

  it('aborts when wallclock exhausted', async () => {
    const r = new LiveProbeRunner({ maxWallclockMs: 0 });
    const result = await r.probe({ url: 'https://example.com/x' });
    assert.strictEqual(result.aborted, true);
  });
});

describe('live-probe-runner — URL validation', () => {
  it('throws on malformed URL', async () => {
    const r = new LiveProbeRunner();
    await assert.rejects(
      r.probe({ url: 'not-a-url' }),
      /Malformed URL/,
    );
  });
});
