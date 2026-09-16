#!/usr/bin/env node
'use strict';

/**
 * verify-deploy — is production running the commit we think it is?
 *
 *   node scripts/ops/verify-deploy.js                         # compare with origin/main
 *   node scripts/ops/verify-deploy.js --expect <sha>          # compare with one commit
 *   node scripts/ops/verify-deploy.js --grace-minutes 30      # tolerate a deploy in flight
 *   node scripts/ops/verify-deploy.js --json                  # machine-readable report
 *   node scripts/ops/verify-deploy.js --out verify.json       # ...and write it to a file
 *
 * Reads `/api/platform-status` on the public site (`commit`, `version`,
 * `builtAt`) and compares `commit` with the intended one — `--expect`, else
 * `GITHUB_SHA`, else `origin/main` of the checkout this runs in.
 *
 *   exit 0  in sync      deployed commit == expected (short/long prefixes match)
 *   exit 1  lagging      deployed is an ancestor of expected, N commits behind
 *                        — or deployed is NOT on main at all (also 1: whatever
 *                        it is running, it is not what we shipped)
 *   exit 2  unreachable  the endpoint did not answer, answered non-JSON, or
 *                        carries no commit stamp — we cannot tell fresh from
 *                        stale, and "cannot tell" is never green (Doctrine §1)
 *
 * Why this exists: `.github/workflows/deploy-box.yml` failed on every push
 * to main from 2026-09-15 ("[deploy] ERROR: unexpected uncommitted changes
 * on the box"), production sat on 3884051c while main moved 35 commits
 * ahead, and nothing said so. The readiness probe checked env and queues,
 * not "is production running main?". The red deploy job was visible only to
 * someone who opened it. This script is the one comparison both the deploy
 * workflow (which turns a lag into a `deploy-drift` issue) and the
 * readiness probe (which turns it into a red probe) run.
 *
 * The site URL comes from src/core/site-url.js — never a literal here.
 * Every fetch has a timeout. Git is only consulted for counting; when the
 * deployed sha is unknown to the repository the answer is still a verdict.
 */

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { siteUrl, normaliseOrigin } = require('../../src/core/site-url');

const EXIT = Object.freeze({ IN_SYNC: 0, LAGGING: 1, UNREACHABLE: 2 });
const DEFAULT_TIMEOUT_MS = 20_000;
const PLATFORM_STATUS_PATH = '/api/platform-status';
const SHA_RE = /^[0-9a-f]{7,40}$/;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    expect: null, base: null, json: false, out: null,
    graceMinutes: 0, timeoutMs: DEFAULT_TIMEOUT_MS, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      i++;
      return v;
    };
    if (a === '--expect') opts.expect = next();
    else if (a === '--base') opts.base = next();
    else if (a === '--out') opts.out = next();
    else if (a === '--grace-minutes') opts.graceMinutes = Number(next());
    else if (a === '--timeout-ms') opts.timeoutMs = Number(next());
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isFinite(opts.graceMinutes) || opts.graceMinutes < 0) throw new Error('--grace-minutes must be a non-negative number');
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) throw new Error('--timeout-ms must be a positive number');
  return opts;
}

// ---------------------------------------------------------------------------
// Git — one thin adapter so tests can stub it. `git(args)` returns trimmed
// stdout or throws; that is the whole contract.
// ---------------------------------------------------------------------------

function defaultGit(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
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
 *   1. --expect <sha>
 *   2. GITHUB_SHA (the commit the workflow run is for)
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

// ---------------------------------------------------------------------------
// Fetch — every request has a deadline
// ---------------------------------------------------------------------------

/**
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

// ---------------------------------------------------------------------------
// Comparison — pure, given a git adapter
// ---------------------------------------------------------------------------

function shaMatches(a, b) {
  const x = String(a || '').toLowerCase();
  const y = String(b || '').toLowerCase();
  if (!x || !y) return false;
  return x.startsWith(y) || y.startsWith(x);
}

/**
 * Compare the deployed commit with the expected one.
 *
 * @param {object} p
 * @param {string} p.deployed   sha the site reports
 * @param {string} p.expected   sha we intended to deploy
 * @param {(args:string[])=>string} p.git
 * @returns {{state:'in-sync'|'lagging'|'not-on-main', behind:number|null, exitCode:number, message:string}}
 */
function compare({ deployed, expected, git }) {
  if (shaMatches(deployed, expected)) {
    return { state: 'in-sync', behind: 0, exitCode: EXIT.IN_SYNC, message: `in sync — production is on ${short(expected)}` };
  }
  // Is the deployed commit even in this repository? A sha the repo has never
  // seen cannot be counted against anything — but it is still not what we
  // shipped, so the verdict is a lag, not "unknown".
  const known = tryGit(git, ['cat-file', '-e', `${deployed}^{commit}`]);
  if (known === null) {
    return {
      state: 'not-on-main', behind: null, exitCode: EXIT.LAGGING,
      message: `deployed commit ${short(deployed)} is not on main (unknown to this repository) — expected ${short(expected)}`,
    };
  }
  const ancestor = tryGit(git, ['merge-base', '--is-ancestor', deployed, expected]);
  if (ancestor === null) {
    return {
      state: 'not-on-main', behind: null, exitCode: EXIT.LAGGING,
      message: `deployed commit ${short(deployed)} is not on main (not an ancestor of ${short(expected)})`,
    };
  }
  const count = tryGit(git, ['rev-list', '--count', `${deployed}..${expected}`]);
  const behind = count !== null && /^\d+$/.test(count) ? Number(count) : null;
  if (behind === 0) {
    // Ancestor with zero commits between: the shas differ only in length or
    // case, which shaMatches should already have caught — treat as in sync.
    return { state: 'in-sync', behind: 0, exitCode: EXIT.IN_SYNC, message: `in sync — production is on ${short(expected)}` };
  }
  return {
    state: 'lagging', behind, exitCode: EXIT.LAGGING,
    message: behind === null
      ? `lagging — production is on ${short(deployed)}, expected ${short(expected)} (commit count unavailable)`
      : `lagging by ${behind} commit${behind === 1 ? '' : 's'} — production is on ${short(deployed)}, expected ${short(expected)}`,
  };
}

/**
 * A push that landed a minute ago has not had time to deploy. When
 * `graceMinutes` > 0 and the EXPECTED commit is younger than that, a lag is
 * reported as "deploying" (exit 0) instead of a failure. The deploy workflow
 * runs with no grace (it runs AFTER the deploy); the scheduled probe uses one
 * so it is not red by design every time main moves.
 */
function withinGrace({ expected, graceMinutes, git, now = Date.now() }) {
  if (!graceMinutes) return false;
  const ct = tryGit(git, ['show', '-s', '--format=%ct', expected]);
  if (ct === null || !/^\d+$/.test(ct)) return false;
  const ageMs = now - Number(ct) * 1000;
  return ageMs >= 0 && ageMs < graceMinutes * 60_000;
}

// ---------------------------------------------------------------------------
// Age
// ---------------------------------------------------------------------------

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

function short(sha) {
  return String(sha || '').slice(0, 12);
}

// ---------------------------------------------------------------------------
// The whole check, injectable for tests
// ---------------------------------------------------------------------------

/**
 * @param {object} [deps]
 * @param {string[]} [deps.argv]
 * @param {Record<string,string|undefined>} [deps.env]
 * @param {typeof fetch} [deps.fetchFn]
 * @param {(args:string[])=>string} [deps.git]
 * @param {number} [deps.now]
 */
async function verify(deps = {}) {
  const argv = deps.argv || process.argv.slice(2);
  const env = deps.env || process.env;
  const fetchFn = deps.fetchFn || fetch;
  const git = deps.git || defaultGit;
  const now = deps.now || Date.now();

  const opts = parseArgs(argv);
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

  const res = await fetchPlatformStatus(fetchFn, url, opts.timeoutMs);
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
    report.state = 'unreachable';
    report.message = 'no expected commit — pass --expect <sha>, set GITHUB_SHA, or run inside a checkout with origin/main';
    return report;
  }

  const verdict = compare({ deployed: commit, expected: expected.sha, git });
  Object.assign(report, verdict);
  if (verdict.state === 'lagging' && withinGrace({ expected: expected.sha, graceMinutes: opts.graceMinutes, git, now })) {
    report.state = 'deploying';
    report.exitCode = EXIT.IN_SYNC;
    report.message = `${verdict.message} — expected commit is younger than ${opts.graceMinutes} min, a deploy may still be running`;
  }
  return report;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function render(report) {
  const lines = [];
  lines.push(`verify-deploy  ${report.url}`);
  if (report.deployed) {
    const v = report.version ? `  v${report.version}` : '';
    const built = report.builtAt ? `  built ${report.builtAt} (${report.age} ago)` : '  built: unknown';
    lines.push(`  deployed  ${short(report.deployed)}${v}${built}`);
  } else {
    lines.push('  deployed  (unreadable)');
  }
  lines.push(`  expected  ${report.expected ? short(report.expected) : '(none)'}  (${report.expectedSource})`);
  const label = { 'in-sync': 'IN SYNC', deploying: 'DEPLOYING', lagging: 'LAGGING', 'not-on-main': 'NOT ON MAIN', unreachable: 'UNREACHABLE' }[report.state] || report.state.toUpperCase();
  lines.push(`  ${label} — ${report.message}`);
  return lines.join('\n');
}

function annotate(report, env) {
  if (!env.GITHUB_ACTIONS) return;
  if (report.exitCode === EXIT.LAGGING) {
    console.log(`::error title=Production is behind main::${report.message}`);
  } else if (report.exitCode === EXIT.UNREACHABLE) {
    console.log(`::error title=Could not read the deployed commit::${report.message}`);
  }
  if (env.GITHUB_OUTPUT) {
    const out = ['state', 'behind', 'deployed', 'expected', 'version', 'builtAt', 'age', 'exitCode']
      .map((k) => `${k}=${report[k] === null || report[k] === undefined ? '' : report[k]}`)
      .join('\n');
    fs.appendFileSync(env.GITHUB_OUTPUT, `${out}\n`);
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`verify-deploy: ${err.message}`);
    process.exit(EXIT.UNREACHABLE);
  }
  if (opts.help) {
    console.log('usage: verify-deploy [--expect <sha>] [--base <origin>] [--grace-minutes N] [--timeout-ms N] [--json] [--out <file>]');
    console.log('exit 0 in sync · 1 lagging / not on main · 2 unreachable');
    process.exit(0);
  }
  let report;
  try {
    report = await verify();
  } catch (err) {
    console.error(`verify-deploy: ${err.message}`);
    process.exit(EXIT.UNREACHABLE);
  }
  if (opts.out) fs.writeFileSync(opts.out, `${JSON.stringify(report, null, 2)}\n`);
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else console.log(render(report));
  annotate(report, process.env);
  await drainFetchSockets();
  process.exitCode = report.exitCode;
}

/**
 * Close the keep-alive socket `fetch` left open before the process ends.
 * Exiting while undici is still tearing a socket down aborts Node on
 * Windows with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`
 * (docs/ROADMAP.md KI #94 — the same race in the test suite). The
 * dispatcher is reached through Node's well-known symbol, every step
 * optional so a future Node cannot break the check itself.
 */
async function drainFetchSockets() {
  const dispatcher = globalThis[Symbol.for('undici.globalDispatcher.1')];
  if (dispatcher && typeof dispatcher.close === 'function') {
    try {
      await dispatcher.close();
    } catch { /* error-ok — teardown must never change the verdict */ }
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
}

if (require.main === module) {
  main();
}

module.exports = {
  EXIT,
  DEFAULT_TIMEOUT_MS,
  PLATFORM_STATUS_PATH,
  parseArgs,
  resolveExpected,
  fetchPlatformStatus,
  compare,
  withinGrace,
  formatAge,
  verify,
  render,
};
