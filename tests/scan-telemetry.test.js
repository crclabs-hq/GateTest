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
    // `suppressed` added 2026-07-27 for the noise model (KI #76). Same
    // privacy class as errors/warnings/soft: an integer count, never a path,
    // message, or fragment of code. This deepEqual is the gate on that — any
    // future field must be justified here before it can ship.
    assert.deepEqual(secrets, { name: 'secrets', errors: 2, warnings: 0, soft: 0, suppressed: 0, status: 'failed' });
  });

  it('never emits a file path, code, or finding message anywhere in the record', () => {
    const rec = scanTelemetry._buildRecord(makeSummary(), { source: 'cli' });
    const serialized = JSON.stringify(rec);
    assert.ok(!serialized.includes('src/db.js'), 'file path leaked');
    assert.ok(!serialized.includes('hardcoded key'), 'finding message leaked');
    assert.ok(!/\bfile\b|\bline\b|\bmessage\b|\bchecks\b/.test(serialized), `PII-shaped key leaked: ${serialized}`);
  });

  it('gateStatus normalizes to PASSED / BLOCKED / REPORT_ONLY only', () => {
    const passed = scanTelemetry._buildRecord({ gateStatus: 'PASSED', results: [] }, {});
    assert.equal(passed.gateStatus, 'PASSED');
    const reportOnly = scanTelemetry._buildRecord({ gateStatus: 'REPORT_ONLY', results: [] }, {});
    assert.equal(reportOnly.gateStatus, 'REPORT_ONLY');
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

  it('telemetryEnabled follows TELEMETRY_DEFAULT with no env and no config', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-defon-'));
    try {
      assert.equal(scanTelemetry.telemetryEnabled(dir), scanTelemetry.TELEMETRY_DEFAULT === 'on');
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

// ---------------------------------------------------------------------------
// Per-rule fired / silenced counts — the flywheel leaderboard's input
// (the Fifty, move 07). Rule IDS and integers only.
// ---------------------------------------------------------------------------
describe('scan-telemetry — per-rule counts', () => {
  const withRules = () => ({
    gateStatus: 'BLOCKED', duration: 1, suite: 'quick', checks: { errors: 2, warnings: 1 },
    results: [{
      module: 'hardcodedUrl', status: 'failed', errors: 2, warnings: 1, softErrors: 0, checks: [
        { name: 'hardcoded-url:localhost:src/cfg.js:1', file: 'src/cfg.js', line: 1, passed: false, severity: 'error' },
        { name: 'hardcoded-url:localhost:src/other.js:9', file: 'src/other.js', line: 9, passed: false, severity: 'error' },
        { name: 'hardcoded-url:ip:src/net.js:3', file: 'src/net.js', line: 3, passed: false, severity: 'warning', suppressed: true, suppressReason: 'ignore-file' },
        { name: 'hardcoded-url:ip:src/net2.js:4', file: 'src/net2.js', line: 4, passed: false, severity: 'warning', suppressed: true, suppressReason: 'baseline' },
        { name: 'hardcoded-url:ok', passed: true },
        { name: 'weird rule with a space:src/x.js:2', file: 'src/x.js', line: 2, passed: false },
        { name: 'unmatched:src\\win\\path.js:7', file: 'src/win/path.js', line: 7, passed: false },
      ],
    }],
  });

  it('counts fired and silenced per rule id, with the file:line stripped', () => {
    const rec = scanTelemetry._buildRecord(withRules(), { source: 'cli' });
    assert.deepEqual(rec.rules, [
      { id: 'hardcoded-url:ip', fired: 0, silenced: 1 },
      { id: 'hardcoded-url:localhost', fired: 2, silenced: 0 },
    ]);
  });

  it('a baselined finding is "real, fix later", not a dismissal — never counted as silenced', () => {
    const rec = scanTelemetry._buildRecord(withRules(), { source: 'cli' });
    assert.equal(rec.rules.find((r) => r.id === 'hardcoded-url:ip').silenced, 1, 'only the ignore-file suppression');
  });

  it('an id that still carries a path separator or whitespace is dropped, not shipped', () => {
    const rec = scanTelemetry._buildRecord(withRules(), { source: 'cli' });
    const serialized = JSON.stringify(rec.rules);
    assert.ok(!/src[/\\]/.test(serialized), serialized);
    assert.ok(!serialized.includes('weird rule'), serialized);
  });

  it('a summary with no checks has an empty rules array, not a missing field', () => {
    assert.deepEqual(scanTelemetry._buildRecord(makeSummary(), { source: 'cli' }).rules, []);
  });
});

describe('scan-telemetry-sanitize — per-rule counts', () => {
  const base = { source: 'cli', suite: 'quick', gateStatus: 'BLOCKED', durationMs: 1, totalErrors: 1, totalWarnings: 0, modules: [] };

  it('accepts identifier-shaped rule ids with integer counts', () => {
    const r = sanitizeRecord({ ...base, rules: [{ id: 'secrets:aws-key', fired: 2, silenced: 1 }, { id: 'hardcoded-url:localhost', fired: '3', silenced: -1 }] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.record.rules, [{ id: 'secrets:aws-key', fired: 2, silenced: 1 }, { id: 'hardcoded-url:localhost', fired: 0, silenced: 0 }]);
  });

  it('REJECTS a rule id that looks like a path or prose, and a rule carrying a forbidden key', () => {
    assert.equal(sanitizeRecord({ ...base, rules: [{ id: 'secrets:aws-key:src/db.js', fired: 1, silenced: 0 }] }).reason, 'rule-id-not-an-identifier');
    assert.equal(sanitizeRecord({ ...base, rules: [{ id: 'has a space', fired: 1, silenced: 0 }] }).reason, 'rule-id-not-an-identifier');
    assert.equal(sanitizeRecord({ ...base, rules: [{ id: 'secrets:aws-key', fired: 1, silenced: 0, file: 'x' }] }).reason, 'forbidden-key-in-rule');
  });

  it('a record without rules is still accepted (older clients) and gets an empty array', () => {
    const r = sanitizeRecord(base);
    assert.equal(r.ok, true);
    assert.deepEqual(r.record.rules, []);
  });
});
