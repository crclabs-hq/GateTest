// =============================================================================
// deploy-on-box.sh — opt-in recovery (DEPLOY_RECOVER=1) never loses box edits
// =============================================================================
// Issue #542: production sat 205 commits behind because the box was on a
// feature branch with hand edits and both guards refused. Recovery must
// (a) do nothing unless asked, (b) keep every edit (stash + patch copy),
// (c) leave the old branch alone, (d) end on main at origin/main.
// The script is run for real, up to its "end of sync phase" marker, against
// a throwaway repo — not read as text.
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'scripts', 'deploy', 'deploy-on-box.sh'), 'utf8').replace(/\r\n/g, '\n');
const MARK = '# --- end of sync phase ---';
const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' });
const HAVE_BASH = bash.status === 0;

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function makeBox() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-recover-'));
  const origin = path.join(tmp, 'origin.git');
  const box = path.join(tmp, 'box');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  git(tmp, 'clone', '-q', origin, box);
  git(box, 'config', 'user.email', 't@example.invalid');
  git(box, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(box, 'app.txt'), 'v1\n');
  git(box, 'add', '-A'); git(box, 'commit', '-q', '-m', 'v1'); git(box, 'push', '-q', 'origin', 'main');
  // the box drifts: feature branch, a hand edit, an untracked file
  git(box, 'checkout', '-q', '-b', 'jarvis/fix-874');
  fs.writeFileSync(path.join(box, 'app.txt'), 'v1 + hand fix\n');
  fs.writeFileSync(path.join(box, 'stray.lock'), 'x\n');
  // main moves on upstream
  const up = path.join(tmp, 'up');
  git(tmp, 'clone', '-q', origin, up);
  git(up, 'config', 'user.email', 't@example.invalid'); git(up, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(up, 'app.txt'), 'v2\n');
  git(up, 'add', '-A'); git(up, 'commit', '-q', '-m', 'v2'); git(up, 'push', '-q', 'origin', 'main');
  return { tmp, box, originHead: git(up, 'rev-parse', 'HEAD') };
}

function runSyncPhase(box, env) {
  const idx = SCRIPT.indexOf(MARK);
  assert.ok(idx > 0, 'deploy-on-box.sh must carry the end-of-sync-phase marker');
  const head = SCRIPT.slice(0, idx);
  return spawnSync('bash', ['-s'], { input: head, cwd: box, encoding: 'utf8', env: { ...process.env, GATETEST_APP_DIR: box, ...env } });
}

test('without DEPLOY_RECOVER the script still refuses a non-main box and changes nothing', { skip: !HAVE_BASH && 'bash not available' }, () => {
  const { tmp, box } = makeBox();
  try {
    const r = runSyncPhase(box, { DEPLOY_RECOVER: '0' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not main/);
    assert.equal(git(box, 'rev-parse', '--abbrev-ref', 'HEAD'), 'jarvis/fix-874');
    assert.equal(fs.readFileSync(path.join(box, 'app.txt'), 'utf8'), 'v1 + hand fix\n');
    assert.equal(git(box, 'stash', 'list'), '');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('with DEPLOY_RECOVER=1 edits are stashed, the old branch survives, and the box ends on origin/main', { skip: !HAVE_BASH && 'bash not available' }, () => {
  const { tmp, box, originHead } = makeBox();
  try {
    const oldTip = git(box, 'rev-parse', 'jarvis/fix-874');
    const r = runSyncPhase(box, { DEPLOY_RECOVER: '1' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /RECOVER: stashed as 'deploy-recover-/);
    assert.equal(git(box, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(git(box, 'rev-parse', 'HEAD'), originHead);
    assert.equal(git(box, 'rev-parse', 'jarvis/fix-874'), oldTip, 'the old branch must be untouched');
    const stash = git(box, 'stash', 'list');
    assert.match(stash, /deploy-recover-/);
    const shown = git(box, 'stash', 'show', '-p', '--include-untracked', 'stash@{0}');
    assert.match(shown, /hand fix/, 'the tracked hand edit is in the stash');
    assert.match(shown, /stray\.lock/, 'the untracked file is in the stash');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('DEPLOY_RECOVER=1 on a clean main box recovers nothing and still syncs', { skip: !HAVE_BASH && 'bash not available' }, () => {
  const { tmp, box, originHead } = makeBox();
  try {
    git(box, 'checkout', '-q', '-f', 'main'); fs.rmSync(path.join(box, 'stray.lock'), { force: true });
    const r = runSyncPhase(box, { DEPLOY_RECOVER: '1' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /nothing to recover/);
    assert.equal(git(box, 'stash', 'list'), '');
    assert.equal(git(box, 'rev-parse', 'HEAD'), originHead);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('only a manual dispatch can set the flag, and it never reaches the script as event text', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy-box.yml'), 'utf8');
  assert.match(wf, /DEPLOY_RECOVER: \$\{\{ \(github\.event_name == 'workflow_dispatch' && inputs\.recover\) && '1' \|\| '0' \}\}/);
  assert.ok(!/run:[\s\S]*\$\{\{\s*inputs\.recover/.test(wf.split('Deploy over SSH')[1].split('- name:')[0]), 'the input must not be interpolated into the run script');
});
