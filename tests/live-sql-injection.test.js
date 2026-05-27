const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const LiveSqlInjectionModule = require('../src/modules/live-sql-injection');
const { bodyHasDbError, DB_ERROR_PATTERNS } = LiveSqlInjectionModule;
const { ARMED_ENV } = require('../src/core/authorization-gate');

const VALID_TOKEN = 'a'.repeat(64);

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) {
      this.checks.push({ name, passed, ...details });
    },
  };
}

function makeFakeRunner(responses) {
  let i = 0;
  return {
    probe: async ({ url, method }) => {
      const r = responses[i++] || responses[responses.length - 1] || { ok: true, body: '', timeMs: 5 };
      return { url, method, ...r };
    },
    summary: () => ({ totalRequests: i, aborted: false, abortReason: null, durationMs: 100, hostsTouched: [] }),
  };
}

describe('liveSqlInjection — DB error pattern detection', () => {
  it('detects MySQL syntax error', () => {
    assert.ok(bodyHasDbError('SQL syntax; check the manual that corresponds to your MySQL'));
  });

  it('detects ORA-NNNNN', () => {
    assert.ok(bodyHasDbError('ORA-00942: table or view does not exist'));
  });

  it('detects SQLSTATE marker', () => {
    assert.ok(bodyHasDbError('SQLSTATE[42000]: Syntax error'));
  });

  it('detects MSSQL conversion failure', () => {
    assert.ok(bodyHasDbError('Conversion failed when converting the varchar value'));
  });

  it('detects Postgres syntax-near', () => {
    assert.ok(bodyHasDbError('ERROR: syntax error at or near ";"'));
  });

  it('returns null on benign content', () => {
    assert.strictEqual(bodyHasDbError('<html><body>Hello</body></html>'), null);
  });

  it('returns null on non-string', () => {
    assert.strictEqual(bodyHasDbError(null), null);
    assert.strictEqual(bodyHasDbError(undefined), null);
  });

  it('exports a non-empty pattern list', () => {
    assert.ok(DB_ERROR_PATTERNS.length >= 8);
  });
});

describe('liveSqlInjection — module shape', () => {
  it('has correct name + description', () => {
    const m = new LiveSqlInjectionModule();
    assert.strictEqual(m.name, 'liveSqlInjection');
    assert.match(m.description, /SQL/i);
  });

  it('noop when no targets configured', async () => {
    const m = new LiveSqlInjectionModule();
    const r = makeResult();
    await m.run(r, {});
    assert.ok(r.checks.find((c) => c.name === 'live-sql-injection:noop'));
  });
});

describe('liveSqlInjection — authorization gate', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-lsi-'));
    delete process.env[ARMED_ENV];
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env[ARMED_ENV];
  });

  it('refuses when process is not armed', async () => {
    const m = new LiveSqlInjectionModule();
    const r = makeResult();
    await m.run(r, {
      liveSqlInjection: {
        baseUrl: 'https://example.com',
        targets: [{ url: 'https://example.com/api', method: 'GET', paramName: 'id', paramLocation: 'query' }],
        consent: {
          url: 'https://example.com',
          acknowledgedAt: new Date().toISOString(),
          customerToken: VALID_TOKEN,
        },
        auditDir: tmpDir,
      },
    });
    const refusal = r.checks.find((c) => c.name === 'live-sql-injection:refused');
    assert.ok(refusal, 'should emit refused check');
    assert.strictEqual(refusal.reason, 'process-not-armed');
  });

  it('refuses when consent is missing', async () => {
    process.env[ARMED_ENV] = '1';
    const m = new LiveSqlInjectionModule();
    const r = makeResult();
    await m.run(r, {
      liveSqlInjection: {
        baseUrl: 'https://example.com',
        targets: [{ url: 'https://example.com/api', method: 'GET', paramName: 'id', paramLocation: 'query' }],
        auditDir: tmpDir,
      },
    });
    const refusal = r.checks.find((c) => c.name === 'live-sql-injection:refused');
    assert.ok(refusal);
    assert.strictEqual(refusal.reason, 'no-consent');
  });
});

describe('liveSqlInjection — detection happy path (gate bypassed via injected runner)', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-lsi-'));
    process.env[ARMED_ENV] = '1';
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env[ARMED_ENV];
  });

  it('flags an endpoint whose response leaks a SQL error', async () => {
    const m = new LiveSqlInjectionModule();
    const r = makeResult();
    // First response = baseline (benign), then DB-error reflected
    const runner = makeFakeRunner([
      { ok: true, body: '<html>OK</html>', timeMs: 10 },
      { ok: true, body: 'You have an error in your SQL syntax', timeMs: 12 },
    ]);
    await m.run(r, {
      liveSqlInjection: {
        baseUrl: 'https://example.com',
        targets: [{ url: 'https://example.com/api', method: 'GET', paramName: 'id', paramLocation: 'query' }],
        consent: {
          url: 'https://example.com',
          acknowledgedAt: new Date().toISOString(),
          customerToken: VALID_TOKEN,
        },
        dnsResolver: async () => [VALID_TOKEN],
        auditDir: tmpDir,
        runner,
      },
    });
    const findings = r.checks.filter((c) => c.rule === 'live-sql-injection');
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].severity, 'error');
    assert.match(findings[0].message, /Possible SQL injection/);
  });

  it('flags timing-based injection when response stretches by expected amount', async () => {
    const m = new LiveSqlInjectionModule();
    const r = makeResult();
    // Baseline fast, then a stream of fast responses, finally a timing payload
    // with a long delay. Need enough responses to consume the error-class
    // payloads first (they all return benign body / fast).
    const responses = [{ ok: true, body: '<html>OK</html>', timeMs: 20 }]; // baseline
    // 16 fast responses for non-timing payloads
    for (let i = 0; i < 16; i++) responses.push({ ok: true, body: '<html>OK</html>', timeMs: 22 });
    // Timing payload — 3000ms delay
    responses.push({ ok: true, body: '<html>OK</html>', timeMs: 3050 });
    const runner = makeFakeRunner(responses);
    await m.run(r, {
      liveSqlInjection: {
        baseUrl: 'https://example.com',
        targets: [{ url: 'https://example.com/api', method: 'GET', paramName: 'id', paramLocation: 'query' }],
        consent: {
          url: 'https://example.com',
          acknowledgedAt: new Date().toISOString(),
          customerToken: VALID_TOKEN,
        },
        dnsResolver: async () => [VALID_TOKEN],
        auditDir: tmpDir,
        runner,
      },
    });
    const findings = r.checks.filter((c) => c.rule === 'live-sql-injection');
    assert.ok(findings.length >= 1, `expected timing finding, got: ${JSON.stringify(r.checks)}`);
    const timingFinding = findings.find((f) => f.payloadClass === 'timing');
    assert.ok(timingFinding);
  });

  it('does NOT flag a clean endpoint', async () => {
    const m = new LiveSqlInjectionModule();
    const r = makeResult();
    // Every response benign
    const responses = Array(25).fill({ ok: true, body: '<html>{"users":[]}</html>', timeMs: 20 });
    const runner = makeFakeRunner(responses);
    await m.run(r, {
      liveSqlInjection: {
        baseUrl: 'https://example.com',
        targets: [{ url: 'https://example.com/api', method: 'GET', paramName: 'id', paramLocation: 'query' }],
        consent: {
          url: 'https://example.com',
          acknowledgedAt: new Date().toISOString(),
          customerToken: VALID_TOKEN,
        },
        dnsResolver: async () => [VALID_TOKEN],
        auditDir: tmpDir,
        runner,
      },
    });
    const findings = r.checks.filter((c) => c.rule === 'live-sql-injection');
    assert.strictEqual(findings.length, 0);
    const summary = r.checks.find((c) => c.name === 'live-sql-injection:summary');
    assert.ok(summary);
  });
});
