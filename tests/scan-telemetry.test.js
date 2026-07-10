'use strict';

// =============================================================================
// Scan telemetry — anonymized per-scan finding capture + opt-out + uploader.
// Craig 2026-07-11: every scan feeds the flywheel; NEVER code/paths/findings.
// =============================================================================

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scanTelemetry = require('../src/core/scan-telemetry');
const uploader = require('../src/core/telemetry-uploader');

// A runner-summary fixture in the real _buildSummary shape.
function makeSummary() {
  return {
    gateStatus: 'BLOCKED',
    duration: 1234,
    suite: 'full',
    checks: { errors: 3, warnings: 5 },
    results: [
      { module: 'secrets', status: 'failed', errors: 2, warnings: 0, softErrors: 0,
        // These PII-shaped fields must NOT survive into the record:
        checks: [{ message: 'hardcoded key at src/db.js:14', file: 'src/db.js', line: 14 }] },
      { module: 'accessibility', status: 'passed', errors: 0, warnings: 5, softErrors: 1, checks: [] },
      { module: 'deadCode', status: 'skipped', errors: 0, warnings: 0, softErrors: 0, checks: [] },
    ],
  };
}

function tmpFile() {
  return path.join(os.tmpdir(), `gt-scan-tel-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}

let savedEnv;
beforeEach(() => { savedEnv = process.env.GATETEST_NO_TELEMETRY; delete process.env.GATETEST_NO_TELEMETRY; });
afterEach(() => { if (savedEnv === undefined) delete process.env.GATETEST_NO_TELEMETRY; else process.env.GATETEST_NO_TELEMETRY = savedEnv; });

describe('scan-telemetry — _buildRecord shape + anonymization', () => {
  it('captures module names + counts and NOTHING else', () => {
    const rec = scanTelemetry._buildRecord(makeSummary(), { source: 'cli', suite: 'full' });
    assert.equal(rec.source, 'cli');
    assert.equal(rec.suite, 'full');
    assert.equal(rec.gateStatus, 'BLOCKED');
    assert.equal(rec.durationMs, 1234);
    assert.equal(rec.totalErrors, 3);
    assert.equal(rec.totalWarnings, 5);
    assert.equal(rec.modules.length, 3);
    const secrets = rec.modules.find((m) => m.name === 'secrets');
    assert.deepEqual(secrets, { name: 'secrets', errors: 2, warnings: 0, soft: 0, status: 'failed' });
  });

  it('never emits a file path, code, or finding message anywhere in the record', () => {
    const rec = scanTelemetry._buildRecord(makeSummary(), { source: 'cli' });
    const serialized = JSON.stringify(rec);
    assert.ok(!serialized.includes('src/db.js'), 'file path leaked');
    assert.ok(!serialized.includes('hardcoded key'), 'finding message leaked');
    assert.ok(!/\bfile\b|\bline\b|\bmessage\b|\bchecks\b/.test(serialized), `PII-shaped key leaked: ${serialized}`);
  });

  it('gateStatus normalizes to PASSED / BLOCKED only', () => {
    const passed = scanTelemetry._buildRecord({ gateStatus: 'PASSED', results: [] }, {});
    assert.equal(passed.gateStatus, 'PASSED');
    const weird = scanTelemetry._buildRecord({ gateStatus: 'WHATEVER', results: [] }, {});
    assert.equal(weird.gateStatus, 'BLOCKED');
  });
});

describe('scan-telemetry — recordScanFindings write + opt-out', () => {
  it('appends exactly one JSONL line per scan', () => {
    const fp = tmpFile();
    try {
      const r1 = scanTelemetry.recordScanFindings(makeSummary(), { source: 'cli', filePath: fp });
      const r2 = scanTelemetry.recordScanFindings(makeSummary(), { source: 'mcp', filePath: fp });
      assert.equal(r1.recorded, true);
      assert.equal(r2.recorded, true);
      const lines = fs.readFileSync(fp, 'utf-8').split('\n').filter(Boolean);
      assert.equal(lines.length, 2);
      assert.equal(JSON.parse(lines[0]).source, 'cli');
      assert.equal(JSON.parse(lines[1]).source, 'mcp');
    } finally { fs.rmSync(fp, { force: true }); }
  });

  it('GATETEST_NO_TELEMETRY=1 silences all writes', () => {
    const fp = tmpFile();
    process.env.GATETEST_NO_TELEMETRY = '1';
    try {
      const r = scanTelemetry.recordScanFindings(makeSummary(), { source: 'cli', filePath: fp });
      assert.equal(r.recorded, false);
      assert.equal(r.reason, 'opted-out');
      assert.ok(!fs.existsSync(fp), 'file should not be created when opted out');
    } finally { fs.rmSync(fp, { force: true }); }
  });

  it('.gatetest.json { telemetry:false } opts out', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-optout-'));
    fs.writeFileSync(path.join(dir, '.gatetest.json'), JSON.stringify({ telemetry: false }));
    try {
      assert.equal(scanTelemetry.telemetryEnabled(dir), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('telemetryEnabled defaults ON with no env and no config', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-defon-'));
    try {
      assert.equal(scanTelemetry.telemetryEnabled(dir), true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('telemetry-uploader — batch / drop / degrade', () => {
  function seed(fp, n) {
    const lines = [];
    for (let i = 0; i < n; i++) lines.push(JSON.stringify({ source: 'cli', n: i, modules: [] }));
    fs.writeFileSync(fp, lines.join('\n') + '\n', 'utf-8');
  }

  it('uploads a batch and drops uploaded lines on 2xx', async () => {
    const fp = tmpFile();
    seed(fp, 5);
    let posted = null;
    const _fetch = async (_url, opts) => { posted = JSON.parse(opts.body); return { status: 200 }; };
    try {
      const res = await uploader.flush({ filePath: fp, batchSize: 3, _fetch });
      assert.equal(res.uploaded, 3);
      assert.equal(res.remaining, 2);
      assert.equal(posted.records.length, 3);
      const left = fs.readFileSync(fp, 'utf-8').split('\n').filter(Boolean);
      assert.equal(left.length, 2);
    } finally { fs.rmSync(fp, { force: true }); }
  });

  it('keeps the buffer intact when the endpoint is unreachable', async () => {
    const fp = tmpFile();
    seed(fp, 4);
    const _fetch = async () => { throw new Error('ECONNREFUSED'); };
    try {
      const res = await uploader.flush({ filePath: fp, _fetch });
      assert.equal(res.uploaded, 0);
      assert.equal(res.remaining, 4);
      const left = fs.readFileSync(fp, 'utf-8').split('\n').filter(Boolean);
      assert.equal(left.length, 4, 'buffer must survive an unreachable endpoint');
    } finally { fs.rmSync(fp, { force: true }); }
  });

  it('keeps the buffer on a non-2xx (e.g. 503 persistence-unavailable)', async () => {
    const fp = tmpFile();
    seed(fp, 2);
    const _fetch = async () => ({ status: 503 });
    try {
      const res = await uploader.flush({ filePath: fp, _fetch });
      assert.equal(res.uploaded, 0);
      assert.equal(res.remaining, 2);
    } finally { fs.rmSync(fp, { force: true }); }
  });

  it('is a no-op when opted out', async () => {
    const fp = tmpFile();
    seed(fp, 3);
    process.env.GATETEST_NO_TELEMETRY = '1';
    let called = false;
    const _fetch = async () => { called = true; return { status: 200 }; };
    try {
      const res = await uploader.flush({ filePath: fp, _fetch });
      assert.equal(res.reason, 'opted-out');
      assert.equal(called, false);
    } finally { fs.rmSync(fp, { force: true }); }
  });

  it('empty buffer returns cleanly', async () => {
    const fp = tmpFile();
    try {
      const res = await uploader.flush({ filePath: fp, _fetch: async () => ({ status: 200 }) });
      assert.equal(res.uploaded, 0);
      assert.equal(res.reason, 'empty');
    } finally { fs.rmSync(fp, { force: true }); }
  });
});

// ---------------------------------------------------------------------------
// Central-store sanitizer — the defense-in-depth PII-rejection guard.
// ---------------------------------------------------------------------------
const { sanitizeRecord } = require('../website/app/lib/scan-telemetry-sanitize');

describe('scan-telemetry-sanitize — PII rejection', () => {
  const clean = {
    source: 'cli', suite: 'full', gateStatus: 'BLOCKED', durationMs: 100,
    totalErrors: 1, totalWarnings: 0,
    modules: [{ name: 'secrets', errors: 1, warnings: 0, soft: 0, status: 'failed' }],
  };

  it('accepts a clean anonymized record', () => {
    const r = sanitizeRecord(clean);
    assert.equal(r.ok, true);
    assert.equal(r.record.modules[0].name, 'secrets');
    assert.equal(r.record.moduleCount, 1);
  });

  it('REJECTS a record with a top-level path/content/message key', () => {
    for (const key of ['file', 'path', 'content', 'code', 'repo', 'repoUrl', 'url', 'message', 'line']) {
      const r = sanitizeRecord({ ...clean, [key]: 'anything' });
      assert.equal(r.ok, false, `should reject top-level ${key}`);
      assert.equal(r.reason, 'forbidden-key-present');
    }
  });

  it('REJECTS a record whose module entry carries a forbidden key', () => {
    const r = sanitizeRecord({
      ...clean,
      modules: [{ name: 'secrets', errors: 1, file: 'src/db.js', line: 14 }],
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'forbidden-key-in-module');
  });

  it('rejects non-objects and over-large module lists', () => {
    assert.equal(sanitizeRecord(null).ok, false);
    assert.equal(sanitizeRecord('x').ok, false);
    assert.equal(sanitizeRecord([]).ok, false);
    const many = { ...clean, modules: Array.from({ length: 201 }, (_, i) => ({ name: `m${i}` })) };
    assert.equal(sanitizeRecord(many).reason, 'too-many-modules');
  });

  it('coerces counts to non-negative integers and normalizes status', () => {
    const r = sanitizeRecord({
      ...clean,
      modules: [{ name: 'perf', errors: -5, warnings: 2.7, soft: 'x', status: 'weird' }],
    });
    assert.deepEqual(r.record.modules[0], { name: 'perf', errors: 0, warnings: 3, soft: 0, status: 'ok' });
  });
});

// ---------------------------------------------------------------------------
// Store + route structural wiring (DB path integration-tested at deploy).
// ---------------------------------------------------------------------------
describe('scan-telemetry store + route — wiring', () => {
  const STORE = path.join(__dirname, '..', 'website', 'app', 'lib', 'scan-telemetry-store.ts');
  const ROUTE = path.join(__dirname, '..', 'website', 'app', 'api', 'telemetry', 'scan', 'route.ts');

  it('store imports the shared sanitizer and exports recordScanBatch', () => {
    const src = fs.readFileSync(STORE, 'utf8');
    assert.match(src, /scan-telemetry-sanitize/);
    assert.match(src, /export\s+async\s+function\s+recordScanBatch/);
    assert.match(src, /DATABASE_URL/); // graceful degradation guard present
  });

  it('route exports POST, is rate-limited, and 503s on persistence-unavailable', () => {
    const src = fs.readFileSync(ROUTE, 'utf8');
    assert.match(src, /export\s+async\s+function\s+POST/);
    assert.match(src, /PRESETS\.telemetry/);
    assert.match(src, /503/);
    assert.match(src, /recordScanBatch/);
  });
});
