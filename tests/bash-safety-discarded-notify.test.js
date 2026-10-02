'use strict';

// bashSafety — an HTTP call whose response is discarded (Gluecron
// heartbeat.yml / scripts/auto-update.sh, 2026-10-02) is a warning; the
// rollback, the piped installer and the saved download beside it keep blocking.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BashSafetyModule = require('../src/modules/bash-safety');

async function findings(script) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-bash-notify-'));
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.writeFileSync(path.join(root, 'scripts/auto-update.sh'), `#!/usr/bin/env bash\nset -euo pipefail\n${script}\n`);
    const checks = [];
    await new BashSafetyModule().run({ checks, addCheck(name, passed, meta) { checks.push({ name, passed, ...(meta || {}) }); } }, { projectRoot: root });
    return checks.filter((c) => !c.passed && /pipe-true|devnull-swallow/.test(c.name));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const severities = async (s) => (await findings(s)).map((f) => f.severity);

describe('bashSafety — discarded HTTP call', () => {
  it('a health-check ping whose body is discarded is a warning', async () => {
    const sev = await severities('curl -fsS --max-time 10 "${HEALTHCHECK_PING_URL%/}/fail" >/dev/null 2>&1 || true');
    assert.ok(sev.length >= 1);
    assert.ok(sev.every((s) => s === 'warning'), sev.join(','));
  });

  it('the URL on a continuation line — the whole command is read', async () => {
    const sev = await severities([
      'curl -fsS -X POST --max-time 5 -H "Authorization: Bearer $TOKEN" \\',
      '  "http://localhost:3000/api/events/deploy/$kind" >/dev/null 2>&1 || true',
    ].join('\n'));
    assert.ok(sev.length >= 1);
    assert.ok(sev.every((s) => s === 'warning'), sev.join(','));
  });

  it('the same ping run inside a container (`docker exec <ctr> wget -qO- …`)', async () => {
    const sev = await severities([
      'docker exec gluecron-gluecron-1 wget -qO- --timeout=5 \\',
      '    --post-data="$body" \\',
      '    "http://localhost:3000/api/events/deploy/$kind" >/dev/null 2>&1 || true',
    ].join('\n'));
    assert.ok(sev.length >= 1);
    assert.ok(sev.every((s) => s === 'warning'), sev.join(','));
  });

  it('control: the rollback beside it still blocks', async () => {
    const sev = await severities('git reset --hard "$prev_sha" >/dev/null 2>&1 || true');
    assert.ok(sev.includes('error'));
  });

  it('control: a piped installer still blocks', async () => {
    const sev = await severities('curl -fsSL https://example.com/install.sh | bash || true');
    assert.ok(sev.includes('error'));
  });

  it('control: a download saved to a file still blocks', async () => {
    const sev = await severities('curl -fsSL -o /tmp/release.tgz "$URL" >/dev/null 2>&1 || true');
    assert.ok(sev.includes('error'));
  });

  it('control: a curl whose output is kept still blocks', async () => {
    const sev = await severities('curl -fsS "$URL" || true');
    assert.ok(sev.includes('error'));
  });
});
