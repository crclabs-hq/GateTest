const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const LiveIdorModule = require('../src/modules/live-idor');
const { looksLikeRecord, isNumericId } = LiveIdorModule;
const { ARMED_ENV } = require('../src/core/authorization-gate');

const VALID_TOKEN = 'a'.repeat(64);
const makeResult = () => ({ checks: [], addCheck(n, p, d = {}) { this.checks.push({ name: n, passed: p, ...d }); } });
const makeFakeRunner = (responses) => {
  let i = 0;
  return {
    probe: async () => responses[i++] || responses[responses.length - 1] || { ok: true, status: 200, body: '', timeMs: 5 },
    summary: () => ({ totalRequests: i, aborted: false, abortReason: null, durationMs: 100, hostsTouched: [] }),
  };
};

describe('liveIdor — heuristics', () => {
  it('looksLikeRecord detects JSON object', () => {
    assert.strictEqual(looksLikeRecord('{"id": 1, "name": "A"}'), true);
  });

  it('looksLikeRecord detects JSON array', () => {
    assert.strictEqual(looksLikeRecord('[{"id":1}]'), true);
  });

  it('looksLikeRecord detects HTML page with headers', () => {
    const long = '<html>' + '<h1>User</h1>' + 'x'.repeat(300) + '</html>';
    assert.strictEqual(looksLikeRecord(long), true);
  });

  it('looksLikeRecord rejects empty body', () => {
    assert.strictEqual(looksLikeRecord(''), false);
    assert.strictEqual(looksLikeRecord(null), false);
  });

  it('looksLikeRecord rejects short HTML', () => {
    assert.strictEqual(looksLikeRecord('<html><h1>Not found</h1></html>'), false);
  });

  it('isNumericId accepts digits', () => {
    assert.strictEqual(isNumericId('123'), true);
    assert.strictEqual(isNumericId('0'), true);
  });

  it('isNumericId rejects non-numeric', () => {
    assert.strictEqual(isNumericId('abc'), false);
    assert.strictEqual(isNumericId('12abc'), false);
    assert.strictEqual(isNumericId(''), false);
    assert.strictEqual(isNumericId(null), false);
  });
});

describe('liveIdor — module', () => {
  it('has correct shape', () => {
    const m = new LiveIdorModule();
    assert.strictEqual(m.name, 'liveIdor');
  });

  it('noop with no targets', async () => {
    const m = new LiveIdorModule();
    const r = makeResult();
    await m.run(r, {});
    assert.ok(r.checks.find((c) => c.name === 'live-idor:noop'));
  });

  it('refuses when not armed', async () => {
    delete process.env[ARMED_ENV];
    const m = new LiveIdorModule();
    const r = makeResult();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-lid-'));
    try {
      await m.run(r, {
        liveIdor: {
          baseUrl: 'https://example.com',
          targets: [{ url: 'https://example.com/users?id=5', method: 'GET', paramName: 'id', paramLocation: 'query' }],
          consent: { url: 'https://example.com', acknowledgedAt: new Date().toISOString(), customerToken: VALID_TOKEN },
          auditDir: tmpDir,
        },
      });
      assert.ok(r.checks.find((c) => c.name === 'live-idor:refused'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('liveIdor — happy path', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-lid-')); process.env[ARMED_ENV] = '1'; });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); delete process.env[ARMED_ENV]; });

  it('flags when adjacent ID returns 200 + record', async () => {
    const m = new LiveIdorModule();
    const r = makeResult();
    // First probe (id=4) returns a JSON record
    const runner = makeFakeRunner([
      { ok: true, status: 200, body: '{"id":4,"name":"Bob"}', timeMs: 10 },
    ]);
    await m.run(r, {
      liveIdor: {
        baseUrl: 'https://example.com',
        targets: [{
          url: 'https://example.com/users?id=5',
          method: 'GET', paramName: 'id', paramLocation: 'query', paramValue: '5',
        }],
        consent: { url: 'https://example.com', acknowledgedAt: new Date().toISOString(), customerToken: VALID_TOKEN },
        dnsResolver: async () => [VALID_TOKEN],
        auditDir: tmpDir,
        runner,
      },
    });
    const findings = r.checks.filter((c) => c.rule === 'live-idor');
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].severity, 'error');
  });

  it('does NOT flag when adjacent ID returns 404', async () => {
    const m = new LiveIdorModule();
    const r = makeResult();
    const runner = makeFakeRunner(Array(10).fill({ ok: true, status: 404, body: 'Not found', timeMs: 10 }));
    await m.run(r, {
      liveIdor: {
        baseUrl: 'https://example.com',
        targets: [{
          url: 'https://example.com/users?id=5',
          method: 'GET', paramName: 'id', paramLocation: 'query', paramValue: '5',
        }],
        consent: { url: 'https://example.com', acknowledgedAt: new Date().toISOString(), customerToken: VALID_TOKEN },
        dnsResolver: async () => [VALID_TOKEN],
        auditDir: tmpDir,
        runner,
      },
    });
    assert.strictEqual(r.checks.filter((c) => c.rule === 'live-idor').length, 0);
  });
});
