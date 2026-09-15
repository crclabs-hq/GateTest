'use strict';

// src/core/offline.js — air-gapped mode (the Fifty, move 42): nothing leaves
// the machine, and every report says so. The controls: the upload that must
// not happen, the AI path that must refuse out loud, the doctor ping that
// must be skipped, and the provenance that must record it.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { isOffline, enableOffline, OFFLINE_NOTE } = require('../src/core/offline');
const uploader = require('../src/core/telemetry-uploader');
const { buildProvenance } = require('../src/core/report-provenance');
const { parseArgs } = require('../src/core/cli-args');

describe('offline — the switch', () => {
  it('reads GATETEST_OFFLINE like every other boolean env: 1/true on, 0/false/unset off', () => {
    assert.equal(isOffline({}), false);
    assert.equal(isOffline({ GATETEST_OFFLINE: '1' }), true);
    assert.equal(isOffline({ GATETEST_OFFLINE: 'true' }), true);
    assert.equal(isOffline({ GATETEST_OFFLINE: '0' }), false);
    assert.equal(isOffline({ GATETEST_OFFLINE: 'false' }), false);
  });

  it('enableOffline also turns telemetry off, so no buffer is even written', () => {
    const env = {};
    enableOffline(env);
    assert.deepEqual(env, { GATETEST_OFFLINE: '1', GATETEST_NO_TELEMETRY: '1' });
  });

  it('--offline is a CLI flag', () => {
    assert.equal(parseArgs(['--offline']).offline, true);
  });
});

describe('offline — nothing leaves the machine', () => {
  let saved;
  beforeEach(() => { saved = { off: process.env.GATETEST_OFFLINE, tel: process.env.GATETEST_NO_TELEMETRY }; });
  afterEach(() => {
    for (const [k, v] of [['GATETEST_OFFLINE', saved.off], ['GATETEST_NO_TELEMETRY', saved.tel]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it('the telemetry flush returns before fetch, even with a buffer waiting and telemetry otherwise on', async () => {
    delete process.env.GATETEST_NO_TELEMETRY;
    process.env.GATETEST_OFFLINE = '1';
    const file = path.join(os.tmpdir(), `gt-off-${Date.now()}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ ts: 't', source: 'cli', suite: 'quick', gateStatus: 'PASSED', modules: [] }) + '\n');
    let called = 0;
    const r = await uploader.flush({ filePath: file, _fetch: async () => { called++; return { ok: true, json: async () => ({}) }; } });
    fs.rmSync(file, { force: true });
    assert.equal(called, 0, 'fetch was called in offline mode');
    assert.equal(r.reason, 'offline');
  });

  it('the summary and the signed provenance record the mode', () => {
    process.env.GATETEST_OFFLINE = '1';
    const p = buildProvenance({ results: [], offline: true });
    assert.equal(p.scope.offline, true);
    assert.equal(buildProvenance({ results: [] }).scope.offline, false, 'absent is false, not missing');
  });
});

describe('offline — end to end on a fixture with the network dead', () => {
  it('a quick scan under --offline passes, prints the mode, records it, and touches no network', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-off-e2e-'));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), '{"name":"off","version":"1.0.0"}\n');
      fs.mkdirSync(path.join(root, 'src'));
      fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = (a, b) => a + b;\n');
      const env = {
        ...process.env,
        // A proxy nothing listens on: any outbound attempt fails fast and loudly.
        HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '',
        ANTHROPIC_API_KEY: 'not-a-real-key', GATETEST_REPORT_SIGNING_KEY: 'x'.repeat(32),
      };
      delete env.GATETEST_OFFLINE; delete env.GATETEST_NO_TELEMETRY;
      const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'gatetest.js'), '--suite', 'quick', '--offline', '--fix', '--project', root],
        { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }).replace(/\x1b\[[0-9;]*m/g, '');
      assert.match(out, /GATE: PASSED/);
      assert.match(out, new RegExp(`Mode: ${OFFLINE_NOTE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      const report = JSON.parse(fs.readFileSync(path.join(root, '.gatetest', 'reports', 'gatetest-report-latest.json'), 'utf8'));
      assert.equal(report.provenance.scope.offline, true);
      assert.ok(report.signature.signature, 'signed locally, verifiable anywhere');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('--fix under --offline is refused out loud, and the scan still runs; `gatetest fix` exits 2', () => {
    const { spawnSync } = require('node:child_process');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-off-fix-'));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), '{"name":"off","version":"1.0.0"}\n');
      const bin = path.join(__dirname, '..', 'bin', 'gatetest.js');
      const env = { ...process.env, ANTHROPIC_API_KEY: 'not-a-real-key' };
      const scan = spawnSync(process.execPath, [bin, '--suite', 'quick', '--offline', '--fix', '--project', root], { env, encoding: 'utf8', timeout: 120000 });
      assert.match(scan.stderr, /offline mode: --fix \/ --auto-pr need the AI provider API and are not run/);
      assert.match(scan.stdout.replace(/\x1b\[[0-9;]*m/g, ''), /GATE: (PASSED|BLOCKED)/, 'the scan itself still ran');
      const fix = spawnSync(process.execPath, [bin, 'fix', '--project', root], { env: { ...env, GATETEST_OFFLINE: '1' }, encoding: 'utf8', timeout: 60000 });
      assert.equal(fix.status, 2);
      assert.match(fix.stderr, /offline mode: `gatetest fix` needs the AI provider API/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
