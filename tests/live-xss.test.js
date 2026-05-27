const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const LiveXssModule = require('../src/modules/live-xss');
const { detectReflection, XSS_PROBE_MARKER } = LiveXssModule;
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

describe('liveXss — detection', () => {
  it('detects verbatim reflection', () => {
    const payload = `<script>${XSS_PROBE_MARKER}</script>`;
    assert.strictEqual(detectReflection(`<html>${payload}</html>`, payload), 'verbatim');
  });

  it('detects marker-only (partial reflection)', () => {
    const payload = `<script>${XSS_PROBE_MARKER}</script>`;
    const body = `<html>${XSS_PROBE_MARKER}</html>`;
    assert.strictEqual(detectReflection(body, payload), 'marker-only');
  });

  it('returns null when not reflected', () => {
    assert.strictEqual(detectReflection('<html>nope</html>', '<script>x</script>'), null);
  });

  it('returns null on non-string body', () => {
    assert.strictEqual(detectReflection(null, '<script>x</script>'), null);
  });
});

describe('liveXss — module shape', () => {
  it('has name and description', () => {
    const m = new LiveXssModule();
    assert.strictEqual(m.name, 'liveXss');
    assert.match(m.description, /XSS/i);
  });

  it('noop with no targets', async () => {
    const m = new LiveXssModule();
    const r = makeResult();
    await m.run(r, {});
    assert.ok(r.checks.find((c) => c.name === 'live-xss:noop'));
  });

  it('refuses when process not armed', async () => {
    delete process.env[ARMED_ENV];
    const m = new LiveXssModule();
    const r = makeResult();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-lxs-'));
    try {
      await m.run(r, {
        liveXss: {
          baseUrl: 'https://example.com',
          targets: [{ url: 'https://example.com/q', method: 'GET', paramName: 'q', paramLocation: 'query' }],
          consent: { url: 'https://example.com', acknowledgedAt: new Date().toISOString(), customerToken: VALID_TOKEN },
          auditDir: tmpDir,
        },
      });
      const refusal = r.checks.find((c) => c.name === 'live-xss:refused');
      assert.ok(refusal);
      assert.strictEqual(refusal.reason, 'process-not-armed');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('liveXss — happy path (gate bypassed via injected runner)', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-lxs-')); process.env[ARMED_ENV] = '1'; });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); delete process.env[ARMED_ENV]; });

  it('flags an endpoint that reflects the payload verbatim', async () => {
    const m = new LiveXssModule();
    const r = makeResult();
    // First probe reflects verbatim
    const runner = makeFakeRunner([
      { ok: true, body: `<html><script>${XSS_PROBE_MARKER}</script></html>`, timeMs: 10 },
    ]);
    await m.run(r, {
      liveXss: {
        baseUrl: 'https://example.com',
        targets: [{ url: 'https://example.com/search', method: 'GET', paramName: 'q', paramLocation: 'query' }],
        consent: { url: 'https://example.com', acknowledgedAt: new Date().toISOString(), customerToken: VALID_TOKEN },
        dnsResolver: async () => [VALID_TOKEN],
        auditDir: tmpDir,
        runner,
      },
    });
    const findings = r.checks.filter((c) => c.rule === 'live-xss');
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].severity, 'error');
  });

  it('does NOT flag a clean endpoint', async () => {
    const m = new LiveXssModule();
    const r = makeResult();
    const responses = Array(20).fill({ ok: true, body: '<html>safe</html>', timeMs: 10 });
    const runner = makeFakeRunner(responses);
    await m.run(r, {
      liveXss: {
        baseUrl: 'https://example.com',
        targets: [{ url: 'https://example.com/search', method: 'GET', paramName: 'q', paramLocation: 'query' }],
        consent: { url: 'https://example.com', acknowledgedAt: new Date().toISOString(), customerToken: VALID_TOKEN },
        dnsResolver: async () => [VALID_TOKEN],
        auditDir: tmpDir,
        runner,
      },
    });
    const findings = r.checks.filter((c) => c.rule === 'live-xss');
    assert.strictEqual(findings.length, 0);
  });
});
