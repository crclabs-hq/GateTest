const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const LiveAuthBypassModule = require('../src/modules/live-auth-bypass');
const { isAuthBlocked, isAuthGranted } = LiveAuthBypassModule;
const { ARMED_ENV } = require('../src/core/authorization-gate');

const VALID_TOKEN = 'a'.repeat(64);
const makeResult = () => ({ checks: [], addCheck(n, p, d = {}) { this.checks.push({ name: n, passed: p, ...d }); } });
const makeFakeRunner = (responses) => {
  let i = 0;
  return {
    probe: async () => responses[i++] || responses[responses.length - 1] || { ok: true, status: 200, timeMs: 5 },
    summary: () => ({ totalRequests: i, aborted: false, abortReason: null, durationMs: 100, hostsTouched: [] }),
  };
};

describe('liveAuthBypass — status helpers', () => {
  it('isAuthBlocked detects 401 and 403', () => {
    assert.strictEqual(isAuthBlocked(401), true);
    assert.strictEqual(isAuthBlocked(403), true);
    assert.strictEqual(isAuthBlocked(200), false);
    assert.strictEqual(isAuthBlocked(500), false);
  });

  it('isAuthGranted matches 2xx', () => {
    assert.strictEqual(isAuthGranted(200), true);
    assert.strictEqual(isAuthGranted(204), true);
    assert.strictEqual(isAuthGranted(299), true);
    assert.strictEqual(isAuthGranted(300), false);
    assert.strictEqual(isAuthGranted(401), false);
  });
});

describe('liveAuthBypass — module', () => {
  it('has correct shape', () => {
    const m = new LiveAuthBypassModule();
    assert.strictEqual(m.name, 'liveAuthBypass');
  });

  it('noop with no targets', async () => {
    const m = new LiveAuthBypassModule();
    const r = makeResult();
    await m.run(r, {});
    assert.ok(r.checks.find((c) => c.name === 'live-auth-bypass:noop'));
  });

  it('refuses when not armed', async () => {
    delete process.env[ARMED_ENV];
    const m = new LiveAuthBypassModule();
    const r = makeResult();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-lab-'));
    try {
      await m.run(r, {
        liveAuthBypass: {
          baseUrl: 'https://example.com',
          targets: [{ url: 'https://example.com/admin', method: 'GET' }],
          consent: { url: 'https://example.com', acknowledgedAt: new Date().toISOString(), customerToken: VALID_TOKEN },
          auditDir: tmpDir,
        },
      });
      assert.ok(r.checks.find((c) => c.name === 'live-auth-bypass:refused'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('liveAuthBypass — happy path', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-lab-')); process.env[ARMED_ENV] = '1'; });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); delete process.env[ARMED_ENV]; });

  it('flags endpoint where bypass header grants access', async () => {
    const m = new LiveAuthBypassModule();
    const r = makeResult();
    // Baseline 403, then 200 with first bypass header
    const runner = makeFakeRunner([
      { ok: true, status: 403, timeMs: 10 }, // baseline
      { ok: true, status: 200, timeMs: 11 }, // first bypass header succeeds
    ]);
    await m.run(r, {
      liveAuthBypass: {
        baseUrl: 'https://example.com',
        targets: [{ url: 'https://example.com/admin', method: 'GET' }],
        consent: { url: 'https://example.com', acknowledgedAt: new Date().toISOString(), customerToken: VALID_TOKEN },
        dnsResolver: async () => [VALID_TOKEN],
        auditDir: tmpDir,
        runner,
      },
    });
    const findings = r.checks.filter((c) => c.rule === 'live-auth-bypass');
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].severity, 'error');
  });

  it('does NOT flag when baseline is 200 (endpoint never required auth)', async () => {
    const m = new LiveAuthBypassModule();
    const r = makeResult();
    const runner = makeFakeRunner([{ ok: true, status: 200, timeMs: 10 }]);
    await m.run(r, {
      liveAuthBypass: {
        baseUrl: 'https://example.com',
        targets: [{ url: 'https://example.com/public', method: 'GET' }],
        consent: { url: 'https://example.com', acknowledgedAt: new Date().toISOString(), customerToken: VALID_TOKEN },
        dnsResolver: async () => [VALID_TOKEN],
        auditDir: tmpDir,
        runner,
      },
    });
    assert.strictEqual(r.checks.filter((c) => c.rule === 'live-auth-bypass').length, 0);
  });

  it('does NOT flag when bypass attempts still get blocked', async () => {
    const m = new LiveAuthBypassModule();
    const r = makeResult();
    const runner = makeFakeRunner(Array(20).fill({ ok: true, status: 403, timeMs: 10 }));
    await m.run(r, {
      liveAuthBypass: {
        baseUrl: 'https://example.com',
        targets: [{ url: 'https://example.com/admin', method: 'GET' }],
        consent: { url: 'https://example.com', acknowledgedAt: new Date().toISOString(), customerToken: VALID_TOKEN },
        dnsResolver: async () => [VALID_TOKEN],
        auditDir: tmpDir,
        runner,
      },
    });
    assert.strictEqual(r.checks.filter((c) => c.rule === 'live-auth-bypass').length, 0);
  });
});
