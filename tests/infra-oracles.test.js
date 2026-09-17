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

// ── bashSafety: swallow vs. tolerant exit (2026-08-31) ────────────────────────
//
// The module used to flag every `|| true` and every `set +e` identically. On
// this repo that was 12 blocking findings, 4 of them false positives on
// commands whose non-zero exit is an ANSWER (`command -v`, `head`, `grep`) or
// on a `set +e` whose exit code is captured and re-raised two lines later.
//
// Every negative control below is paired with a positive control, because
// "quieter" and "broken" are indistinguishable without one: a rule that stops
// flagging `command -v node || true` must still flag `node deploy.js || true`
// in the production deploy path, which is the swallow that let /opt/gatetest
// sit 60 commits stale for six days.

describe('bashSafety — tolerant exits vs. real swallows', () => {
  const BashSafety = require('../src/modules/bash-safety');

  async function scanShell(body, rel = 'deploy.sh') {
    const tmp = makeTmp();
    const file = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    const r = makeResult();
    await new BashSafety().run(r, { projectRoot: tmp });
    fs.rmSync(tmp, { recursive: true, force: true });
    return r.checks.filter(c => !c.passed && c.severity === 'error');
  }

  async function scanYaml(body, rel = '.github/workflows/w.yml') {
    return scanShell(body, rel);
  }

  // ── negative controls: these must stay SILENT ──────────────────────────────

  const TOLERANT = [
    ['command -v', '#!/bin/bash\nset -e\nNODE_BIN="$(command -v node || true)"\n'],
    ['head on an optional file', '#!/bin/bash\nset -e\nBODY="$(head -c 500 /tmp/body || true)"\n'],
    ['grep that may not match', '#!/bin/bash\nset -e\nN=$(grep -c "^not ok" log.txt || true)\n'],
    ['git diff as a question', '#!/bin/bash\nset -e\ngit diff --quiet -- src/ || true\n'],
    ['diff exit 1 means "differs"', '#!/bin/bash\nset -e\ndiff a.txt b.txt || true\n'],
    ['pgrep finding nothing', '#!/bin/bash\nset -e\npgrep -f gatetest || true\n'],
  ];
  for (const [label, body] of TOLERANT) {
    test(`negative control: ${label} is not a swallowed error`, async () => {
      const errors = await scanShell(body);
      assert.equal(errors.length, 0,
        `${label} should not fire; got: ${errors.map(e => e.name).join(', ')}`);
    });
  }

  test('negative control: a jq program containing "|" does not confuse the splitter', async () => {
    const errors = await scanShell(
      '#!/bin/bash\nset -e\n' +
      'jq -r \'.checks // [] | length as $n | "\\($n) checks"\' report.json >> out.md 2>/dev/null || true\n'
    );
    assert.equal(errors.length, 0, `got: ${errors.map(e => e.name).join(', ')}`);
  });

  test('negative control: "|| true" inside a comment is documentation', async () => {
    const errors = await scanShell(
      '#!/bin/bash\nset -e\n' +
      '# `|| true` (not `|| echo 0`): grep -c prints 0 and exits 1 on no match.\n' +
      'make build\n'
    );
    assert.equal(errors.length, 0, `got: ${errors.map(e => e.name).join(', ')}`);
  });

  test('negative control: "|| true" inside a quoted string is not code', async () => {
    const errors = await scanShell('#!/bin/bash\nset -e\necho "never write || true here"\n');
    assert.equal(errors.length, 0, `got: ${errors.map(e => e.name).join(', ')}`);
  });

  test('negative control: set +e with the exit code captured and re-raised', async () => {
    const errors = await scanShell(
      '#!/bin/bash\nset +e\nnode probe.js > out.md\ncode=$?\ncat out.md\nexit $code\n'
    );
    assert.equal(errors.length, 0, `got: ${errors.map(e => e.name).join(', ')}`);
  });

  test('negative control: set +e restored by a later set -e', async () => {
    const errors = await scanShell('#!/bin/bash\nset +e\nnode probe.js\nset -e\necho done\n');
    assert.equal(errors.length, 0, `got: ${errors.map(e => e.name).join(', ')}`);
  });

  test('negative control: YAML step that writes $? to GITHUB_OUTPUT', async () => {
    const errors = await scanYaml([
      'jobs:',
      '  gate:',
      '    steps:',
      '      - name: GateTest',
      '        id: gate',
      '        run: |',
      '          set +e',
      '          node bin/gatetest.js --suite web',
      '          echo "exit_code=$?" >> "$GITHUB_OUTPUT"',
      '          set -e',
      '',
    ].join('\n'));
    assert.equal(errors.length, 0, `got: ${errors.map(e => e.name).join(', ')}`);
  });

  // ── positive controls: these must STILL FIRE ──────────────────────────────

  const SWALLOWS = [
    ['a program in the deploy path', 'scripts/deploy/deploy-on-box.sh',
      '#!/bin/bash\nset -e\nnode scripts/migrate.js || true\n'],
    ['systemctl probe hiding stderr and exit code', 'scripts/deploy/deploy-on-box.sh',
      '#!/bin/bash\nset -e\nU="$(systemctl list-unit-files --no-legend 2>/dev/null || true)"\n'],
    ['npm ci', 'ci.sh', '#!/bin/bash\nset -e\nnpm ci --ignore-scripts || true\n'],
    ['git push', 'release.sh', '#!/bin/bash\nset -e\ngit push origin main || true\n'],
    ['a build step', 'build.sh', '#!/bin/bash\nset -e\ntar -czf app.tar.gz dist/ || true\n'],
    ['rm hiding both stderr and status', 'clean.sh',
      '#!/bin/bash\nset -e\nrm -rf /tmp/old 2>/dev/null || true\n'],
  ];
  for (const [label, rel, body] of SWALLOWS) {
    test(`positive control: ${label} still fires`, async () => {
      const errors = await scanShell(body, rel);
      assert.ok(errors.length >= 1, `${label} must still be reported as a swallowed error`);
      assert.ok(errors.every(e => typeof e.message === 'string' && e.message.length > 0),
        'every finding must carry a message');
    });
  }

  test('positive control: set +e with nothing downstream still fires', async () => {
    const errors = await scanShell('#!/bin/bash\nset +e\nnpm run build\necho done\n');
    assert.ok(errors.some(e => e.name.includes('set-e-disabled')),
      'an unrestored set +e is a real swallow');
  });

  test('positive control: $? in a LATER YAML step does not excuse set +e', async () => {
    // The exemption must not leak across step boundaries — a different step's
    // exit-code handling says nothing about this one.
    const errors = await scanYaml([
      'jobs:',
      '  j:',
      '    steps:',
      '      - name: Notify',
      '        run: |',
      '          set +e',
      '          gh issue create --title x',
      '      - name: Other',
      '        run: |',
      '          node probe.js',
      '          echo "code=$?"',
      '',
    ].join('\n'));
    assert.ok(errors.some(e => e.name.includes('set-e-disabled')),
      'set +e in the Notify step must still be reported');
  });

  test('positive control: swallow-ok still requires a written reason to suppress', async () => {
    const suppressed = await scanShell(
      '#!/bin/bash\nset -e\n# gatetest:swallow-ok reason="artifact is best-effort"\nnode report.js || true\n'
    );
    assert.equal(suppressed.length, 0, 'an explicit justification suppresses the finding');
    const unsuppressed = await scanShell('#!/bin/bash\nset -e\nnode report.js || true\n');
    assert.ok(unsuppressed.length >= 1, 'without the justification it fires');
  });
});

// ── bashSafety: the files fixed on 2026-08-31 stay fixed ──────────────────────

describe('bashSafety — real repo paths stay free of swallowed errors', () => {
  const BashSafety = require('../src/modules/bash-safety');
  const REPO = path.resolve(__dirname, '..');

  // Only the files audited and fixed on 2026-08-31. Scoped deliberately: a new
  // finding elsewhere is a new decision, not a regression of this one.
  const GUARDED = [
    'scripts/deploy/deploy-on-box.sh',
    'scripts/deploy/empire-smoke.sh',
    'scripts/deploy/tick.sh',
    '.github/workflows/empire-smoke.yml',
    '.github/workflows/readiness-probe.yml',
    '.github/workflows/trainer-nightly.yml',
    'integrations/github-actions/gatetest-deploy-gate.yml',
  ];

  test('no blocking bash-safety findings in the audited deploy/CI paths', async () => {
    const r = makeResult();
    await new BashSafety().run(r, { projectRoot: REPO });
    const offenders = r.checks.filter((c) => {
      if (c.passed || c.severity !== 'error' || !c.file) return false;
      return GUARDED.includes(c.file.replace(/\\/g, '/'));
    });
    assert.equal(offenders.length, 0,
      `swallowed errors reintroduced:\n${offenders.map(o => `  ${o.name}`).join('\n')}`);
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

  // ── silent-success: EnvironmentFile=- on a scheduled job ────────────────────
  //
  // The mechanism, found 2026-08-26 on a protected platform: a nightly backup
  // unit reported Result=success for as long as its EnvironmentFile had been
  // missing, because the leading "-" made the absence invisible and the job
  // exited 0 on its own "nothing to do" path. No restorable backup existed.
  //
  // The negative controls carry as much weight as the positives. The "-" is a
  // common, legitimate idiom on long-running services; firing there would make
  // the rule noise, and noise gets suppressed, and a suppressed rule protects
  // nobody.
  const backupUnit = (opts) => `[Unit]
Description=Nightly backup
[Service]
Type=${opts.type}
EnvironmentFile=${opts.envFile}
ExecStart=/usr/bin/node backup.js
Restart=no
StandardOutput=journal
StandardError=journal
`;

  test('flags an optional EnvironmentFile on a oneshot job', async () => {
    const tmp = makeTmp();
    fs.mkdirSync(path.join(tmp, 'infra'));
    fs.writeFileSync(
      path.join(tmp, 'infra', 'backup.service'),
      backupUnit({ type: 'oneshot', envFile: '-/opt/vapron/.backup.env' })
    );
    const r = makeResult();
    await new Systemd().run(r, { projectRoot: tmp });
    const hit = r.checks.find(c => !c.passed && c.name.includes('silent-success'));
    assert(hit, 'oneshot + EnvironmentFile=- should flag');
    assert.equal(hit.severity, 'warning', 'unprovable from the repo — must not block a build');
    assert(hit.fix.includes('/opt/vapron/.backup.env'), 'names the env file');
    assert(hit.fix.includes('Type=oneshot'), 'names what made it scheduled');
    fs.rmSync(tmp, { recursive: true });
  });

  test('flags an optional EnvironmentFile on a timer-driven job', async () => {
    // Same danger, arrived at a different way: Type is unset, but a sibling
    // .timer means the unit runs to completion on a schedule.
    const tmp = makeTmp();
    fs.mkdirSync(path.join(tmp, 'infra'));
    fs.writeFileSync(
      path.join(tmp, 'infra', 'backup.service'),
      backupUnit({ type: 'simple', envFile: '-/etc/backup.env' })
    );
    fs.writeFileSync(path.join(tmp, 'infra', 'backup.timer'), '[Timer]\nOnCalendar=daily\n');
    const r = makeResult();
    await new Systemd().run(r, { projectRoot: tmp });
    const hit = r.checks.find(c => !c.passed && c.name.includes('silent-success'));
    assert(hit, 'sibling .timer + EnvironmentFile=- should flag');
    assert(hit.fix.includes('backup.timer'), 'names the timer that schedules it');
    fs.rmSync(tmp, { recursive: true });
  });

  test('NEGATIVE: does not flag an optional EnvironmentFile on a long-running service', async () => {
    // No timer, not oneshot. If the env file vanishes, the process starts
    // unconfigured and falls over — loudly. That is not a silent green.
    const tmp = makeTmp();
    fs.mkdirSync(path.join(tmp, 'infra'));
    fs.writeFileSync(
      path.join(tmp, 'infra', 'web.service'),
      backupUnit({ type: 'simple', envFile: '-/etc/web.env' })
    );
    const r = makeResult();
    await new Systemd().run(r, { projectRoot: tmp });
    assert(!r.checks.some(c => c.name.includes('silent-success')), 'must stay quiet on a plain service');
    fs.rmSync(tmp, { recursive: true });
  });

  test('NEGATIVE: does not flag a REQUIRED EnvironmentFile on a oneshot job', async () => {
    // No leading "-": systemd refuses to start the unit if the file is gone.
    // The failure is already loud, which is exactly what we are asking for.
    const tmp = makeTmp();
    fs.mkdirSync(path.join(tmp, 'infra'));
    fs.writeFileSync(
      path.join(tmp, 'infra', 'backup.service'),
      backupUnit({ type: 'oneshot', envFile: '/opt/vapron/.backup.env' })
    );
    const r = makeResult();
    await new Systemd().run(r, { projectRoot: tmp });
    assert(!r.checks.some(c => c.name.includes('silent-success')), 'a required EnvironmentFile is the fix, not the bug');
    fs.rmSync(tmp, { recursive: true });
  });

  test('reports only the optional entries when a unit mixes both', async () => {
    const tmp = makeTmp();
    fs.mkdirSync(path.join(tmp, 'infra'));
    fs.writeFileSync(path.join(tmp, 'infra', 'backup.service'), `[Unit]
Description=Nightly backup
[Service]
Type=oneshot
EnvironmentFile=/etc/required.env
EnvironmentFile=-/etc/optional.env
ExecStart=/usr/bin/node backup.js
Restart=no
StandardOutput=journal
StandardError=journal
`);
    const r = makeResult();
    await new Systemd().run(r, { projectRoot: tmp });
    const hit = r.checks.find(c => !c.passed && c.name.includes('silent-success'));
    assert(hit, 'the optional entry still creates the hole');
    assert(hit.fix.includes('/etc/optional.env'), 'names the optional one');
    assert(!hit.fix.includes('/etc/required.env'), 'must not blame the required one');
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

  // Control pair (self-scan 2026-09-16): docs/deploy/JARVIS-MCP-DEPLOY.md
  // flagged "rollback reuses the same health check" — the word "fallback" in
  // an unrelated prose sentence opened a bogus rollback block that swallowed
  // the whole doc, including its own smoke-test/verify curl commands
  // matching themselves. Docs are prose, not scripts with a rollback branch
  // to compare — scope the rule to executable scripts/workflows.
  test('POSITIVE CONTROL: a real script reusing the same health check in its rollback branch still fires', async () => {
    const tmp = makeTmp();
    fs.writeFileSync(path.join(tmp, 'deploy-rollback.sh'), `#!/bin/bash
set -euo pipefail
curl -s http://127.0.0.1:8787/healthz
git pull origin main || {
  echo "Deploy failed — rollback"
  curl -s http://127.0.0.1:8787/healthz
  exit 0
}
`);
    const r = makeResult();
    await new RollbackHonesty().run(r, { projectRoot: tmp });
    assert(
      r.checks.some((c) => !c.passed && c.name.includes('same-health-check')),
      'a real script reusing the same health check in its rollback branch should still fire',
    );
    fs.rmSync(tmp, { recursive: true });
  });

  test('does not treat a markdown runbook as a script with a rollback branch', async () => {
    const tmp = makeTmp();
    fs.writeFileSync(path.join(tmp, 'DEPLOY.md'), `# Deploy

> Not a fallback plan — this is the live path.

## Steps

\`\`\`bash
curl -s http://127.0.0.1:8787/healthz
\`\`\`

## Verify

\`\`\`bash
curl -s http://127.0.0.1:8787/healthz
\`\`\`
`);
    const r = makeResult();
    await new RollbackHonesty().run(r, { projectRoot: tmp });
    assert.equal(
      r.checks.filter((c) => !c.passed && c.severity === 'error').length,
      0,
      'a markdown runbook is prose, not an executable rollback branch',
    );
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
