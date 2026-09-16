'use strict';

/**
 * verify-deploy — is production running the commit we think it is?
 *
 * The engine half: reads `/api/platform-status` (`commit`, `version`,
 * `builtAt`) on the public site and compares `commit` with the intended one.
 * `scripts/ops/verify-deploy.js` is the CLI over it, the same split as
 * `readiness-probe.js`. Everything here takes its fetch and git as
 * arguments, so tests run it with neither network nor repository.
 *
 *   exit 0  in sync      deployed commit == expected (short/long prefixes match)
 *   exit 1  lagging      deployed is an ancestor of expected, N commits behind
 *                        — or deployed is NOT on main at all (also 1: whatever
 *                        it is running, it is not what we shipped)
 *   exit 2  unreachable  the endpoint did not answer, answered non-JSON, or
 *                        carries no commit stamp — we cannot tell fresh from
 *                        stale, and "cannot tell" is never green (Doctrine §1)
 *
 * Why this exists: `.github/workflows/deploy-box.yml` failed on every push to
 * main from 2026-09-15 ("[deploy] ERROR: unexpected uncommitted changes on
 * the box"), production sat on 3884051c while main moved 35 commits ahead,
 * and nothing said so (docs/ROADMAP.md KI #112). The deploy workflow turns
 * this verdict into a `deploy-drift` issue; the readiness probe turns it into
 * a red probe. The site URL comes from ./site-url — never a literal.
 */

const { siteUrl, normaliseOrigin } = require('./site-url');

const EXIT = Object.freeze({ IN_SYNC: 0, LAGGING: 1, UNREACHABLE: 2 });
const DEFAULT_TIMEOUT_MS = 20_000;
const PLATFORM_STATUS_PATH = '/api/platform-status';
const SHA_RE = /^[0-9a-f]{7,40}$/;

function short(sha) {
  return String(sha || '').slice(0, 12);
}

function tryGit(git, args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

/**
 * The commit production SHOULD be on. First answer wins:
 *   1. opts.expect (--expect <sha>)
 *   2. env.GITHUB_SHA (the commit the workflow run is for)
 *   3. origin/main of this checkout (after a best-effort fetch)
 */
function resolveExpected(opts, env, git) {
  if (opts.expect) return { sha: opts.expect, source: '--expect' };
  if (env.GITHUB_SHA) return { sha: env.GITHUB_SHA, source: 'GITHUB_SHA' };
  tryGit(git, ['fetch', '--quiet', 'origin', 'main']);
  const sha = tryGit(git, ['rev-parse', 'origin/main']);
  if (sha) return { sha, source: 'origin/main' };
  return { sha: null, source: 'none' };
}

/**
 * GET the platform-status document with a hard deadline.
 * @returns {Promise<{ok:true, data:object}|{ok:false, error:string}>}
 */
async function fetchPlatformStatus(fetchFn, url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'cache-control': 'no-cache', 'user-agent': 'gatetest-verify-deploy' },
    });
    if (res.status !== 200) return { ok: false, error: `HTTP ${res.status}` };
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, error: 'non-JSON response (something other than the app is answering)' };
    }
    if (!data || typeof data !== 'object') return { ok: false, error: 'JSON response is not an object' };
    return { ok: true, data };
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || controller.signal.aborted);
    return { ok: false, error: aborted ? `timed out after ${timeoutMs}ms` : (err && err.message) || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function shaMatches(a, b) {
  const x = String(a || '').toLowerCase();
  const y = String(b || '').toLowerCase();
  if (!x || !y) return false;
  return x.startsWith(y) || y.startsWith(x);
}

/**
 * Compare the deployed commit with the expected one. Pure, given a git
 * adapter (`git(args)` returns trimmed stdout or throws).
 *
 * @returns {{state:'in-sync'|'lagging'|'not-on-main', behind:number|null, exitCode:number, message:string}}
 */
function compare({ deployed, expected, git }) {
  const inSync = { state: 'in-sync', behind: 0, exitCode: EXIT.IN_SYNC, message: `in sync — production is on ${short(expected)}` };
  if (shaMatches(deployed, expected)) return inSync;

  // A sha the repository has never seen cannot be counted against anything —
  // but it is still not what we shipped, so the verdict is a lag, not "unknown".
  if (tryGit(git, ['cat-file', '-e', `${deployed}^{commit}`]) === null) {
    return {
      state: 'not-on-main', behind: null, exitCode: EXIT.LAGGING,
      message: `deployed commit ${short(deployed)} is not on main (unknown to this repository) — expected ${short(expected)}`,
    };
  }
  if (tryGit(git, ['merge-base', '--is-ancestor', deployed, expected]) === null) {
    return {
      state: 'not-on-main', behind: null, exitCode: EXIT.LAGGING,
      message: `deployed commit ${short(deployed)} is not on main (not an ancestor of ${short(expected)})`,
    };
  }
  const count = tryGit(git, ['rev-list', '--count', `${deployed}..${expected}`]);
  const behind = count !== null && /^\d+$/.test(count) ? Number(count) : null;
  if (behind === 0) return inSync;
  return {
    state: 'lagging', behind, exitCode: EXIT.LAGGING,
    message: behind === null
      ? `lagging — production is on ${short(deployed)}, expected ${short(expected)} (commit count unavailable)`
      : `lagging by ${behind} commit${behind === 1 ? '' : 's'} — production is on ${short(deployed)}, expected ${short(expected)}`,
  };
}

/**
 * A push that landed a minute ago has not had time to deploy. With
 * `graceMinutes` > 0 and an EXPECTED commit younger than that, a lag is
 * reported as "deploying" (exit 0). The deploy workflow runs with no grace
 * (it runs AFTER the deploy); the scheduled probe uses one so it is not red
 * by design every time main moves.
 */
function withinGrace({ expected, graceMinutes, git, now = Date.now() }) {
  if (!graceMinutes) return false;
  const ct = tryGit(git, ['show', '-s', '--format=%ct', expected]);
  if (ct === null || !/^\d+$/.test(ct)) return false;
  const ageMs = now - Number(ct) * 1000;
  return ageMs >= 0 && ageMs < graceMinutes * 60_000;
}

/**
 * Human age of a build: "unknown" when the stamp is missing or unparsable.
 * Minutes under an hour, hours under two days, days after that — one decimal
 * on hours and days so "1.9 days" and "1.1 days" read differently.
 */
function formatAge(builtAt, now = Date.now()) {
  if (!builtAt) return 'unknown';
  const t = Date.parse(builtAt);
  if (Number.isNaN(t)) return 'unknown';
  const ms = now - t;
  if (ms < 0) return 'in the future (clock skew?)';
  const minutes = ms / 60_000;
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${Math.round(minutes)} minute${Math.round(minutes) === 1 ? '' : 's'}`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)} hours`;
  return `${(hours / 24).toFixed(1)} days`;
}

/**
 * The whole check.
 *
 * @param {object} opts   { expect, base, graceMinutes, timeoutMs }
 * @param {object} deps   { env, fetchFn, git, now }
 */
async function verify(opts, deps = {}) {
  const env = deps.env || process.env;
  const fetchFn = deps.fetchFn || fetch;
  const git = deps.git;
  const now = deps.now || Date.now();
  if (typeof git !== 'function') throw new Error('verify: a git adapter is required');

  const base = opts.base ? normaliseOrigin(opts.base) : siteUrl();
  if (!base) throw new Error(`--base is not a usable origin: ${opts.base}`);
  const url = `${base}${PLATFORM_STATUS_PATH}`;

  const expected = resolveExpected(opts, env, git);
  const report = {
    url, checkedAt: new Date(now).toISOString(),
    expected: expected.sha, expectedSource: expected.source,
    deployed: null, version: null, builtAt: null, age: 'unknown',
    state: 'unreachable', behind: null, exitCode: EXIT.UNREACHABLE, message: '',
  };

  const res = await fetchPlatformStatus(fetchFn, url, opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  if (!res.ok) {
    report.message = `unreachable — ${url}: ${res.error}`;
    return report;
  }
  const { data } = res;
  report.version = data.version ? String(data.version) : null;
  report.builtAt = data.builtAt ? String(data.builtAt) : null;
  report.age = formatAge(report.builtAt, now);
  const commit = String(data.commit || '').trim();
  if (!SHA_RE.test(commit)) {
    report.deployed = commit || null;
    report.message = `unreachable — ${url} carries no commit stamp (commit=${JSON.stringify(commit || null)}); build with \`npm run build\` so prebuild stamps the sha`;
    return report;
  }
  report.deployed = commit;

  if (!expected.sha) {
    report.message = 'no expected commit — pass --expect <sha>, set GITHUB_SHA, or run inside a checkout with origin/main';
    return report;
  }

  const verdict = compare({ deployed: commit, expected: expected.sha, git });
  Object.assign(report, verdict);
  if (verdict.state === 'lagging' && withinGrace({ expected: expected.sha, graceMinutes: opts.graceMinutes || 0, git, now })) {
    report.state = 'deploying';
    report.exitCode = EXIT.IN_SYNC;
    report.message = `${verdict.message} — expected commit is younger than ${opts.graceMinutes} min, a deploy may still be running`;
  }
  return report;
}

const STATE_LABEL = { 'in-sync': 'IN SYNC', deploying: 'DEPLOYING', lagging: 'LAGGING', 'not-on-main': 'NOT ON MAIN', unreachable: 'UNREACHABLE' };

/** Human rendering of a report, one screen. */
function render(report) {
  const lines = [`verify-deploy  ${report.url}`];
  if (report.deployed) {
    const v = report.version ? `  v${report.version}` : '';
    const built = report.builtAt ? `  built ${report.builtAt} (${report.age} ago)` : '  built: unknown';
    lines.push(`  deployed  ${short(report.deployed)}${v}${built}`);
  } else {
    lines.push('  deployed  (unreadable)');
  }
  lines.push(`  expected  ${report.expected ? short(report.expected) : '(none)'}  (${report.expectedSource})`);
  lines.push(`  ${STATE_LABEL[report.state] || report.state.toUpperCase()} — ${report.message}`);
  return lines.join('\n');
}

module.exports = {
  EXIT,
  DEFAULT_TIMEOUT_MS,
  PLATFORM_STATUS_PATH,
  resolveExpected,
  fetchPlatformStatus,
  compare,
  withinGrace,
  formatAge,
  verify,
  render,
};
