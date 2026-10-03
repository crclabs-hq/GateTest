// Control pairs for env reads whose absent value only picks a branch.
// Real lines from Gluecron (2026-10-03): 30 of its 36 blocking
// `missing-from-example` findings were `process.env.FLAG === "1"` toggles,
// secrets tested with `if (!secret)` before use, a multi-line ternary, and
// JSX prose naming a key. Each must stay a warning; the unguarded read
// beside it must still block.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EnvVarsModule = require('../src/modules/env-vars');

async function severities(files) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ev-pres-'));
  try {
    fs.writeFileSync(path.join(tmp, '.env.example'), 'DATABASE_URL=\n');
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
      fs.writeFileSync(path.join(tmp, rel), body);
    }
    const checks = [];
    await new EnvVarsModule().run(
      { addCheck(name, passed, d = {}) { checks.push({ name, passed, ...d }); } },
      { projectRoot: tmp },
    );
    const out = {};
    for (const c of checks) {
      const m = /^env-vars:missing-from-example:(.+)$/.exec(c.name);
      if (m) out[m[1]] = c.severity;
    }
    return out;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe('envVars — presence checks are guarded reads', () => {
  let sev;
  beforeEach(async () => {
    sev = await severities({
      'src/config.ts': [
        'export const cfg = {',
        '  get disabled() { return process.env.SECRET_SCAN_ON_PUSH_DISABLED === "1"; },',
        '  get enforce() { return process.env.SSRF_ENFORCE_IN_TEST !== "1"; },',
        '};',
        'if (!process.env.NEGATED_KEY) {}',
        'const plain = !!process.env.NO_COLOR_KEY;',
        'if (process.env.SSH_DEBUG_KEY) {}',
        'const on = process.env.AND_KEY && other;',
        '',
      ].join('\n'),
      'src/webhook.ts': [
        'export async function handle() {',
        '  const secret = process.env.STRIPE_WEBHOOK_SECRET;',
        '  if (!secret) {',
        '    return 503;',
        '  }',
        '  const raw = Number(process.env.GIT_EXEC_TIMEOUT_MS);',
        '  const ms = Number.isFinite(raw) && raw > 0 ? raw : 1000;',
        '  const repo = process.env.SELF_HOST_REPO;',
        '  const hit = repo',
        '    ? await match(repo)',
        '    : false;',
        '  const url = process.env.UNGUARDED_URL;',
        '  return fetch(url + "/x");',
        '}',
        '',
      ].join('\n'),
      'src/page.tsx': [
        'export const Doc = () => (',
        '  <p>read the payload from <code>process.env.JSX_PROSE_KEY</code> then print</p>',
        ');',
        'export const real = process.env.JSX_REAL_READ;',
        '',
      ].join('\n'),
    });
  });

  for (const key of [
    'SECRET_SCAN_ON_PUSH_DISABLED', 'SSRF_ENFORCE_IN_TEST', 'NEGATED_KEY', 'NO_COLOR_KEY',
    'SSH_DEBUG_KEY', 'AND_KEY', 'STRIPE_WEBHOOK_SECRET', 'GIT_EXEC_TIMEOUT_MS', 'SELF_HOST_REPO',
  ]) {
    it(`${key} is reported as a warning, not a blocking error`, () => {
      assert.strictEqual(sev[key], 'warning');
    });
  }

  it('control: a read used without any test still blocks', () => {
    assert.strictEqual(sev.UNGUARDED_URL, 'error');
    assert.strictEqual(sev.JSX_REAL_READ, 'error');
  });

  it('JSX prose naming a key is not a read at all', () => {
    assert.strictEqual(sev.JSX_PROSE_KEY, undefined);
  });
});

describe('envVars — a binding tested too late still blocks', () => {
  let sev;
  beforeEach(async () => {
    sev = await severities({
      'src/a.ts': [
        'const token = process.env.USED_FIRST_TOKEN;',
        'send(token);',
        'log("x");',
        'log("y");',
        'log("z");',
        'log("w");',
        'if (!token) {}',
        '',
      ].join('\n'),
    });
  });
  afterEach(() => {});

  it('a test outside the five-line window does not guard the read', () => {
    assert.strictEqual(sev.USED_FIRST_TOKEN, 'error');
  });
});
