// =============================================================================
// verify-deploy — production must be running the commit we shipped
// =============================================================================
// From 2026-09-15 deploy-box.yml failed on every push ("[deploy] ERROR:
// unexpected uncommitted changes on the box"), production served 3884051c
// while main moved 35 commits on, and nothing said so. scripts/ops/
// verify-deploy.js is the one comparison both workflows now run; this file
// pins its verdicts and exit codes with a stubbed fetch and a stubbed git,
// and parses the two changed workflows as YAML so a bad indent cannot ship
// as a job GitHub silently ignores.
// =============================================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const vd = require('../scripts/ops/verify-deploy');
const { compare, formatAge, fetchPlatformStatus, verify, parseArgs, withinGrace, render, EXIT } = vd;

const DEPLOYED = '3884051c4cd3f83fef9242901f248dbc245e219f';
const EXPECTED = 'b444057a08ee6fe83099fd4d55345de836aecf2f';
const NOW = Date.parse('2026-09-16T06:00:00.000Z');

// A git stub: `answers` maps "cat-file -e X^{commit}" style joined args to
// either a string (stdout) or an Error (git exited non-zero).
function gitStub(answers) {
  const calls = [];
  const fn = (args) => {
    const key = args.join(' ');
    calls.push(key);
    for (const [pattern, value] of Object.entries(answers)) {
      if (key === pattern || key.startsWith(pattern)) {
        if (value instanceof Error) throw value;
        return value;
      }
    }
    throw new Error(`git stub: unexpected ${key}`);
  };
  fn.calls = calls;
  return fn;
}

const LAGGING_GIT = () => gitStub({
  [`cat-file -e ${DEPLOYED}^{commit}`]: '',
  [`merge-base --is-ancestor ${DEPLOYED} ${EXPECTED}`]: '',
  [`rev-list --count ${DEPLOYED}..${EXPECTED}`]: '35',
});

function fetchStub(status, body, { hang = false, throwErr = null } = {}) {
  return async (_url, init) => {
    if (throwErr) throw throwErr;
    if (hang) {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    }
    return { status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  };
}

const LIVE_BODY = { product: 'gatetest', version: '1.61.1', commit: DEPLOYED, builtAt: '2026-09-15T15:40:40.865Z', healthy: true };

// ---------------------------------------------------------------------------
// compare()
// ---------------------------------------------------------------------------

test('compare: identical shas are in sync, exit 0, no git consulted', () => {
  const git = gitStub({});
  const r = compare({ deployed: EXPECTED, expected: EXPECTED, git });
  assert.equal(r.state, 'in-sync');
  assert.equal(r.exitCode, EXIT.IN_SYNC);
  assert.equal(r.behind, 0);
  assert.deepEqual(git.calls, []);
});

test('compare: a short sha prefix on either side is in sync', () => {
  const git = gitStub({});
  assert.equal(compare({ deployed: EXPECTED.slice(0, 8), expected: EXPECTED, git }).state, 'in-sync');
  assert.equal(compare({ deployed: EXPECTED, expected: EXPECTED.slice(0, 7), git }).state, 'in-sync');
  assert.equal(compare({ deployed: EXPECTED.toUpperCase(), expected: EXPECTED, git }).state, 'in-sync');
});

test('compare: an ancestor N commits back is lagging by N, exit 1', () => {
  const git = LAGGING_GIT();
  const r = compare({ deployed: DEPLOYED, expected: EXPECTED, git });
  assert.equal(r.state, 'lagging');
  assert.equal(r.behind, 35);
  assert.equal(r.exitCode, EXIT.LAGGING);
  assert.match(r.message, /lagging by 35 commits/);
  assert.ok(git.calls.some((c) => c === `rev-list --count ${DEPLOYED}..${EXPECTED}`), 'must count with git rev-list --count deployed..expected');
});

test('compare: singular "1 commit"', () => {
  const git = gitStub({
    [`cat-file -e ${DEPLOYED}^{commit}`]: '',
    [`merge-base --is-ancestor ${DEPLOYED} ${EXPECTED}`]: '',
    [`rev-list --count ${DEPLOYED}..${EXPECTED}`]: '1',
  });
  assert.match(compare({ deployed: DEPLOYED, expected: EXPECTED, git }).message, /lagging by 1 commit —/);
});

test('compare: deployed sha not an ancestor → "not on main", exit 1, no count attempted', () => {
  const git = gitStub({
    [`cat-file -e ${DEPLOYED}^{commit}`]: '',
    [`merge-base --is-ancestor ${DEPLOYED} ${EXPECTED}`]: new Error('exit 1'),
  });
  const r = compare({ deployed: DEPLOYED, expected: EXPECTED, git });
  assert.equal(r.state, 'not-on-main');
  assert.equal(r.behind, null);
  assert.equal(r.exitCode, EXIT.LAGGING);
  assert.match(r.message, /deployed commit \w+ is not on main/);
  assert.ok(!git.calls.some((c) => c.startsWith('rev-list')), 'no rev-list on a non-ancestor');
});

test('compare: deployed sha unknown to the repository → "not on main", exit 1', () => {
  const git = gitStub({
    [`cat-file -e ${DEPLOYED}^{commit}`]: new Error('fatal: Not a valid object name'),
  });
  const r = compare({ deployed: DEPLOYED, expected: EXPECTED, git });
  assert.equal(r.state, 'not-on-main');
  assert.equal(r.exitCode, EXIT.LAGGING);
  assert.match(r.message, /is not on main \(unknown to this repository\)/);
});

test('compare: rev-list unavailable still reports lagging (exit 1) with behind=null', () => {
  const git = gitStub({
    [`cat-file -e ${DEPLOYED}^{commit}`]: '',
    [`merge-base --is-ancestor ${DEPLOYED} ${EXPECTED}`]: '',
    [`rev-list --count ${DEPLOYED}..${EXPECTED}`]: new Error('boom'),
  });
  const r = compare({ deployed: DEPLOYED, expected: EXPECTED, git });
  assert.equal(r.state, 'lagging');
  assert.equal(r.behind, null);
  assert.equal(r.exitCode, EXIT.LAGGING);
  assert.match(r.message, /commit count unavailable/);
});

// ---------------------------------------------------------------------------
// formatAge()
// ---------------------------------------------------------------------------

test('formatAge: missing or unparsable stamp is "unknown"', () => {
  assert.equal(formatAge(null, NOW), 'unknown');
  assert.equal(formatAge('', NOW), 'unknown');
  assert.equal(formatAge('not a date', NOW), 'unknown');
});

test('formatAge: minutes under an hour, hours under two days, days after', () => {
  const at = (ms) => new Date(NOW - ms).toISOString();
  assert.equal(formatAge(at(20_000), NOW), 'under a minute');
  assert.equal(formatAge(at(60_000), NOW), '1 minute');
  assert.equal(formatAge(at(45 * 60_000), NOW), '45 minutes');
  assert.equal(formatAge(at(90 * 60_000), NOW), '1.5 hours');
  assert.equal(formatAge('2026-09-15T15:40:40.865Z', NOW), '14.3 hours');
  assert.equal(formatAge(at(47 * 3_600_000), NOW), '47.0 hours');
  assert.equal(formatAge(at(48 * 3_600_000), NOW), '2.0 days');
  assert.equal(formatAge(at(10 * 86_400_000 + 12 * 3_600_000), NOW), '10.5 days');
});

test('formatAge: a stamp in the future says so instead of a negative age', () => {
  assert.match(formatAge(new Date(NOW + 60_000).toISOString(), NOW), /future/);
});

// ---------------------------------------------------------------------------
// fetchPlatformStatus() — every failure shape is "unreachable", every fetch
// carries an abort signal
// ---------------------------------------------------------------------------

test('fetchPlatformStatus: 200 JSON → ok with data; signal and no-cache header sent', async () => {
  let seenInit;
  const f = async (url, init) => {
    seenInit = init;
    assert.equal(url, 'https://example.test/api/platform-status');
    return { status: 200, text: async () => JSON.stringify(LIVE_BODY) };
  };
  const r = await fetchPlatformStatus(f, 'https://example.test/api/platform-status', 1000);
  assert.equal(r.ok, true);
  assert.equal(r.data.commit, DEPLOYED);
  assert.ok(seenInit.signal instanceof AbortSignal, 'fetch must carry an abort signal');
  assert.equal(seenInit.headers['cache-control'], 'no-cache');
});

test('fetchPlatformStatus: non-200, non-JSON, network error → not ok with a reason', async () => {
  assert.match((await fetchPlatformStatus(fetchStub(502, 'bad gateway'), 'u', 1000)).error, /HTTP 502/);
  assert.match((await fetchPlatformStatus(fetchStub(200, '<html>proxy</html>'), 'u', 1000)).error, /non-JSON/);
  assert.match((await fetchPlatformStatus(fetchStub(200, '"a string"'), 'u', 1000)).error, /not an object/);
  assert.match((await fetchPlatformStatus(fetchStub(0, '', { throwErr: new Error('ECONNREFUSED') }), 'u', 1000)).error, /ECONNREFUSED/);
});

test('fetchPlatformStatus: a hanging endpoint times out via the abort signal', async () => {
  const started = Date.now();
  const r = await fetchPlatformStatus(fetchStub(200, '', { hang: true }), 'u', 30);
  assert.equal(r.ok, false);
  assert.match(r.error, /timed out after 30ms/);
  assert.ok(Date.now() - started < 5000, 'must not wait for the hung request');
});

// ---------------------------------------------------------------------------
// verify() — end to end with stubs; the exit codes the workflows key on
// ---------------------------------------------------------------------------

const baseDeps = (over = {}) => ({
  argv: ['--expect', EXPECTED, '--base', 'https://example.test'],
  env: {},
  fetchFn: fetchStub(200, LIVE_BODY),
  git: LAGGING_GIT(),
  now: NOW,
  ...over,
});

test('verify: lagging today — 35 commits, exit 1, age of the deployed build printed', async () => {
  const r = await verify(baseDeps());
  assert.equal(r.state, 'lagging');
  assert.equal(r.behind, 35);
  assert.equal(r.exitCode, 1);
  assert.equal(r.deployed, DEPLOYED);
  assert.equal(r.expected, EXPECTED);
  assert.equal(r.expectedSource, '--expect');
  assert.equal(r.version, '1.61.1');
  assert.equal(r.age, '14.3 hours');
  assert.equal(r.url, 'https://example.test/api/platform-status');
  const text = render(r);
  assert.match(text, /LAGGING/);
  assert.match(text, /14\.3 hours ago/);
  assert.match(text, /v1\.61\.1/);
});

test('verify: in sync — exit 0', async () => {
  const r = await verify(baseDeps({ argv: ['--expect', DEPLOYED, '--base', 'https://example.test'], git: gitStub({}) }));
  assert.equal(r.state, 'in-sync');
  assert.equal(r.exitCode, 0);
  assert.match(render(r), /IN SYNC/);
});

test('verify: unreachable — network error, HTTP 500, non-JSON, no commit stamp → exit 2', async () => {
  for (const fetchFn of [
    fetchStub(0, '', { throwErr: new Error('getaddrinfo ENOTFOUND') }),
    fetchStub(500, 'oops'),
    fetchStub(200, '<html>'),
    fetchStub(200, { ...LIVE_BODY, commit: 'unknown' }),
    fetchStub(200, { ...LIVE_BODY, commit: undefined }),
  ]) {
    const r = await verify(baseDeps({ fetchFn }));
    assert.equal(r.state, 'unreachable', r.message);
    assert.equal(r.exitCode, 2, r.message);
    assert.match(render(r), /UNREACHABLE/);
  }
});

test('verify: a timeout is unreachable (exit 2), and every fetch has one', async () => {
  const r = await verify(baseDeps({ argv: ['--expect', EXPECTED, '--base', 'https://example.test', '--timeout-ms', '30'], fetchFn: fetchStub(200, '', { hang: true }) }));
  assert.equal(r.exitCode, 2);
  assert.match(r.message, /timed out/);
  assert.ok(vd.DEFAULT_TIMEOUT_MS > 0 && vd.DEFAULT_TIMEOUT_MS <= 60_000, 'default timeout must exist and be bounded');
});

test('verify: expected commit falls back to GITHUB_SHA, then origin/main', async () => {
  const fromEnv = await verify(baseDeps({ argv: ['--base', 'https://example.test'], env: { GITHUB_SHA: EXPECTED } }));
  assert.equal(fromEnv.expected, EXPECTED);
  assert.equal(fromEnv.expectedSource, 'GITHUB_SHA');

  const git = gitStub({
    'fetch --quiet origin main': '',
    'rev-parse origin/main': EXPECTED,
    [`cat-file -e ${DEPLOYED}^{commit}`]: '',
    [`merge-base --is-ancestor ${DEPLOYED} ${EXPECTED}`]: '',
    [`rev-list --count ${DEPLOYED}..${EXPECTED}`]: '35',
  });
  const fromMain = await verify(baseDeps({ argv: ['--base', 'https://example.test'], git }));
  assert.equal(fromMain.expectedSource, 'origin/main');
  assert.equal(fromMain.behind, 35);
});

test('verify: no expected commit anywhere → exit 2 with instructions, never a false in-sync', async () => {
  const git = gitStub({ 'fetch --quiet origin main': new Error('no remote'), 'rev-parse origin/main': new Error('unknown revision') });
  const r = await verify(baseDeps({ argv: ['--base', 'https://example.test'], git }));
  assert.equal(r.exitCode, 2);
  assert.match(r.message, /--expect/);
});

test('verify: --grace-minutes tolerates a lag only while the expected commit is younger than the grace', async () => {
  const young = String(Math.floor((NOW - 5 * 60_000) / 1000));
  const old = String(Math.floor((NOW - 90 * 60_000) / 1000));
  const gitWith = (ct) => gitStub({
    [`cat-file -e ${DEPLOYED}^{commit}`]: '',
    [`merge-base --is-ancestor ${DEPLOYED} ${EXPECTED}`]: '',
    [`rev-list --count ${DEPLOYED}..${EXPECTED}`]: '35',
    [`show -s --format=%ct ${EXPECTED}`]: ct,
  });
  const argv = ['--expect', EXPECTED, '--base', 'https://example.test', '--grace-minutes', '30'];
  const inFlight = await verify(baseDeps({ argv, git: gitWith(young) }));
  assert.equal(inFlight.state, 'deploying');
  assert.equal(inFlight.exitCode, 0);
  assert.match(inFlight.message, /a deploy may still be running/);

  const stale = await verify(baseDeps({ argv, git: gitWith(old) }));
  assert.equal(stale.state, 'lagging');
  assert.equal(stale.exitCode, 1);

  // Without a grace the same young push is a lag: the deploy workflow runs
  // AFTER the deploy and must not excuse itself.
  const strict = await verify(baseDeps({ git: gitWith(young) }));
  assert.equal(strict.exitCode, 1);
  assert.equal(withinGrace({ expected: EXPECTED, graceMinutes: 0, git: gitWith(young), now: NOW }), false);
});

test('parseArgs: rejects unknown flags and bad numbers; --json/--out parsed', () => {
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
  assert.throws(() => parseArgs(['--expect']), /needs a value/);
  assert.throws(() => parseArgs(['--grace-minutes', '-1']), /non-negative/);
  const o = parseArgs(['--expect', 'abc', '--json', '--out', 'x.json', '--grace-minutes', '30']);
  assert.equal(o.expect, 'abc');
  assert.equal(o.json, true);
  assert.equal(o.out, 'x.json');
  assert.equal(o.graceMinutes, 30);
});

// ---------------------------------------------------------------------------
// The site URL is imported, never a literal
// ---------------------------------------------------------------------------

test('verify-deploy.js reads the site origin from src/core/site-url.js and writes no gatetest literal', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'ops', 'verify-deploy.js'), 'utf8');
  assert.match(src, /require\('\.\.\/\.\.\/src\/core\/site-url'\)/);
  assert.doesNotMatch(src, /gatetest\.(io|ai)/, 'no origin literal in the script');
});

// ---------------------------------------------------------------------------
// The workflows parse as YAML and have the shape the alerting depends on
// ---------------------------------------------------------------------------

function loadYaml(rel) {
  // js-yaml ships transitively with eslint (root package-lock); resolve it
  // from this checkout's node_modules first, then wherever Node finds it.
  let yaml;
  try {
    yaml = require(path.join(ROOT, 'node_modules', 'js-yaml'));
  } catch {
    yaml = require('js-yaml');
  }
  return yaml.load(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

test('deploy-box.yml parses and has a verify job after deploy that always runs', () => {
  const wf = loadYaml('.github/workflows/deploy-box.yml');
  assert.ok(wf.jobs.deploy, 'deploy job');
  assert.ok(wf.jobs.verify, 'verify job');
  const v = wf.jobs.verify;
  assert.equal(v.needs, 'deploy');
  assert.equal(String(v.if), 'always()');
  assert.equal(v.permissions.issues, 'write', 'needs issues: write to open/close the drift issue');
  assert.equal(v.permissions.contents, 'read');
  const steps = v.steps.map((s) => (s.run || '') + (s.with && s.with.script ? s.with.script : ''));
  const runStep = v.steps.find((s) => /verify-deploy\.js/.test(s.run || ''));
  assert.ok(runStep, 'a step runs scripts/ops/verify-deploy.js');
  assert.match(runStep.run, /--expect "\$GITHUB_SHA"/, 'compares against the commit this run is for');
  const checkout = v.steps.find((s) => /actions\/checkout@/.test(s.uses || ''));
  assert.equal(checkout.with['fetch-depth'], 0, 'full history for rev-list --count');
  const issueStep = v.steps.find((s) => /actions\/github-script@/.test(s.uses || ''));
  assert.ok(issueStep, 'github-script step manages the issue');
  assert.match(issueStep.with.script, /deploy-drift/);
  assert.match(issueStep.with.script, /Production is behind main by \$\{behind\} commit/);
  assert.match(issueStep.with.script, /cd \/opt\/gatetest && git status/, 'the box-side fix is spelled out');
  assert.match(issueStep.with.script, /state: 'closed'/, 'closes the issue when in sync');
  assert.equal(issueStep.env.DEPLOY_REASON, '${{ needs.deploy.outputs.reason }}');
  assert.ok(steps.some((s) => /exit "\$VERIFY_RC"/.test(s)), 'the job goes red on lag/unreachable');
});

test('deploy-box.yml: the deploy job exposes its failure reason and captures the [deploy] ERROR line', () => {
  const wf = loadYaml('.github/workflows/deploy-box.yml');
  const d = wf.jobs.deploy;
  assert.equal(d.outputs.reason, '${{ steps.outcome.outputs.reason }}');
  const ssh = d.steps.find((s) => s.id === 'ssh');
  assert.ok(ssh, 'the SSH step has id ssh');
  assert.match(ssh.run, /set -o pipefail/);
  assert.match(ssh.run, /2>&1 \| tee deploy\.log/, 'deploy output is captured to deploy.log');
  const outcome = d.steps.find((s) => s.id === 'outcome');
  assert.ok(outcome, 'an outcome step');
  assert.equal(String(outcome.if), 'always()');
  assert.match(outcome.run, /grep -m1 '\\\[deploy\\\] ERROR:' deploy\.log/);
  assert.match(outcome.run, /BOX_SSH_KEY \/ BOX_SSH_HOST are not set/);
  assert.ok(!d.steps.some((s) => s.name === 'Report production drift'), 'the old inline drift step is replaced by the verify job (one definition)');
});

test('readiness-probe.yml parses and fails on production drift against origin/main', () => {
  const wf = loadYaml('.github/workflows/readiness-probe.yml');
  assert.equal(wf.name, 'Readiness Probe (production)');
  const steps = wf.jobs.probe.steps;
  const checkout = steps.find((s) => /actions\/checkout@/.test(s.uses || ''));
  assert.equal(checkout.with['fetch-depth'], 0, 'full history so the lag can be counted');
  const drift = steps.find((s) => /verify-deploy\.js/.test(s.run || ''));
  assert.ok(drift, 'a step runs verify-deploy.js');
  assert.equal(String(drift.if), 'always()', 'drift is reported even when the probe already failed');
  assert.match(drift.run, /git rev-parse origin\/main/);
  assert.match(drift.run, /--expect "\$expected"/);
  assert.match(drift.run, /--grace-minutes \d+/, 'a deploy in flight is not a red probe');
  assert.match(drift.run, /--base "\$BASE_URL"/, 'the dispatch input goes through env, never interpolated into run');
  assert.ok(!('continue-on-error' in drift), 'drift must fail the probe');
  const probeIdx = steps.findIndex((s) => s.name === 'Probe production');
  assert.ok(steps.indexOf(drift) > probeIdx, 'runs after the main probe');
});
