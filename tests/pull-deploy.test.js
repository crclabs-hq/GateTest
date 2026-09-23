// =============================================================================
// pull-deploy.sh — the box deploys itself; nothing inbound (docs/deploy/PULL-DEPLOY.md)
// =============================================================================
// Box 161 closed public SSH (port 22) on 2026-09-16, so deploy-box.yml can no
// longer SSH a deploy onto the box. pull-deploy.sh replaces that: a systemd
// timer on the box runs it every 5 minutes, and it deploys itself from
// origin/main when it has moved.
//
// Run for real under bash against a throwaway origin + box repo — same
// pattern as tests/deploy-recover.test.js. The real deploy script builds the
// website, so origin/main here carries a STUB scripts/deploy/deploy-on-box.sh
// that records its invocation instead.
//
// Box 161 hosts other products, so "whoever can push to main is root on the
// box" is the threat this script defends against: it refuses to run anything
// piped from git unless (a) `origin` is the expected repository and (b)
// origin/main is a fast-forward of what is already deployed. Both guards get
// their own control pair below.
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'deploy', 'pull-deploy.sh');
const bashCheck = spawnSync('bash', ['--version'], { encoding: 'utf8' });
const HAVE_BASH = bashCheck.status === 0;
// flock (util-linux) is what pull-deploy.sh uses to serialize ticks — real on
// every Linux box and on GitHub's ubuntu-latest runners, but absent from Git
// for Windows, which this repo is also authored and tested on. Skip with a
// reason rather than pass vacuously: without flock, `flock -n 200` itself
// fails with "command not found", which pull-deploy.sh's `if ! flock -n 200`
// guard cannot tell apart from a real held lock — every test would silently
// exercise the wrong branch instead of the deploy path it is supposed to.
const flockCheck = HAVE_BASH ? spawnSync('bash', ['-c', 'command -v flock'], { encoding: 'utf8' }) : { status: 1 };
const HAVE_FLOCK = flockCheck.status === 0;
const SKIP_REAL_RUN = !HAVE_BASH ? 'bash not available' : (!HAVE_FLOCK ? 'flock not available (Linux/util-linux only — this box cannot exercise the real deploy path)' : false);

const NEW_STUB = `#!/usr/bin/env bash
set -euo pipefail
: "\${STUB_RECORD_FILE:?STUB_RECORD_FILE not set}"
{
  echo "GATETEST_APP_DIR=\${GATETEST_APP_DIR:-}"
  echo "DEPLOY_RECOVER=\${DEPLOY_RECOVER:-<unset>}"
} > "$STUB_RECORD_FILE"
if [ "\${STUB_EXIT:-0}" != "0" ]; then
  exit "\${STUB_EXIT}"
fi
git fetch origin main
git reset --hard origin/main
exit 0
`;

const OLD_STUB = `#!/usr/bin/env bash
# The box's OWN stale copy — pull-deploy.sh must never run this one. If it
# ever does, the marker file below proves it.
echo "OLD STUB RAN — pull-deploy used the box's stale copy, not origin/main" > "\${OLD_STUB_MARKER:?}"
exit 42
`;

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * origin (bare) at v1 with OLD_STUB, box cloned from it (so the box's own
 * on-disk copy of deploy-on-box.sh is OLD_STUB). Returns paths + helpers;
 * `advance()` pushes v2 with NEW_STUB onto origin so the box is one commit
 * behind with a fast-forward available.
 */
function makeBoxAtV1() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-pull-deploy-'));
  const origin = path.join(tmp, 'origin.git');
  const box = path.join(tmp, 'box');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  git(tmp, 'clone', '-q', origin, box);
  git(box, 'config', 'user.email', 't@example.invalid');
  git(box, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(box, 'scripts', 'deploy'), { recursive: true });
  fs.writeFileSync(path.join(box, 'app.txt'), 'v1\n');
  fs.writeFileSync(path.join(box, 'scripts', 'deploy', 'deploy-on-box.sh'), OLD_STUB);
  git(box, 'add', '-A');
  git(box, 'commit', '-q', '-m', 'v1');
  git(box, 'push', '-q', 'origin', 'main');
  const originUrl = git(box, 'remote', 'get-url', 'origin');
  return { tmp, box, origin, originUrl };
}

/** Push a v2 commit onto origin: app.txt changes, deploy-on-box.sh becomes NEW_STUB. Fast-forward from v1. */
function advanceOriginLinear(tmp, origin) {
  const up = path.join(tmp, 'up-linear');
  git(tmp, 'clone', '-q', origin, up);
  git(up, 'config', 'user.email', 't@example.invalid');
  git(up, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(up, 'scripts', 'deploy'), { recursive: true });
  fs.writeFileSync(path.join(up, 'app.txt'), 'v2\n');
  fs.writeFileSync(path.join(up, 'scripts', 'deploy', 'deploy-on-box.sh'), NEW_STUB);
  git(up, 'add', '-A');
  git(up, 'commit', '-q', '-m', 'v2');
  git(up, 'push', '-q', 'origin', 'main');
  return git(up, 'rev-parse', 'HEAD');
}

/** Rewrite origin's history so the box's v1 is NOT an ancestor of the new tip (force-push simulation). */
function rewriteOriginHistory(tmp, origin) {
  const up = path.join(tmp, 'up-rewrite');
  git(tmp, 'clone', '-q', origin, up);
  git(up, 'config', 'user.email', 't@example.invalid');
  git(up, 'config', 'user.name', 't');
  // Amending the sole (root) commit produces an unrelated SHA — no ancestry
  // link to the box's v1, exactly like a force-pushed / rebased main.
  fs.writeFileSync(path.join(up, 'app.txt'), 'v1-rewritten\n');
  git(up, 'add', '-A');
  git(up, 'commit', '-q', '--amend', '-m', 'v1 rewritten (force-push simulation)');
  git(up, 'push', '-q', '--force', 'origin', 'main');
  return git(up, 'rev-parse', 'HEAD');
}

function envFor(box, tmp, extra) {
  const statusFile = path.join(tmp, 'status.json');
  const lockFile = path.join(tmp, 'pull-deploy.lock');
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  return {
    env: {
      ...process.env,
      GATETEST_APP_DIR: box,
      PULL_DEPLOY_STATUS_FILE: statusFile,
      PULL_DEPLOY_LOCK: lockFile,
      ...extra,
    },
    statusFile,
    lockFile,
  };
}

function run(box, tmp, extra = {}) {
  const { env, statusFile, lockFile } = envFor(box, tmp, extra);
  const r = spawnSync('bash', [SCRIPT_PATH], { cwd: box, encoding: 'utf8', env });
  return { r, statusFile, lockFile };
}

function readStatus(statusFile) {
  return JSON.parse(fs.readFileSync(statusFile, 'utf8'));
}

// ── up to date: one fetch, no build ─────────────────────────────────────────

test('up to date: no deploy runs, exits 0, status "up-to-date"', { skip: SKIP_REAL_RUN }, () => {
  const { tmp, box, originUrl } = makeBoxAtV1();
  try {
    const recordFile = path.join(tmp, 'stub-record.txt');
    const { r, statusFile } = run(box, tmp, {
      PULL_DEPLOY_EXPECTED_ORIGIN: originUrl,
      STUB_RECORD_FILE: recordFile,
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /up to date at/);
    assert.equal(fs.existsSync(recordFile), false, 'the stub must never run when already up to date');
    const status = readStatus(statusFile);
    assert.equal(status.result, 'up-to-date');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// deploy-on-box.sh's own build dirties exactly these tracked files on every
// real deploy (SELF_DIRTIED in that script) — confirmed on box 161 after the
// 2026-09-19 15:02Z DEPLOY_RECOVER=1 recovery deploy. pull-deploy.sh's
// up-to-date fast path must judge "up to date" purely by comparing commits
// (HEAD vs origin/main), never by working-tree cleanliness — that judgement
// belongs to deploy-on-box.sh's own SELF_DIRTIED guard, which only runs when
// there is actually something to deploy.
const SELF_DIRTIED_FILES = [
  'package-lock.json',
  'website/app/data/build-info.json',
  'website/app/data/changelog.json',
  'website/package-lock.json',
];

test('up to date with the deploy script\'s own dirty files present (build-info.json, changelog.json, package-lock.json x2): still "up-to-date", no deploy run', { skip: SKIP_REAL_RUN }, () => {
  const { tmp, box, originUrl } = makeBoxAtV1();
  try {
    for (const rel of SELF_DIRTIED_FILES) {
      const abs = path.join(box, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, 'committed placeholder\n');
    }
    git(box, 'add', '-A');
    git(box, 'commit', '-q', '-m', 'track the self-dirtied files');
    git(box, 'push', '-q', 'origin', 'main');
    // Now dirty them exactly the way a real deploy just did — uncommitted,
    // origin/main NOT advanced any further.
    for (const rel of SELF_DIRTIED_FILES) {
      fs.writeFileSync(path.join(box, ...rel.split('/')), `stamped by a deploy, ${Date.now()}\n`);
    }
    const dirty = git(box, 'status', '--porcelain');
    assert.notEqual(dirty, '', 'the self-dirtied files must actually be dirty for this test to mean anything');

    const recordFile = path.join(tmp, 'stub-record.txt');
    const { r, statusFile } = run(box, tmp, {
      PULL_DEPLOY_EXPECTED_ORIGIN: originUrl,
      STUB_RECORD_FILE: recordFile,
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /up to date at/);
    assert.equal(fs.existsSync(recordFile), false, 'a dirty SELF_DIRTIED tree must never be treated as "not up to date"');
    assert.equal(readStatus(statusFile).result, 'up-to-date');
    // The dirty files are untouched — pull-deploy's fast path must not reset or clean anything.
    assert.notEqual(git(box, 'status', '--porcelain'), '', 'the up-to-date path must not touch the working tree');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ── origin ahead: deploys from ORIGIN's copy, never the box's stale one ─────

test('origin ahead: runs the script from origin (not the box\'s stale copy) exactly once, status "deployed", DEPLOY_RECOVER never set', { skip: SKIP_REAL_RUN }, () => {
  const { tmp, box, origin, originUrl } = makeBoxAtV1();
  try {
    const newTip = advanceOriginLinear(tmp, origin);
    const recordFile = path.join(tmp, 'stub-record.txt');
    const oldMarker = path.join(tmp, 'old-stub-marker.txt');
    const { r, statusFile } = run(box, tmp, {
      PULL_DEPLOY_EXPECTED_ORIGIN: originUrl,
      STUB_RECORD_FILE: recordFile,
      OLD_STUB_MARKER: oldMarker,
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(fs.existsSync(oldMarker), false, 'the box\'s own stale deploy-on-box.sh must never run');
    assert.equal(fs.existsSync(recordFile), true, 'origin\'s stub must have run exactly once');
    const record = fs.readFileSync(recordFile, 'utf8');
    assert.match(record, new RegExp(`GATETEST_APP_DIR=${box.replace(/\\/g, '\\\\')}`));
    assert.match(record, /DEPLOY_RECOVER=(<unset>|0)$/m, 'pull-deploy.sh must never set DEPLOY_RECOVER');
    assert.doesNotMatch(record, /DEPLOY_RECOVER=1/);
    const status = readStatus(statusFile);
    assert.equal(status.result, 'deployed');
    assert.equal(status.after, newTip);
    assert.equal(git(box, 'rev-parse', 'HEAD'), newTip, 'the box must end on the new origin/main tip');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ── the deploy script's own failure propagates ──────────────────────────────

test('stub exits 3: pull-deploy exits 3, status "failed"', { skip: SKIP_REAL_RUN }, () => {
  const { tmp, box, origin, originUrl } = makeBoxAtV1();
  try {
    advanceOriginLinear(tmp, origin);
    const recordFile = path.join(tmp, 'stub-record.txt');
    const { r, statusFile } = run(box, tmp, {
      PULL_DEPLOY_EXPECTED_ORIGIN: originUrl,
      STUB_RECORD_FILE: recordFile,
      STUB_EXIT: '3',
    });
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.equal(fs.existsSync(recordFile), true, 'the stub must still have run and recorded its invocation');
    const status = readStatus(statusFile);
    assert.equal(status.result, 'failed');
    assert.match(status.reason, /exited 3/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ── lock held: two ticks must never overlap ─────────────────────────────────

test('lock held: exits 0 without running', { skip: SKIP_REAL_RUN }, async () => {
  const { tmp, box, origin, originUrl } = makeBoxAtV1();
  let holder;
  try {
    advanceOriginLinear(tmp, origin);
    const lockFile = path.join(tmp, 'pull-deploy.lock');
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    holder = spawn('bash', ['-c', `exec 200>"${lockFile}"; flock 200; sleep 5`], { stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 400)); // let the holder acquire the lock
    const recordFile = path.join(tmp, 'stub-record.txt');
    const r = spawnSync('bash', [SCRIPT_PATH], {
      cwd: box,
      encoding: 'utf8',
      env: {
        ...process.env,
        GATETEST_APP_DIR: box,
        PULL_DEPLOY_STATUS_FILE: path.join(tmp, 'status.json'),
        PULL_DEPLOY_LOCK: lockFile,
        PULL_DEPLOY_EXPECTED_ORIGIN: originUrl,
        STUB_RECORD_FILE: recordFile,
      },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /holds the lock/);
    assert.equal(fs.existsSync(recordFile), false, 'the deploy must never run while another tick holds the lock');
  } finally {
    if (holder) holder.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── provenance (a): origin must be the expected repository ─────────────────
// Box 161 hosts other products — "whoever can push to main is root on the
// box" is the threat. A control pair: the wrong origin must refuse before
// ever touching the network; the right one (even a throwaway test repo, via
// the override env the test uses) must proceed normally.

test('POSITIVE CONTROL: an origin remote that is not the expected repository refuses before fetching, status "failed"', { skip: !HAVE_BASH && 'bash not available' }, () => {
  const { tmp, box, origin } = makeBoxAtV1();
  try {
    advanceOriginLinear(tmp, origin);
    const recordFile = path.join(tmp, 'stub-record.txt');
    // No PULL_DEPLOY_EXPECTED_ORIGIN override: the box's origin is a throwaway
    // filesystem path, which never matches the built-in GateTest github.com URLs.
    const { r, statusFile } = run(box, tmp, { STUB_RECORD_FILE: recordFile });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /origin remote is not the expected/);
    assert.equal(fs.existsSync(recordFile), false, 'must refuse before ever running anything from the remote');
    const status = readStatus(statusFile);
    assert.equal(status.result, 'failed');
    assert.match(status.reason, /origin remote is not the expected/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('negative control: the expected origin (via the override the test uses) proceeds normally', { skip: SKIP_REAL_RUN }, () => {
  const { tmp, box, origin, originUrl } = makeBoxAtV1();
  try {
    advanceOriginLinear(tmp, origin);
    const recordFile = path.join(tmp, 'stub-record.txt');
    const { r, statusFile } = run(box, tmp, { PULL_DEPLOY_EXPECTED_ORIGIN: originUrl, STUB_RECORD_FILE: recordFile });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(fs.existsSync(recordFile), true);
    assert.equal(readStatus(statusFile).result, 'deployed');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ── provenance (b): origin/main must be a fast-forward of the deployed commit ──
// A force-pushed or rewritten main must never be deployed silently — this is
// the box-side backstop behind branch protection (no force-push, four
// required checks), not a substitute for it.

test('POSITIVE CONTROL: a rewritten (non-fast-forward) origin/main refuses, status "failed", stub never runs', { skip: SKIP_REAL_RUN }, () => {
  const { tmp, box, origin, originUrl } = makeBoxAtV1();
  try {
    rewriteOriginHistory(tmp, origin);
    const recordFile = path.join(tmp, 'stub-record.txt');
    const { r, statusFile } = run(box, tmp, { PULL_DEPLOY_EXPECTED_ORIGIN: originUrl, STUB_RECORD_FILE: recordFile });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /origin\/main is not a fast-forward of the deployed commit/);
    assert.equal(fs.existsSync(recordFile), false, 'must refuse before ever running the deploy script');
    const status = readStatus(statusFile);
    assert.equal(status.result, 'failed');
    assert.match(status.reason, /not a fast-forward/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('negative control: a genuine fast-forward (linear history) proceeds — same case as "origin ahead" above', { skip: SKIP_REAL_RUN }, () => {
  const { tmp, box, origin, originUrl } = makeBoxAtV1();
  try {
    const newTip = advanceOriginLinear(tmp, origin);
    const recordFile = path.join(tmp, 'stub-record.txt');
    const { r, statusFile } = run(box, tmp, { PULL_DEPLOY_EXPECTED_ORIGIN: originUrl, STUB_RECORD_FILE: recordFile });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(fs.existsSync(recordFile), true);
    const status = readStatus(statusFile);
    assert.equal(status.result, 'deployed');
    assert.equal(status.after, newTip);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ── static checks ────────────────────────────────────────────────────────────

test('gatetest-pull-deploy.service is Type=oneshot with an explicit TimeoutStartSec', () => {
  const unit = fs.readFileSync(path.join(ROOT, 'scripts', 'deploy', 'systemd', 'gatetest-pull-deploy.service'), 'utf8');
  assert.match(unit, /^Type=oneshot$/m);
  assert.match(unit, /^TimeoutStartSec=\d+$/m);
  assert.match(unit, /^ExecStart=.*pull-deploy\.sh$/m);
});

test('gatetest-pull-deploy.timer declares OnUnitActiveSec and points at the service', () => {
  const timer = fs.readFileSync(path.join(ROOT, 'scripts', 'deploy', 'systemd', 'gatetest-pull-deploy.timer'), 'utf8');
  assert.match(timer, /^OnUnitActiveSec=\d+(s|min|h)?$/m);
  assert.match(timer, /^Unit=gatetest-pull-deploy\.service$/m);
  assert.match(timer, /^Persistent=true$/m);
});

test('install-pull-deploy.sh refuses to run when not root', { skip: !HAVE_BASH && 'bash not available' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-fakeid-'));
  try {
    const idPath = path.join(tmp, 'id');
    fs.writeFileSync(idPath, '#!/bin/bash\necho 1000\n');
    fs.chmodSync(idPath, 0o755);
    const installer = path.join(ROOT, 'scripts', 'deploy', 'install-pull-deploy.sh');
    const r = spawnSync('bash', [installer], {
      encoding: 'utf8',
      env: { ...process.env, PATH: [tmp, process.env.PATH].join(path.delimiter) },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /must run as root/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('deploy-box.yml classifies an unreachable box as "box unreachable over SSH", not a deploy-on-box.sh failure', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy-box.yml'), 'utf8');
  assert.match(wf, /ssh: connect to host\|Connection timed out\|Connection refused/);
  assert.match(wf, /box unreachable over SSH \(port 22 is closed by design since 2026-09-16\)/);
  assert.match(wf, /docs\/deploy\/PULL-DEPLOY\.md/);
});

test('deploy-box.yml only attempts the SSH deploy on workflow_dispatch, and polls for push', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy-box.yml'), 'utf8');
  const deployJob = wf.slice(wf.indexOf('\n  deploy:'), wf.indexOf('\n  poll-pull-deploy:'));
  assert.match(deployJob, /if: github\.event_name == 'workflow_dispatch'/);
  const pollJob = wf.slice(wf.indexOf('\n  poll-pull-deploy:'), wf.indexOf('\n  verify:'));
  assert.match(pollJob, /if: github\.event_name == 'push'/);
  assert.match(pollJob, /scripts\/ops\/verify-deploy\.js/);
  assert.match(pollJob, /within 15 min/);
});

// Production froze at one commit for ten hours on 2026-09-22/23: the box ran
// a deploy script whose only non-flag path was blue/green, which aborts when
// the templated unit or the active-port file is absent. A deploy script must
// never turn "not yet installed" into "never deploys again" — it says why and
// restarts in place instead. Static assertions: the real path needs flock and
// a Linux box (see SKIP_REAL_RUN above); CI runs the real tests.
const fallbackSrc = fs.readFileSync(SCRIPT_PATH, 'utf8').replace(/\r\n/g, '\n');

test('pull-deploy.sh falls back to in-place when blue/green is not installed: checks for the templated unit', () => {
  assert.match(fallbackSrc, /systemctl cat "\$\{PULL_DEPLOY_UNIT_TEMPLATE:-gatetest-web@\}\.service"/);
  assert.match(fallbackSrc, /blue\/green not installed on this box/);
});

test('pull-deploy.sh falls back to in-place when blue/green is not installed: checks for the active-port file', () => {
  assert.match(fallbackSrc, /PULL_DEPLOY_ACTIVE_PORT_FILE:-\/var\/lib\/gatetest\/pull-deploy-active-port/);
  assert.match(fallbackSrc, /no active-port file/);
});

test('pull-deploy.sh: every fallback branch selects the same in-place restart PULL_DEPLOY_INPLACE=1 selects', () => {
  const inPlaceAssignments = (fallbackSrc.match(/RESTART_MODE="in-place"/g) || []).length;
  assert.equal(inPlaceAssignments, 3, 'flag, missing template, missing active-port file');
  assert.match(fallbackSrc, /if \[ "\$RESTART_MODE" = "in-place" \]; then\n\s*git show origin\/main:scripts\/deploy\/deploy-on-box\.sh \| GATETEST_APP_DIR="\$APP_DIR" PULL_DEPLOY_INPLACE=1 bash -s/);
});

test('pull-deploy.sh: blue/green is still the default when nothing is missing', () => {
  assert.match(fallbackSrc, /RESTART_MODE="blue-green"\n/);
  assert.match(fallbackSrc, /GATETEST_RESTART_CMD="\$APP_DIR\/scripts\/deploy\/blue-green-restart\.sh"/);
});
