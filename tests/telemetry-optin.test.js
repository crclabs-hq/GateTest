'use strict';
/**
 * Telemetry switches (issue #801). GATETEST_TELEMETRY=1|0 and .gatetest.json
 * "telemetry": true|false are the canonical switches; GATETEST_NO_TELEMETRY=1
 * stays as an alias for off. With nothing set the answer is TELEMETRY_DEFAULT,
 * the owner's one-line decision. Also: the host guard on the uploader, the
 * once-only first-run notice, and --telemetry-status.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scanTelemetry = require('../src/core/scan-telemetry');
const uploader = require('../src/core/telemetry-uploader');
const notice = require('../src/core/telemetry-notice');

const { resolveTelemetry, TELEMETRY_DEFAULT, recordFieldNames } = scanTelemetry;

function project(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-optin-'));
  if (cfg !== undefined) fs.writeFileSync(path.join(dir, '.gatetest.json'), JSON.stringify(cfg));
  return dir;
}

describe('telemetry opt-in — resolution and source', () => {
  it('TELEMETRY_DEFAULT is one of the two owner choices', () => {
    assert.ok(TELEMETRY_DEFAULT === 'on' || TELEMETRY_DEFAULT === 'off');
  });

  it('GATETEST_TELEMETRY=0 -> disabled, source env', () => {
    const r = resolveTelemetry(project(), { GATETEST_TELEMETRY: '0' });
    assert.strictEqual(r.enabled, false);
    assert.strictEqual(r.source, 'env');
  });

  it('GATETEST_TELEMETRY=1 -> enabled, source env (positive control for the off cases)', () => {
    const r = resolveTelemetry(project({ telemetry: false }), { GATETEST_TELEMETRY: '1' });
    assert.strictEqual(r.enabled, true);
    assert.strictEqual(r.source, 'env');
  });

  it('.gatetest.json telemetry:false -> disabled, source project config', () => {
    const r = resolveTelemetry(project({ telemetry: false }), {});
    assert.strictEqual(r.enabled, false);
    assert.strictEqual(r.source, 'project config');
  });

  it('.gatetest.json telemetry:true -> enabled, source project config', () => {
    const r = resolveTelemetry(project({ telemetry: true }), {});
    assert.strictEqual(r.enabled, true);
    assert.strictEqual(r.source, 'project config');
  });

  it('GATETEST_NO_TELEMETRY=1 still disables (alias)', () => {
    const r = resolveTelemetry(project(), { GATETEST_NO_TELEMETRY: '1' });
    assert.strictEqual(r.enabled, false);
    assert.strictEqual(r.source, 'env');
  });

  it('the alias beats an explicit on, so --offline can never be overridden upward', () => {
    const r = resolveTelemetry(project({ telemetry: true }), { GATETEST_NO_TELEMETRY: '1', GATETEST_TELEMETRY: '1' });
    assert.strictEqual(r.enabled, false);
  });

  it('GATETEST_NO_TELEMETRY=0 does not disable', () => {
    assert.strictEqual(resolveTelemetry(project(), { GATETEST_NO_TELEMETRY: '0' }).source, 'default');
  });

  it('nothing set -> TELEMETRY_DEFAULT, source default', () => {
    const r = resolveTelemetry(project(), {});
    assert.strictEqual(r.enabled, TELEMETRY_DEFAULT === 'on');
    assert.strictEqual(r.source, 'default');
  });

  it('a non-boolean config value is ignored, not treated as a switch', () => {
    assert.strictEqual(resolveTelemetry(project({ telemetry: 'yes' }), {}).source, 'default');
  });
});

describe('telemetry opt-in — uploader host guard', () => {
  const keys = ['GATETEST_TELEMETRY', 'GATETEST_NO_TELEMETRY', 'GATETEST_OFFLINE', 'GATETEST_TELEMETRY_URL', 'GATETEST_TELEMETRY_ALLOW_HOST'];
  let saved;
  let file;
  beforeEach(() => {
    saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    process.env.GATETEST_TELEMETRY = '1';
    file = path.join(os.tmpdir(), `gt-guard-${process.pid}-${Date.now()}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ ts: 't', source: 'cli', suite: 'quick', gateStatus: 'PASSED', modules: [] }) + '\n');
  });
  afterEach(() => {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    fs.rmSync(file, { force: true });
  });

  it('GATETEST_TELEMETRY_URL on another host is refused and nothing is fetched', async () => {
    process.env.GATETEST_TELEMETRY_URL = 'https://evil.example/api/telemetry/scan';
    let called = 0;
    const r = await uploader.flush({ filePath: file, _fetch: async () => { called++; return { status: 200 }; } });
    assert.strictEqual(r.reason, 'host-not-allowed');
    assert.strictEqual(called, 0);
    assert.ok(fs.readFileSync(file, 'utf8').trim(), 'the buffer must survive a refused upload');
  });

  it('GATETEST_TELEMETRY_ALLOW_HOST=1 lets a self-hoster post to their own host', async () => {
    process.env.GATETEST_TELEMETRY_URL = 'https://ingest.corp.example/api/telemetry/scan';
    process.env.GATETEST_TELEMETRY_ALLOW_HOST = '1';
    let hit = null;
    const r = await uploader.flush({ filePath: file, _fetch: async (u) => { hit = u; return { status: 200 }; } });
    assert.strictEqual(hit, 'https://ingest.corp.example/api/telemetry/scan');
    assert.strictEqual(r.uploaded, 1);
  });

  it('with no override the default host uploads (positive control)', async () => {
    let hit = null;
    const r = await uploader.flush({ filePath: file, _fetch: async (u) => { hit = u; return { status: 200 }; } });
    assert.strictEqual(hit, 'https://gatetest.io/api/telemetry/scan');
    assert.strictEqual(r.uploaded, 1);
  });

  it('an explicit opts.url on another host is refused too', async () => {
    let called = 0;
    const r = await uploader.flush({ filePath: file, url: 'https://evil.example/x', _fetch: async () => { called++; return { status: 200 }; } });
    assert.strictEqual(r.reason, 'host-not-allowed');
    assert.strictEqual(called, 0);
  });
});

describe('telemetry opt-in — first-run notice', () => {
  function markerPath() {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gt-notice-')), 'sub', '.telemetry-notice-shown');
  }
  const allowed = { host: 'gatetest.io', allowed: true, url: 'https://gatetest.io/api/telemetry/scan' };

  it('prints the host, every field name and both ways off, then never again', () => {
    const marker = markerPath();
    const out = [];
    assert.strictEqual(notice.maybeNoticeTelemetry({ write: (t) => out.push(t), marker, target: allowed }), true);
    const text = out.join('\n');
    assert.match(text, /gatetest\.io/);
    const f = recordFieldNames();
    for (const name of [...f.record, ...f.module, ...f.rule]) assert.ok(text.includes(name), `notice omits field ${name}`);
    assert.match(text, /GATETEST_TELEMETRY=0/);
    assert.match(text, /"telemetry": false/);
    assert.match(text, /--telemetry-status/);

    const again = [];
    assert.strictEqual(notice.maybeNoticeTelemetry({ write: (t) => again.push(t), marker, target: allowed }), false);
    assert.deepStrictEqual(again, [], 'the notice must not print a second time');
  });

  it('the notice lists field names only, never a value', () => {
    const text = notice.noticeLines(allowed).join('\n');
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T/, 'no timestamp value');
    assert.doesNotMatch(text, /PASSED|BLOCKED/);
  });

  it('a refused host prints nothing and leaves no marker, so it appears when an upload first could happen', () => {
    const marker = markerPath();
    const out = [];
    const shown = notice.maybeNoticeTelemetry({ write: (t) => out.push(t), marker, target: { host: 'evil.example', allowed: false } });
    assert.strictEqual(shown, false);
    assert.deepStrictEqual(out, []);
    assert.strictEqual(fs.existsSync(marker), false);
  });
});

describe('telemetry opt-in — --telemetry-status', () => {
  it('reports on/off, the deciding source and the host', () => {
    const off = notice.telemetryStatusLines(project({ telemetry: false }), {}).join('\n');
    assert.match(off, /Telemetry: off/);
    assert.match(off, /project config/);
    assert.match(off, /gatetest\.io/);
    const on = notice.telemetryStatusLines(project(), { GATETEST_TELEMETRY: '1' }).join('\n');
    assert.match(on, /Telemetry: on/);
    assert.match(on, /GATETEST_TELEMETRY/);
  });

  it('flags a refused host', () => {
    const t = notice.telemetryStatusLines(project(), { GATETEST_TELEMETRY_URL: 'https://evil.example' }).join('\n');
    assert.match(t, /evil\.example.*REFUSED/);
  });

  it('offline mode reads as off', () => {
    assert.match(notice.telemetryStatusLines(project(), { GATETEST_OFFLINE: '1' }).join('\n'), /Telemetry: off/);
  });
});
