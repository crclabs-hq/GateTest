'use strict';

// bashSafety — `|| true` on teardown of something that may already be gone,
// or on a read-only diagnostic, is a warning (Tallrig deploy.sh /
// uninstall.sh / ufw-rules.sh, 2026-10-03). The rollback lines beside them in
// the same deploy.sh — rsync, restart, git reset, bun install — keep blocking.
// A `2>/dev/null || true` line is reported once, not under two rules.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BashSafetyModule = require('../src/modules/bash-safety');

async function findings(script) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-bash-teardown-'));
  try {
    fs.mkdirSync(path.join(root, 'infra'));
    fs.writeFileSync(path.join(root, 'infra/deploy.sh'), `#!/usr/bin/env bash\nset -euo pipefail\n${script}\n`);
    const checks = [];
    await new BashSafetyModule().run({ checks, addCheck(name, passed, meta) { checks.push({ name, passed, ...(meta || {}) }); } }, { projectRoot: root });
    return checks.filter((c) => !c.passed && /pipe-true|devnull-swallow/.test(c.name));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('bashSafety — teardown and read-only diagnostics', () => {
  for (const line of [
    'systemctl stop caddy 2>/dev/null || true',
    'systemctl disable --now old-unit 2>/dev/null || true',
    'userdel vapron-backup 2>/dev/null || true',
    'ufw delete allow 8080/tcp || true',
    'git remote remove mirror 2>/dev/null || true',
    'docker rm -f preview-$PR 2>/dev/null || true',
    'pkill -f old-gateway || true',
    'journalctl -u vapron-bun-gateway --no-pager -n 30 2>&1 || true',
  ]) {
    it(`warning: ${line}`, async () => {
      const f = await findings(line);
      assert.equal(f.length, 1, f.map((x) => x.name).join());
      assert.equal(f[0].severity, 'warning');
    });
  }

  it('a `|| true` on a continuation line is judged by the command it ends', async () => {
    const f = await findings(['systemctl stop \\', '  vapron-web@blue 2>/dev/null || true'].join('\n'));
    assert.deepEqual(f.map((x) => x.severity), ['warning']);
  });
});

describe('bashSafety — what brings state into being still blocks', () => {
  for (const line of [
    'rsync -a --delete "$APP_DIR/apps/web/.output/" "$slot/.output/" 2>/dev/null || true',
    'systemctl restart "$unit" 2>/dev/null || true',
    'git reset --hard "$last_good" 2>&1 || true',
    'bun install --frozen-lockfile 2>&1 || true',
    'systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true',
  ]) {
    it(`error: ${line}`, async () => {
      const f = await findings(line);
      assert.equal(f.length, 1, f.map((x) => x.name).join());
      assert.equal(f[0].severity, 'error');
    });
  }
});

describe('bashSafety — one finding per swallowed line', () => {
  it('`2>/dev/null || true` is devnull-swallow only', async () => {
    const f = await findings('tar -czf dist.tgz dist 2>/dev/null || true');
    assert.deepEqual(f.map((x) => x.name.split(':')[1]), ['devnull-swallow']);
  });

  it('a bare `|| true` is still pipe-true', async () => {
    const f = await findings('tar -czf dist.tgz dist || true');
    assert.deepEqual(f.map((x) => x.name.split(':')[1]), ['pipe-true']);
  });
});
