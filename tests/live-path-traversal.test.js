const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const LivePathTraversalModule = require('../src/modules/live-path-traversal');
const { detectTraversalLeak } = LivePathTraversalModule;
const { ARMED_ENV } = require('../src/core/authorization-gate');

const VALID_TOKEN = 'a'.repeat(64);
const makeResult = () => ({ checks: [], addCheck(n, p, d = {}) { this.checks.push({ name: n, passed: p, ...d }); } });
const makeFakeRunner = (responses) => {
  let i = 0;
  return {
    probe: async () => responses[i++] || responses[responses.length - 1] || { ok: true, body: '', timeMs: 5 },
    summary: () => ({ totalRequests: i, aborted: false, abortReason: null, durationMs: 100, hostsTouched: [] }),
  };
};

describe('livePathTraversal — leak detection', () => {
  it('detects passwd marker', () => {
    assert.strictEqual(detectTraversalLeak('root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:', 'passwd-marker'), true);
  });

  it('detects win.ini marker', () => {
    assert.strictEqual(detectTraversalLeak('[boot loader]\ntimeout=30', 'win-ini-marker'), true);
  });

  it('rejects benign content', () => {
    assert.strictEqual(detectTraversalLeak('<html>not found</html>', 'passwd-marker'), false);
  });

  it('returns false on unknown marker', () => {
    assert.strictEqual(detectTraversalLeak('content', 'nonexistent-marker'), false);
  });
});

describe('livePathTraversal — module', () => {
  it('has correct shape', () => {
    const m = new LivePathTraversalModule();
    assert.strictEqual(m.name, 'livePathTraversal');
  });

  it('noop with no targets', async () => {
    const m = new LivePathTraversalModule();
    const r = makeResult();
    await m.run(r, {});
    assert.ok(r.checks.find((c) => c.name === 'live-path-traversal:noop'));
  });

  it('refuses when not armed', async () => {
    delete process.env[ARMED_ENV];
    const m = new LivePathTraversalModule();
    const r = makeResult();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-lpt-'));
    try {
      await m.run(r, {
        livePathTraversal: {
          baseUrl: 'https://example.com',
          targets: [{ url: 'https://example.com/dl', method: 'GET', paramName: 'file', paramLocation: 'query' }],
          consent: { url: 'https://example.com', acknowledgedAt: new Date().toISOString(), customerToken: VALID_TOKEN },
          auditDir: tmpDir,
        },
      });
      assert.ok(r.checks.find((c) => c.name === 'live-path-traversal:refused'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('livePathTraversal — happy path', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-lpt-')); process.env[ARMED_ENV] = '1'; });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); delete process.env[ARMED_ENV]; });

  it('flags endpoint that reflects /etc/passwd', async () => {
    const m = new LivePathTraversalModule();
    const r = makeResult();
    const runner = makeFakeRunner([
      { ok: true, body: 'root:x:0:0:root:/root:/bin/bash', timeMs: 12 },
    ]);
    await m.run(r, {
      livePathTraversal: {
        baseUrl: 'https://example.com',
        targets: [{ url: 'https://example.com/download', method: 'GET', paramName: 'file', paramLocation: 'query' }],
        consent: { url: 'https://example.com', acknowledgedAt: new Date().toISOString(), customerToken: VALID_TOKEN },
        dnsResolver: async () => [VALID_TOKEN],
        auditDir: tmpDir,
        runner,
      },
    });
    const findings = r.checks.filter((c) => c.rule === 'live-path-traversal');
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].severity, 'error');
  });

  it('does NOT flag a clean endpoint', async () => {
    const m = new LivePathTraversalModule();
    const r = makeResult();
    const runner = makeFakeRunner(Array(15).fill({ ok: true, body: '404 not found', timeMs: 8 }));
    await m.run(r, {
      livePathTraversal: {
        baseUrl: 'https://example.com',
        targets: [{ url: 'https://example.com/download', method: 'GET', paramName: 'file', paramLocation: 'query' }],
        consent: { url: 'https://example.com', acknowledgedAt: new Date().toISOString(), customerToken: VALID_TOKEN },
        dnsResolver: async () => [VALID_TOKEN],
        auditDir: tmpDir,
        runner,
      },
    });
    assert.strictEqual(r.checks.filter((c) => c.rule === 'live-path-traversal').length, 0);
  });
});
