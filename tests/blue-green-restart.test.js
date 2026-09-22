// =============================================================================
// blue-green-restart.sh — zero-downtime restart for pull-deploy.sh (issue #663)
// =============================================================================
// pull-deploy.sh used to restart the production service in place, so the
// reverse proxy answered 502 for a few seconds on every merge. This script
// starts the new build on the alternate port, waits for it to answer
// /api/platform-status with the new commit, hands off to a pluggable
// proxy-switch command, stops the old instance, then smoke-tests the public
// endpoint. See docs/deploy/PULL-DEPLOY.md "Blue/green" for why the actual
// proxy switch is a pluggable hook rather than a Caddy/nginx config —
// CLAUDE.md's Deployment Doctrine bans configuring either on this box (the
// real front door, tallrig-bun-gateway, is configured on the Tallrig side).
//
// Exercised for real under bash with stubbed `curl` and `systemctl` on PATH
// (same pattern as tests/pull-deploy.test.js and tests/deploy-recover.test.js)
// — never by reading the script as text — so the decision logic itself is
// under test: start new → poll health → switch → stop old → smoke, with the
// three failure modes the issue calls out.
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'deploy', 'blue-green-restart.sh');

const bashCheck = spawnSync('bash', ['--version'], { encoding: 'utf8' });
const HAVE_BASH = bashCheck.status === 0;
const SKIP = HAVE_BASH ? false : 'bash not available';

const HEALTH_HOST = '127.0.0.1';
const SMOKE_MARKER = 'smoke.invalid';

// A curl stand-in that tells health polls (URL containing HEALTH_HOST) apart
// from the public smoke poll (URL containing SMOKE_MARKER) by substring —
// the two URLs the script builds never overlap in a real run either (one is
// localhost:<port>, the other is the public hostname through the proxy).
const CURL_STUB = `#!/usr/bin/env bash
URL="\${@: -1}"
: "\${CURL_RECORD_FILE:?}"
echo "$URL" >> "$CURL_RECORD_FILE"
case "$URL" in
  *${HEALTH_HOST}*)
    COUNT_FILE="\${CURL_HEALTH_COUNT_FILE:?}"
    N=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)
    N=$((N + 1))
    echo "$N" > "$COUNT_FILE"
    if [ "\${CURL_NEVER_HEALTHY:-0}" = "1" ]; then
      echo '{"commit":"stale-commit"}'
    else
      echo "{\\"commit\\":\\"\${CURL_EXPECTED_COMMIT:-newsha}\\"}"
    fi
    ;;
  *${SMOKE_MARKER}*)
    printf '%s' "\${CURL_SMOKE_CODE:-200}"
    ;;
  *)
    echo "curl stub: unexpected URL $URL" >&2
    exit 1
    ;;
esac
`;

// A systemctl stand-in that records every invocation and can be told to fail
// a specific unit/verb combination.
const SYSTEMCTL_STUB = `#!/usr/bin/env bash
: "\${SYSTEMCTL_RECORD_FILE:?}"
echo "$*" >> "$SYSTEMCTL_RECORD_FILE"
VERB="$1"; UNIT="$2"
if [ "\${SYSTEMCTL_FAIL_VERB:-}" = "$VERB" ] && [ "\${SYSTEMCTL_FAIL_UNIT:-}" = "$UNIT" ]; then
  exit 1
fi
exit 0
`;

// A switch-proxy stand-in the test points PULL_DEPLOY_PROXY_SWITCH_CMD at,
// standing in for whatever mechanism a box eventually wires the real
// scripts/deploy/switch-proxy.sh hook to.
const SWITCH_STUB = `#!/usr/bin/env bash
: "\${SWITCH_RECORD_FILE:?}"
echo "switch to $1" >> "$SWITCH_RECORD_FILE"
if [ "\${SWITCH_SHOULD_FAIL:-0}" = "1" ]; then
  exit 1
fi
exit 0
`;

function writeStub(dir, name, contents) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, contents);
  fs.chmodSync(p, 0o755);
  return p;
}

function readLines(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
}

/**
 * Sets up a temp stub PATH (curl + systemctl) and temp state files, runs
 * blue-green-restart.sh with fast timeouts, and returns { result, files }.
 */
function run(envOverrides) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-bluegreen-'));
  const binDir = path.join(tmp, 'bin');
  fs.mkdirSync(binDir);
  writeStub(binDir, 'curl', CURL_STUB);
  writeStub(binDir, 'systemctl', SYSTEMCTL_STUB);
  const switchScript = writeStub(tmp, 'switch-proxy-stub.sh', SWITCH_STUB);

  const files = {
    curlRecord: path.join(tmp, 'curl-calls.log'),
    curlHealthCount: path.join(tmp, 'curl-health-count'),
    systemctlRecord: path.join(tmp, 'systemctl-calls.log'),
    switchRecord: path.join(tmp, 'switch-calls.log'),
    activePortFile: path.join(tmp, 'active-port'),
  };

  const env = {
    ...process.env,
    PATH: [binDir, process.env.PATH].join(path.delimiter),
    GATETEST_APP_DIR: tmp,
    PULL_DEPLOY_EXPECTED_COMMIT: 'newsha',
    GATETEST_WEB_HOST: HEALTH_HOST,
    GATETEST_WEB_PORT_A: '3000',
    GATETEST_WEB_PORT_B: '3001',
    PULL_DEPLOY_ACTIVE_PORT_FILE: files.activePortFile,
    PULL_DEPLOY_PROXY_SWITCH_CMD: switchScript,
    PULL_DEPLOY_SMOKE_URL: `http://${SMOKE_MARKER}/api/platform-status`,
    PULL_DEPLOY_HEALTH_TIMEOUT_S: '1',
    PULL_DEPLOY_HEALTH_INTERVAL_S: '0.2',
    PULL_DEPLOY_SMOKE_DURATION_S: '3',
    PULL_DEPLOY_SMOKE_INTERVAL_S: '0.1',
    CURL_RECORD_FILE: files.curlRecord,
    CURL_HEALTH_COUNT_FILE: files.curlHealthCount,
    CURL_EXPECTED_COMMIT: 'newsha',
    SYSTEMCTL_RECORD_FILE: files.systemctlRecord,
    SWITCH_RECORD_FILE: files.switchRecord,
    ...envOverrides,
  };

  const result = spawnSync('bash', [SCRIPT_PATH], { encoding: 'utf8', env, timeout: 20000 });
  return { result, files, tmp };
}

test('shell syntax: bash -n blue-green-restart.sh', { skip: SKIP }, () => {
  const r = spawnSync('bash', ['-n', SCRIPT_PATH], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('shell syntax: bash -n switch-proxy.sh', { skip: SKIP }, () => {
  const r = spawnSync('bash', ['-n', path.join(ROOT, 'scripts', 'deploy', 'switch-proxy.sh')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('shell syntax: bash -n pull-deploy.sh', { skip: SKIP }, () => {
  const r = spawnSync('bash', ['-n', path.join(ROOT, 'scripts', 'deploy', 'pull-deploy.sh')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('shell syntax: bash -n install-pull-deploy.sh', { skip: SKIP }, () => {
  const r = spawnSync('bash', ['-n', path.join(ROOT, 'scripts', 'deploy', 'install-pull-deploy.sh')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('new instance healthy: starts gatetest-web@3001, switches, stops gatetest-web@3000, exits 0', { skip: SKIP }, () => {
  const { result, files, tmp } = run({});
  try {
    assert.equal(result.status, 0, result.stderr);
    const systemctlCalls = readLines(files.systemctlRecord);
    assert.ok(systemctlCalls.some((l) => l === 'start gatetest-web@3001.service'), systemctlCalls.join('\n'));
    assert.ok(systemctlCalls.some((l) => l === 'stop gatetest-web@3000.service'), systemctlCalls.join('\n'));
    const switchCalls = readLines(files.switchRecord);
    assert.deepEqual(switchCalls, ['switch to 3001']);
    assert.equal(fs.readFileSync(files.activePortFile, 'utf8'), '3001');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('POSITIVE CONTROL: new instance never healthy — aborts, old still serving, exits non-zero', { skip: SKIP }, () => {
  const { result, files, tmp } = run({ CURL_NEVER_HEALTHY: '1' });
  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /never answered .* within/);
    const systemctlCalls = readLines(files.systemctlRecord);
    assert.ok(systemctlCalls.some((l) => l === 'start gatetest-web@3001.service'), systemctlCalls.join('\n'));
    // cleanup stops the new (unhealthy) instance...
    assert.ok(systemctlCalls.some((l) => l === 'stop gatetest-web@3001.service'), systemctlCalls.join('\n'));
    // ...but the old instance is NEVER touched — it stays live.
    assert.ok(!systemctlCalls.some((l) => l === 'stop gatetest-web@3000.service'), systemctlCalls.join('\n'));
    assert.deepEqual(readLines(files.switchRecord), []);
    assert.ok(!fs.existsSync(files.activePortFile) || fs.readFileSync(files.activePortFile, 'utf8') !== '3001');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('negative control: same setup but healthy immediately — proves the timeout case above is the guard, not a stub artifact', { skip: SKIP }, () => {
  const { result, tmp } = run({});
  try {
    assert.equal(result.status, 0, result.stderr);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('proxy switch command fails: aborts, old still serving, exits non-zero', { skip: SKIP }, () => {
  const { result, files, tmp } = run({ SWITCH_SHOULD_FAIL: '1' });
  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /proxy switch command failed/);
    const systemctlCalls = readLines(files.systemctlRecord);
    assert.ok(!systemctlCalls.some((l) => l === 'stop gatetest-web@3000.service'), systemctlCalls.join('\n'));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('POSITIVE CONTROL: post-switch smoke sees a 502 — exits non-zero even though the switch already happened', { skip: SKIP }, () => {
  const { result, files, tmp } = run({ CURL_SMOKE_CODE: '502' });
  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /returned HTTP 502/);
    // the switch and old-instance stop already happened by the time smoke runs
    const systemctlCalls = readLines(files.systemctlRecord);
    assert.ok(systemctlCalls.some((l) => l === 'stop gatetest-web@3000.service'), systemctlCalls.join('\n'));
    assert.deepEqual(readLines(files.switchRecord), ['switch to 3001']);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('negative control: smoke all-200 exits 0 (same path as the 502 case above minus the failure)', { skip: SKIP }, () => {
  const { result, tmp } = run({ CURL_SMOKE_CODE: '200' });
  try {
    assert.equal(result.status, 0, result.stderr);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('active-port file flips the roles: second run promotes 3000 back over 3001', { skip: SKIP }, () => {
  const first = run({});
  try {
    assert.equal(first.result.status, 0, first.result.stderr);
    assert.equal(fs.readFileSync(first.files.activePortFile, 'utf8'), '3001');

    // Second run reuses the same active-port file (now "3001") — the new
    // target must be 3000.
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-bluegreen-'));
    const binDir2 = path.join(tmp2, 'bin');
    fs.mkdirSync(binDir2);
    writeStub(binDir2, 'curl', CURL_STUB);
    writeStub(binDir2, 'systemctl', SYSTEMCTL_STUB);
    const switchScript2 = writeStub(tmp2, 'switch-proxy-stub.sh', SWITCH_STUB);
    const systemctlRecord2 = path.join(tmp2, 'systemctl-calls.log');
    const switchRecord2 = path.join(tmp2, 'switch-calls.log');
    fs.copyFileSync(first.files.activePortFile, path.join(tmp2, 'active-port'));
    const env2 = {
      ...process.env,
      PATH: [binDir2, process.env.PATH].join(path.delimiter),
      GATETEST_APP_DIR: tmp2,
      PULL_DEPLOY_EXPECTED_COMMIT: 'newsha2',
      GATETEST_WEB_HOST: HEALTH_HOST,
      GATETEST_WEB_PORT_A: '3000',
      GATETEST_WEB_PORT_B: '3001',
      PULL_DEPLOY_ACTIVE_PORT_FILE: path.join(tmp2, 'active-port'),
      PULL_DEPLOY_PROXY_SWITCH_CMD: switchScript2,
      PULL_DEPLOY_SMOKE_URL: `http://${SMOKE_MARKER}/api/platform-status`,
      PULL_DEPLOY_HEALTH_TIMEOUT_S: '1',
      PULL_DEPLOY_HEALTH_INTERVAL_S: '0.2',
      PULL_DEPLOY_SMOKE_DURATION_S: '3',
      PULL_DEPLOY_SMOKE_INTERVAL_S: '0.1',
      CURL_RECORD_FILE: path.join(tmp2, 'curl-calls.log'),
      CURL_HEALTH_COUNT_FILE: path.join(tmp2, 'curl-health-count'),
      CURL_EXPECTED_COMMIT: 'newsha2',
      SYSTEMCTL_RECORD_FILE: systemctlRecord2,
      SWITCH_RECORD_FILE: switchRecord2,
    };
    const second = spawnSync('bash', [SCRIPT_PATH], { encoding: 'utf8', env: env2, timeout: 20000 });
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(readLines(switchRecord2), ['switch to 3000']);
    assert.equal(fs.readFileSync(path.join(tmp2, 'active-port'), 'utf8'), '3000');
    fs.rmSync(tmp2, { recursive: true, force: true });
  } finally { fs.rmSync(first.tmp, { recursive: true, force: true }); }
});

test('PULL_DEPLOY_INPLACE=1: restarts the single fixed unit instead of blue/green', { skip: SKIP }, () => {
  const { result, files, tmp } = run({ PULL_DEPLOY_INPLACE: '1' });
  try {
    assert.equal(result.status, 0, result.stderr);
    const systemctlCalls = readLines(files.systemctlRecord);
    assert.deepEqual(systemctlCalls, ['restart gatetest-web']);
    assert.deepEqual(readLines(files.switchRecord), []);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('switch-proxy.sh refuses on purpose (no proxy mechanism configured) and names the reason', { skip: SKIP }, () => {
  const r = spawnSync('bash', [path.join(ROOT, 'scripts', 'deploy', 'switch-proxy.sh'), '3001'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no proxy-switch mechanism is configured/);
  assert.match(r.stderr, /tallrig-bun-gateway/);
});

test('pull-deploy.sh wires blue-green-restart.sh as GATETEST_RESTART_CMD unless PULL_DEPLOY_INPLACE=1', () => {
  const script = fs.readFileSync(path.join(ROOT, 'scripts', 'deploy', 'pull-deploy.sh'), 'utf8');
  assert.match(script, /GATETEST_RESTART_CMD="\$APP_DIR\/scripts\/deploy\/blue-green-restart\.sh"/);
  assert.match(script, /PULL_DEPLOY_EXPECTED_COMMIT="\$AFTER"/);
  assert.match(script, /if \[ "\$\{PULL_DEPLOY_INPLACE:-0\}" = "1" \]/);
});

test('gatetest-web@.service is a systemd template bound to the port instance name', () => {
  const unit = fs.readFileSync(path.join(ROOT, 'scripts', 'deploy', 'systemd', 'gatetest-web@.service'), 'utf8');
  assert.match(unit, /ExecStart=.*-p %i/);
  assert.match(unit, /^\[Service\]$/m);
});

test('install-pull-deploy.sh installs the blue/green template + scripts idempotently', { skip: SKIP }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-install-'));
  try {
    const appDir = path.join(tmp, 'opt-gatetest');
    fs.mkdirSync(path.join(appDir, 'scripts', 'deploy', 'systemd'), { recursive: true });
    for (const f of ['pull-deploy.sh', 'blue-green-restart.sh', 'switch-proxy.sh', 'install-pull-deploy.sh']) {
      fs.copyFileSync(path.join(ROOT, 'scripts', 'deploy', f), path.join(appDir, 'scripts', 'deploy', f));
    }
    for (const f of ['gatetest-pull-deploy.service', 'gatetest-pull-deploy.timer', 'gatetest-web@.service']) {
      fs.copyFileSync(path.join(ROOT, 'scripts', 'deploy', 'systemd', f), path.join(appDir, 'scripts', 'deploy', 'systemd', f));
    }

    const binDir = path.join(tmp, 'bin');
    fs.mkdirSync(binDir);
    const etcDir = path.join(tmp, 'etc-systemd-system');
    fs.mkdirSync(etcDir);
    const idPath = writeStub(binDir, 'id', '#!/usr/bin/env bash\necho 0\n');
    void idPath;
    const systemctlRecord = path.join(tmp, 'systemctl-calls.log');
    writeStub(binDir, 'systemctl', SYSTEMCTL_STUB);
    // install-pull-deploy.sh hardcodes /etc/systemd/system — redirect cp's
    // destination is not possible without root, so this test only proves the
    // file-presence + chmod + daemon-reload/enable sequence up to that copy
    // by running it against a throwaway APP_DIR and accepting the real `cp`
    // to /etc/systemd/system would need root; instead assert the script's
    // own preflight (file checks, chmod) succeeds and it reaches systemctl.
    const r = spawnSync('bash', [path.join(appDir, 'scripts', 'deploy', 'install-pull-deploy.sh')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: [binDir, process.env.PATH].join(path.delimiter),
        GATETEST_APP_DIR: appDir,
        SYSTEMCTL_RECORD_FILE: systemctlRecord,
      },
    });
    // Without real root + /etc/systemd/system this either succeeds (running
    // as root in CI) or fails on `cp ... /etc/systemd/system/` — either way
    // it must get PAST the file-presence check added for the blue/green
    // files, i.e. never with "expected file not found".
    assert.doesNotMatch(r.stderr || '', /expected file not found/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
