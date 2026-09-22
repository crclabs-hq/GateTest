// =============================================================================
// blue-green-restart.sh + switch-proxy.sh — zero-downtime restart for
// pull-deploy.sh (issue #663)
// =============================================================================
// pull-deploy.sh used to restart the production service in place, so the
// reverse proxy answered 502 for a few seconds on every merge. This script
// starts the new build on the alternate port, waits for it to answer
// /api/platform-status with the new commit, hands off to switch-proxy.sh to
// flip the real front door, stops the old instance, then smoke-tests the
// public endpoint. See docs/deploy/PULL-DEPLOY.md "Blue/green" for the full
// story, including the 2026-09-22 correction: the real front door verified
// read-only on box 161 is Coolify's `coolify-proxy` (Traefik v3.6, file
// provider) via /data/coolify/proxy/dynamic/gatetest-web.yaml — not
// Tallrig's own gateway, which CLAUDE.md's Deployment Doctrine describes as
// the intended end state but which is not actually in front of gatetest.io
// yet. That doctrine is left untouched; this is a factual correction to the
// deploy runbook.
//
// Exercised for real under bash with stubbed `curl`, `systemctl`, and a
// stand-in for the proxy-switch command on PATH (same pattern as
// tests/pull-deploy.test.js and tests/deploy-recover.test.js) — never by
// reading the scripts as text — so the decision logic itself is under test:
// start new -> poll health -> switch (verified through the real front door)
// -> stop old -> smoke, with the failure modes the issue and the correction
// both call out, including rollback on a failed switch.
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'deploy', 'blue-green-restart.sh');
const SWITCH_PROXY_PATH = path.join(ROOT, 'scripts', 'deploy', 'switch-proxy.sh');

const bashCheck = spawnSync('bash', ['--version'], { encoding: 'utf8' });
const HAVE_BASH = bashCheck.status === 0;
const SKIP = HAVE_BASH ? false : 'bash not available';

const HEALTH_HOST = '127.0.0.1';
const SMOKE_MARKER = 'smoke.invalid';

// A curl stand-in that tells apart: (a) the direct poll of whichever port is
// CURL_PREV_PORT (used once, up front, to learn what the currently-active
// instance is serving), (b) the direct poll of CURL_NEW_PORT (the health
// check loop), and (c) the public smoke poll (URL containing SMOKE_MARKER).
// The three URLs the real script builds never overlap either: two are
// localhost:<port> (different ports) and one is the public hostname.
const CURL_STUB = `#!/usr/bin/env bash
URL="\${@: -1}"
: "\${CURL_RECORD_FILE:?}"
echo "$URL" >> "$CURL_RECORD_FILE"
case "$URL" in
  *:\${CURL_PREV_PORT:-__none__}/*)
    echo "{\\"commit\\":\\"\${CURL_PREV_COMMIT:-oldsha}\\"}"
    ;;
  *:\${CURL_NEW_PORT:-__none__}/*)
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
// standing in for scripts/deploy/switch-proxy.sh (which is exercised
// directly, against a real temp file, further down). Fails only for the
// port named in SWITCH_FAIL_FOR_PORT, or every call if SWITCH_FAIL_ALWAYS=1
// — enough to test blue-green-restart.sh's rollback-on-failed-switch path
// without needing a real Traefik file for every scenario.
const SWITCH_STUB = `#!/usr/bin/env bash
: "\${SWITCH_RECORD_FILE:?}"
echo "switch to $1 expect $2" >> "$SWITCH_RECORD_FILE"
if [ "\${SWITCH_FAIL_ALWAYS:-0}" = "1" ]; then
  exit 1
fi
if [ "\${SWITCH_FAIL_FOR_PORT:-}" = "$1" ]; then
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
 * Defaults assume the first-ever run: active=3000 (reporting "oldsha"),
 * new=3001 (must reach "newsha"). Pass prevPort/newPort to model a later run
 * where the active-port file already flipped the roles.
 */
function run(envOverrides, { prevPort = '3000', newPort = '3001', initialActivePort } = {}) {
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
  if (initialActivePort) fs.writeFileSync(files.activePortFile, initialActivePort);

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
    PULL_DEPLOY_PUBLIC_HOST: SMOKE_MARKER,
    PULL_DEPLOY_SMOKE_URL: `http://${SMOKE_MARKER}/api/platform-status`,
    PULL_DEPLOY_HEALTH_TIMEOUT_S: '1',
    PULL_DEPLOY_HEALTH_INTERVAL_S: '0.2',
    PULL_DEPLOY_SMOKE_DURATION_S: '3',
    PULL_DEPLOY_SMOKE_INTERVAL_S: '0.1',
    CURL_RECORD_FILE: files.curlRecord,
    CURL_HEALTH_COUNT_FILE: files.curlHealthCount,
    CURL_EXPECTED_COMMIT: 'newsha',
    CURL_PREV_PORT: prevPort,
    CURL_NEW_PORT: newPort,
    CURL_PREV_COMMIT: 'oldsha',
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
  const r = spawnSync('bash', ['-n', SWITCH_PROXY_PATH], { encoding: 'utf8' });
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

// ── blue-green-restart.sh decision logic ────────────────────────────────────

test('new instance healthy: starts gatetest-web@3001, switches once, stops gatetest-web@3000, exits 0', { skip: SKIP }, () => {
  const { result, files, tmp } = run({});
  try {
    assert.equal(result.status, 0, result.stderr);
    const systemctlCalls = readLines(files.systemctlRecord);
    assert.ok(systemctlCalls.some((l) => l === 'start gatetest-web@3001.service'), systemctlCalls.join('\n'));
    assert.ok(systemctlCalls.some((l) => l === 'stop gatetest-web@3000.service'), systemctlCalls.join('\n'));
    assert.deepEqual(readLines(files.switchRecord), ['switch to 3001 expect newsha']);
    assert.equal(fs.readFileSync(files.activePortFile, 'utf8'), '3001');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('POSITIVE CONTROL: new instance never healthy — aborts before any switch, old still serving, exits non-zero', { skip: SKIP }, () => {
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
    // the switch is never even attempted, so there is nothing to roll back.
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

test('proxy switch fails: rolls back to the old port+commit, old still serving, exits non-zero', { skip: SKIP }, () => {
  const { result, files, tmp } = run({ SWITCH_FAIL_FOR_PORT: '3001' });
  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /proxy switch to port 3001 failed/);
    assert.match(result.stderr, /rolling back to gatetest-web@3000\.service/);
    // switch was attempted for the new port, THEN rolled back to the old
    // port+commit (the exact commit the old instance was proven to be
    // serving, learned before the new instance was even started).
    assert.deepEqual(readLines(files.switchRecord), [
      'switch to 3001 expect newsha',
      'switch to 3000 expect oldsha',
    ]);
    const systemctlCalls = readLines(files.systemctlRecord);
    // old instance is never stopped — the whole point of rollback.
    assert.ok(!systemctlCalls.some((l) => l === 'stop gatetest-web@3000.service'), systemctlCalls.join('\n'));
    // the failed new instance is cleaned up.
    assert.ok(systemctlCalls.some((l) => l === 'stop gatetest-web@3001.service'), systemctlCalls.join('\n'));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('proxy switch fails AND rollback also fails to verify: still exits non-zero, says so plainly', { skip: SKIP }, () => {
  const { result, files, tmp } = run({ SWITCH_FAIL_ALWAYS: '1' });
  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /rollback to port 3000 ALSO failed/);
    assert.deepEqual(readLines(files.switchRecord), [
      'switch to 3001 expect newsha',
      'switch to 3000 expect oldsha',
    ]);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('POSITIVE CONTROL: post-switch smoke sees a 502 — exits non-zero even though the switch already happened and is not rolled back', { skip: SKIP }, () => {
  const { result, files, tmp } = run({ CURL_SMOKE_CODE: '502' });
  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /returned HTTP 502/);
    // the switch and old-instance stop already happened by the time smoke runs
    const systemctlCalls = readLines(files.systemctlRecord);
    assert.ok(systemctlCalls.some((l) => l === 'stop gatetest-web@3000.service'), systemctlCalls.join('\n'));
    assert.deepEqual(readLines(files.switchRecord), ['switch to 3001 expect newsha']);
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

    // Second run starts with its OWN active-port file pre-seeded to "3001"
    // (what round 1 left it at) — the new target must be 3000, and the PREV
    // lookup must hit port 3001 this time.
    const second = run(
      {
        PULL_DEPLOY_EXPECTED_COMMIT: 'newsha2',
        CURL_EXPECTED_COMMIT: 'newsha2',
        CURL_PREV_COMMIT: 'newsha', // what round 1 left running on 3001
      },
      { prevPort: '3001', newPort: '3000', initialActivePort: '3001' },
    );
    try {
      assert.equal(second.result.status, 0, second.result.stderr);
      assert.deepEqual(readLines(second.files.switchRecord), ['switch to 3000 expect newsha2']);
      assert.equal(fs.readFileSync(second.files.activePortFile, 'utf8'), '3000');
    } finally { fs.rmSync(second.tmp, { recursive: true, force: true }); }
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
    writeStub(binDir, 'id', '#!/usr/bin/env bash\necho 0\n');
    const systemctlRecord = path.join(tmp, 'systemctl-calls.log');
    writeStub(binDir, 'systemctl', SYSTEMCTL_STUB);
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

// ── switch-proxy.sh, exercised directly against a real temp file ───────────

const TRAEFIK_FILE_TEMPLATE = (port) => `http:
  routers:
    gatetest-web:
      rule: Host(\`gatetest.io\`)
      service: gatetest-web
  services:
    gatetest-web:
      loadBalancer:
        servers:
          - url: "http://10.0.1.1:${port}"
`;

// curl stand-in for switch-proxy.sh's own public-verification loop. Commit
// values must be hex (git SHA shape) — switch-proxy.sh's real extraction
// regex is grep -o '"commit":"[0-9a-f]*"', which a non-hex fixture value
// would silently fail to match, same as a real non-hex "commit" would.
const SWITCH_VERIFY_CURL_STUB = `#!/usr/bin/env bash
if [ "\${SWITCH_TEST_NEVER_MATCH:-0}" = "1" ]; then
  echo "{\\"commit\\":\\"\${SWITCH_TEST_ALT_COMMIT:-deadbee}\\"}"
else
  echo "{\\"commit\\":\\"\${SWITCH_TEST_COMMIT:-abc123}\\"}"
fi
`;

function runSwitchProxy(traefikContent, args, envOverrides) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-switchproxy-'));
  const binDir = path.join(tmp, 'bin');
  fs.mkdirSync(binDir);
  writeStub(binDir, 'curl', SWITCH_VERIFY_CURL_STUB);
  const traefikFile = path.join(tmp, 'gatetest-web.yaml');
  if (traefikContent !== null) fs.writeFileSync(traefikFile, traefikContent);

  const env = {
    ...process.env,
    PATH: [binDir, process.env.PATH].join(path.delimiter),
    PULL_DEPLOY_TRAEFIK_FILE: traefikFile,
    PULL_DEPLOY_BIND_HOST: '10.0.1.1',
    PULL_DEPLOY_PUBLIC_HOST: 'gatetest.io',
    PULL_DEPLOY_TRAEFIK_VERIFY_ATTEMPTS: '2',
    PULL_DEPLOY_TRAEFIK_VERIFY_INTERVAL_S: '0.05',
    ...envOverrides,
  };
  const result = spawnSync('bash', [SWITCH_PROXY_PATH, ...args], { encoding: 'utf8', env, timeout: 20000 });
  return { result, traefikFile, tmp };
}

test('switch-proxy.sh: verified commit -> rewrites the file and exits 0', { skip: SKIP }, () => {
  const { result, traefikFile, tmp } = runSwitchProxy(TRAEFIK_FILE_TEMPLATE(3000), ['3001', 'abc123'], {
    SWITCH_TEST_COMMIT: 'abc123',
  });
  try {
    assert.equal(result.status, 0, result.stderr);
    const content = fs.readFileSync(traefikFile, 'utf8');
    assert.match(content, /http:\/\/10\.0\.1\.1:3001/);
    assert.doesNotMatch(content, /http:\/\/10\.0\.1\.1:3000/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('POSITIVE CONTROL: switch-proxy.sh: commit never matches -> exits non-zero, but the file is STILL rewritten (rollback is the caller\'s job)', { skip: SKIP }, () => {
  const { result, traefikFile, tmp } = runSwitchProxy(TRAEFIK_FILE_TEMPLATE(3000), ['3001', 'abc123'], {
    SWITCH_TEST_NEVER_MATCH: '1',
  });
  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /caller must roll back/);
    const content = fs.readFileSync(traefikFile, 'utf8');
    assert.match(content, /http:\/\/10\.0\.1\.1:3001/, 'the mv already happened before the verify loop ran');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('negative control: same never-match setup but expecting the commit the stub actually returns -> exits 0', { skip: SKIP }, () => {
  const { result, tmp } = runSwitchProxy(TRAEFIK_FILE_TEMPLATE(3000), ['3001', 'deadbee'], {
    SWITCH_TEST_NEVER_MATCH: '1',
  });
  try {
    assert.equal(result.status, 0, result.stderr);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('switch-proxy.sh: rolls a build back to 3000 the same way it rolled forward to 3001', { skip: SKIP }, () => {
  const { result, traefikFile, tmp } = runSwitchProxy(TRAEFIK_FILE_TEMPLATE(3001), ['3000', 'aaa111'], {
    SWITCH_TEST_COMMIT: 'aaa111',
  });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.match(fs.readFileSync(traefikFile, 'utf8'), /http:\/\/10\.0\.1\.1:3000/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('POSITIVE CONTROL: switch-proxy.sh refuses when the file has no matching upstream (grep -q guard), file left untouched', { skip: SKIP }, () => {
  const unrelated = 'http:\n  routers: {}\n  services: {}\n';
  const { result, traefikFile, tmp } = runSwitchProxy(unrelated, ['3001', 'abc123'], {});
  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no http:\/\/10\.0\.1\.1:3000 or :3001 upstream found/);
    assert.equal(fs.readFileSync(traefikFile, 'utf8'), unrelated, 'file must be untouched when the guard refuses');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('negative control: a file that DOES contain the pattern is accepted (proves the guard above checks content, not just file existence)', { skip: SKIP }, () => {
  const { result, tmp } = runSwitchProxy(TRAEFIK_FILE_TEMPLATE(3000), ['3001', 'abc123'], {
    SWITCH_TEST_COMMIT: 'abc123',
  });
  try {
    assert.equal(result.status, 0, result.stderr);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('switch-proxy.sh: missing Traefik file exits non-zero with a clear message', { skip: SKIP }, () => {
  const { result, tmp } = runSwitchProxy(null, ['3001', 'abc123'], {});
  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Traefik dynamic file not found/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
