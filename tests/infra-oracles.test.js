/**
 * Tests for the GateTest Infrastructure Truth Oracle modules:
 * bashSafety, envIntegrity, systemd, rollbackHonesty
 * plus deployContract basePath enhancements.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gt-infra-'));
}

function makeResult() {
  const checks = [];
  return {
    checks,
    addCheck(n, passed, details = {}) { checks.push({ name: n, passed, ...details }); },
  };
}

// ── bashSafety ────────────────────────────────────────────────────────────────

describe('bashSafety module', () => {
  const BashSafety = require('../src/modules/bash-safety');

  test('has correct name', () => {
    assert.equal(new BashSafety().name, 'bashSafety');
  });

  test('passes on clean script', async () => {
    const tmp = makeTmp();
    fs.writeFileSync(path.join(tmp, 'deploy.sh'), '#!/bin/bash\nset -euo pipefail\nbun install\n');
    const r = makeResult();
    await new BashSafety().run(r, { projectRoot: tmp });
    const errors = r.checks.filter(c => !c.passed && c.severity === 'error');
    assert.equal(errors.length, 0, 'clean script should have no errors');
    fs.rmSync(tmp, { recursive: true });
  });

  test('flags || true', async () => {
    const tmp = makeTmp();
    fs.writeFileSync(path.join(tmp, 'deploy.sh'), '#!/bin/bash\ntar -czf app.tar.gz dist/ || true\n');
    const r = makeResult();
    await new BashSafety().run(r, { projectRoot: tmp });
    assert(r.checks.some(c => !c.passed && c.name.includes('pipe-true')), 'should flag || true');
    fs.rmSync(tmp, { recursive: true });
  });

  test('flags 2>/dev/null || true', async () => {
    const tmp = makeTmp();
    fs.writeFileSync(path.join(tmp, 'deploy.sh'), '#!/bin/bash\nrm -rf /tmp/old 2>/dev/null || true\n');
    const r = makeResult();
    await new BashSafety().run(r, { projectRoot: tmp });
    assert(r.checks.some(c => !c.passed && c.name.includes('devnull-swallow')), 'should flag 2>/dev/null || true');
    fs.rmSync(tmp, { recursive: true });
  });

  test('flags set +e', async () => {
    const tmp = makeTmp();
    fs.writeFileSync(path.join(tmp, 'deploy.sh'), '#!/bin/bash\nset +e\nbun install\n');
    const r = makeResult();
    await new BashSafety().run(r, { projectRoot: tmp });
    assert(r.checks.some(c => !c.passed && c.name.includes('set-e-disabled')), 'should flag set +e');
    fs.rmSync(tmp, { recursive: true });
  });

  test('suppresses with gatetest:swallow-ok comment', async () => {
    const tmp = makeTmp();
    fs.writeFileSync(path.join(tmp, 'deploy.sh'), '#!/bin/bash\n# gatetest:swallow-ok reason="cleanup is best-effort"\nrm -rf /tmp/old || true\n');
    const r = makeResult();
    await new BashSafety().run(r, { projectRoot: tmp });
    const errors = r.checks.filter(c => !c.passed && c.severity === 'error');
    assert.equal(errors.length, 0, 'suppression comment should prevent flagging');
    fs.rmSync(tmp, { recursive: true });
  });

  test('flags in package.json scripts', async () => {
    const tmp = makeTmp();
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
      scripts: { build: 'tsc || true', test: 'jest' },
    }));
    const r = makeResult();
    await new BashSafety().run(r, { projectRoot: tmp });
    assert(r.checks.some(c => !c.passed), 'should flag || true in package.json scripts');
    fs.rmSync(tmp, { recursive: true });
  });
});

// ── envIntegrity ──────────────────────────────────────────────────────────────

describe('envIntegrity module', () => {
  const EnvIntegrity = require('../src/modules/env-integrity');

  test('has correct name', () => {
    assert.equal(new EnvIntegrity().name, 'envIntegrity');
  });

  test('passes on clean .env', async () => {
    const tmp = makeTmp();
    fs.writeFileSync(path.join(tmp, '.env'), 'DATABASE_URL=postgres://localhost:5432/db\nSECRET=abc123\n');
    const r = makeResult();
    await new EnvIntegrity().run(r, { projectRoot: tmp });
    const errors = r.checks.filter(c => !c.passed && c.severity === 'error');
    assert.equal(errors.length, 0, 'clean .env should pass');
    fs.rmSync(tmp, { recursive: true });
  });

  test('flags non-ASCII leading byte (U+2248)', async () => {
    const tmp = makeTmp();
    // Write a file with ≈PUBLIC_URL=... (U+2248 leading byte)
    fs.writeFileSync(path.join(tmp, '.env'), Buffer.from('\xe2\x89\x88PUBLIC_URL=https://example.com\n'));
    const r = makeResult();
    await new EnvIntegrity().run(r, { projectRoot: tmp });
    assert(r.checks.some(c => !c.passed && c.name.includes('non-ascii')), 'should flag non-ASCII leading byte');
    fs.rmSync(tmp, { recursive: true });
  });

  test('flags smart quotes in value', async () => {
    const tmp = makeTmp();
    fs.writeFileSync(path.join(tmp, '.env'), 'SECRET=‘smartvalue’\n');
    const r = makeResult();
    await new EnvIntegrity().run(r, { projectRoot: tmp });
    assert(r.checks.some(c => !c.passed && c.name.includes('smart-quote')), 'should flag smart quotes');
    fs.rmSync(tmp, { recursive: true });
  });

  test('flags trailing whitespace', async () => {
    const tmp = makeTmp();
    fs.writeFileSync(path.join(tmp, '.env'), 'DATABASE_URL=postgres://localhost  \n');
    const r = makeResult();
    await new EnvIntegrity().run(r, { projectRoot: tmp });
    assert(r.checks.some(c => !c.passed && c.name.includes('trailing-space')), 'should flag trailing whitespace');
    fs.rmSync(tmp, { recursive: true });
  });

  test('KI #48: does NOT flag CRLF-encoded lines as trailing whitespace (self-scan found 123/123 false positives from this)', async () => {
    const tmp = makeTmp();
    fs.writeFileSync(path.join(tmp, '.env'), 'DATABASE_URL=postgres://localhost:5432/db\r\nSECRET=abc123\r\n');
    const r = makeResult();
    await new EnvIntegrity().run(r, { projectRoot: tmp });
    assert.equal(
      r.checks.filter(c => !c.passed && c.name.includes('trailing-space')).length,
      0,
      'CRLF line endings alone should not be reported as trailing whitespace'
    );
    fs.rmSync(tmp, { recursive: true });
  });

  test('still flags GENUINE trailing whitespace on a CRLF-encoded file', async () => {
    // Control case — proves the CRLF fix doesn't blind the check entirely.
    const tmp = makeTmp();
    fs.writeFileSync(path.join(tmp, '.env'), 'DATABASE_URL=postgres://localhost   \r\nSECRET=abc123\r\n');
    const r = makeResult();
    await new EnvIntegrity().run(r, { projectRoot: tmp });
    const hits = r.checks.filter(c => !c.passed && c.name.includes('trailing-space'));
    assert.equal(hits.length, 1, `expected exactly the one genuine hit (line 1), got: ${JSON.stringify(hits)}`);
    assert.ok(hits[0].name.endsWith(':1'), 'the genuine trailing-whitespace hit should be on line 1');
    fs.rmSync(tmp, { recursive: true });
  });

  test('no-ops when no .env files found', async () => {
    const tmp = makeTmp();
    const r = makeResult();
    await assert.doesNotReject(() => new EnvIntegrity().run(r, { projectRoot: tmp }));
    fs.rmSync(tmp, { recursive: true });
  });

  test('ignores comment lines', async () => {
    const tmp = makeTmp();
    fs.writeFileSync(path.join(tmp, '.env'), '# This is a comment with smart quote ‘\nFOO=bar\n');
    const r = makeResult();
    await new EnvIntegrity().run(r, { projectRoot: tmp });
    const errors = r.checks.filter(c => !c.passed && c.severity === 'error');
    assert.equal(errors.length, 0, 'comment lines should be ignored');
    fs.rmSync(tmp, { recursive: true });
  });
});

// ── systemd ───────────────────────────────────────────────────────────────────

describe('systemd module', () => {
  const Systemd = require('../src/modules/systemd');

  test('has correct name', () => {
    assert.equal(new Systemd().name, 'systemd');
  });

  test('no-ops cleanly when no .service files found', async () => {
    const tmp = makeTmp();
    const r = makeResult();
    await assert.doesNotReject(() => new Systemd().run(r, { projectRoot: tmp }));
    assert(r.checks.some(c => c.name === 'systemd-no-units'));
    fs.rmSync(tmp, { recursive: true });
  });

  test('flags missing Restart directive', async () => {
    const tmp = makeTmp();
    fs.mkdirSync(path.join(tmp, 'infra'));
    fs.writeFileSync(path.join(tmp, 'infra', 'app.service'), `[Unit]
Description=App
[Service]
ExecStart=/usr/bin/node server.js
WorkingDirectory=/opt/app
[Install]
WantedBy=multi-user.target
`);
    const r = makeResult();
    await new Systemd().run(r, { projectRoot: tmp });
    assert(r.checks.some(c => !c.passed && c.name.includes('no-restart')), 'should flag missing Restart=');
    fs.rmSync(tmp, { recursive: true });
  });

  test('flags ProtectHome=true blocking bun binary', async () => {
    const tmp = makeTmp();
    fs.mkdirSync(path.join(tmp, 'infra'));
    fs.writeFileSync(path.join(tmp, 'infra', 'app.service'), `[Unit]
Description=App
[Service]
User=deploy
ProtectHome=true
ExecStart=/root/.bun/bin/bun run server.js
Restart=always
WorkingDirectory=/opt/app
[Install]
WantedBy=multi-user.target
`);
    const r = makeResult();
    await new Systemd().run(r, { projectRoot: tmp });
    assert(r.checks.some(c => !c.passed && c.name.includes('protect-home-conflict')), 'should flag ProtectHome + bun home dir binary');
    fs.rmSync(tmp, { recursive: true });
  });

  test('passes a well-formed unit', async () => {
    const tmp = makeTmp();
    fs.mkdirSync(path.join(tmp, 'infra'));
    fs.writeFileSync(path.join(tmp, 'infra', 'app.service'), `[Unit]
Description=App
[Service]
ExecStart=/usr/local/bin/node server.js
WorkingDirectory=/opt/app
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
[Install]
WantedBy=multi-user.target
`);
    const r = makeResult();
    await new Systemd().run(r, { projectRoot: tmp });
    const errors = r.checks.filter(c => !c.passed && c.severity === 'error');
    assert.equal(errors.length, 0, 'well-formed unit should have no errors');
    fs.rmSync(tmp, { recursive: true });
  });
});

// ── rollbackHonesty ───────────────────────────────────────────────────────────

describe('rollbackHonesty module', () => {
  const RollbackHonesty = require('../src/modules/rollback-honesty');

  test('has correct name', () => {
    assert.equal(new RollbackHonesty().name, 'rollbackHonesty');
  });

  test('no-ops when no deploy scripts found', async () => {
    const tmp = makeTmp();
    const r = makeResult();
    await assert.doesNotReject(() => new RollbackHonesty().run(r, { projectRoot: tmp }));
    fs.rmSync(tmp, { recursive: true });
  });

  test('passes when no rollback present', async () => {
    const tmp = makeTmp();
    fs.writeFileSync(path.join(tmp, 'deploy.sh'), '#!/bin/bash\nset -euo pipefail\nbun install\nbun run build\n');
    const r = makeResult();
    await new RollbackHonesty().run(r, { projectRoot: tmp });
    const errors = r.checks.filter(c => !c.passed && c.severity === 'error');
    assert.equal(errors.length, 0);
    fs.rmSync(tmp, { recursive: true });
  });

  test('flags rollback that uses same SHA (HEAD)', async () => {
    const tmp = makeTmp();
    fs.writeFileSync(path.join(tmp, 'deploy.sh'), `#!/bin/bash
set -euo pipefail
PREV_SHA=$(git rev-parse HEAD)
git pull origin main || {
  echo "Deploy failed, rolling back"
  git reset --hard HEAD
  exit 0
}
`);
    const r = makeResult();
    await new RollbackHonesty().run(r, { projectRoot: tmp });
    assert(r.checks.some(c => !c.passed && c.name.includes('same-sha')), 'should flag rollback using same SHA');
    fs.rmSync(tmp, { recursive: true });
  });

  test('passes rollback that uses PREV_SHA', async () => {
    const tmp = makeTmp();
    fs.writeFileSync(path.join(tmp, 'deploy.sh'), `#!/bin/bash
set -euo pipefail
PREV_SHA=$(git rev-parse HEAD)
git pull origin main || {
  echo "Deploy failed, rolling back to $PREV_SHA"
  git reset --hard $PREV_SHA
  systemctl restart app
  exit 1
}
`);
    const r = makeResult();
    await new RollbackHonesty().run(r, { projectRoot: tmp });
    const errors = r.checks.filter(c => !c.passed && c.severity === 'error' && c.name.includes('same-sha'));
    assert.equal(errors.length, 0, 'PREV_SHA rollback should not flag same-sha');
    fs.rmSync(tmp, { recursive: true });
  });
});

// ── deployContract basePath enhancement ───────────────────────────────────────

describe('deployContract basePath awareness', () => {
  const DeployContract = require('../src/modules/deploy-contract');

  test('detects Hono basePath and flags missing prefix', async () => {
    const tmp = makeTmp();
    // Deploy curls /health but route is mounted under /api basePath
    fs.writeFileSync(path.join(tmp, 'deploy.sh'),
      '#!/bin/bash\ncurl -f http://localhost:3000/health || exit 1\n');
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'server.ts'),
      "const app = new Hono().basePath('/api');\napp.get('/health', (c) => c.json({ ok: true }));\n");
    const r = makeResult();
    await new DeployContract().run(r, { projectRoot: tmp });
    // Should flag: /health is not matched because real URL is /api/health
    const errors = r.checks.filter(c => !c.passed && c.severity === 'error');
    assert(errors.length > 0, 'should flag when health-check URL misses basePath prefix');
    fs.rmSync(tmp, { recursive: true });
  });

  test('passes when deploy URL includes the basePath', async () => {
    const tmp = makeTmp();
    fs.writeFileSync(path.join(tmp, 'deploy.sh'),
      '#!/bin/bash\ncurl -f http://localhost:3000/api/health || exit 1\n');
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'server.ts'),
      "const app = new Hono().basePath('/api');\napp.get('/health', (c) => c.json({ ok: true }));\n");
    const r = makeResult();
    await new DeployContract().run(r, { projectRoot: tmp });
    const errors = r.checks.filter(c => !c.passed && c.severity === 'error');
    assert.equal(errors.length, 0, 'correct basePath-prefixed URL should pass');
    fs.rmSync(tmp, { recursive: true });
  });
});
