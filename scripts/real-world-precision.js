#!/usr/bin/env node
/**
 * Real-world precision gate — scan pinned third-party repos, hold the line.
 *
 * On 2026-09-04 the "known-good corpus must stay clean" job was green while
 * every real repository it had never seen was BLOCKED: express 2, flask 2,
 * fastify 6, got 20, zod 51, hono 55. The corpus meant to guarantee precision
 * held two synthetic fixtures — `empty-js-module` and `modern-node-idioms`.
 *
 * That is not a gap in coverage, it is a gap in KIND. Every rule in this
 * engine was written and tuned against this repository, so this repository is
 * the one codebase on which their false-positive rate cannot be measured. The
 * only honest test is code we did not write and cannot quietly adjust.
 *
 * Ceilings ratchet DOWN. Raising one to make a build pass is how the engine
 * goes back to blocking express, so a raise should arrive with the same
 * scrutiny as any other regression.
 *
 * TWO WRITERS, ONE RULE (2026-09-15). This script writes two files that
 * tests/precision-page-sync.test.js holds equal: reliability-corpus/
 * real-world.json (the ceilings) and website/app/data/precision.json (the
 * public table). Two writers race on them — the nightly bot's rolling PR
 * (flywheel/site-stats, .github/workflows/dogfood-nightly.yml) and any
 * branch that runs --ratchet. Regenerate on the MERGED tree; never merge a
 * stats PR over a branch that ratcheted after the PR was cut. On 2026-09-14
 * the bot's PR #491 (engine 1.61.0: got 12, django 59) was cut in the
 * morning, the integration branch ratcheted got -> 0 and django -> 46 that
 * evening, and the "update branch" merge (20531fdd) kept the bot's
 * precision.json beside the ratcheted manifest — main went red at 118331dc.
 * A rolling PR that is behind a ratchet on main is stale: close it and let
 * the next nightly re-cut it, or re-run this script on main. Never resolve
 * that conflict by hand — the numbers come from a scan, not a merge tool.
 *
 * Usage:
 *   node scripts/real-world-precision.js                  # all repos
 *   node scripts/real-world-precision.js --repo express   # one repo
 *   node scripts/real-world-precision.js --update         # print measured counts
 *   node scripts/real-world-precision.js --ratchet        # lower any ceiling to this run's count (never raise; floors untouched)
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'reliability-corpus', 'real-world.json');
const GATETEST = path.join(ROOT, 'bin', 'gatetest.js');
const { calibrate, findingsFromReport } = require(path.join(ROOT, 'src', 'core', 'confidence-calibration'));
const { ruleIdentity } = require(path.join(ROOT, 'src', 'core', 'rule-identity'));
const { BLOCK_THRESHOLD } = require(path.join(ROOT, 'src', 'core', 'confidence'));

// Strip SGR colour sequences before parsing the summary line.
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function parseArgs(argv) {
  const opts = { repo: null, update: false, keep: false, writeJson: null, ratchet: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--repo') { opts.repo = argv[i + 1]; i += 1; }
    else if (argv[i] === '--update') opts.update = true;
    else if (argv[i] === '--ratchet') opts.ratchet = true;
    else if (argv[i] === '--keep') opts.keep = true;
    else if (argv[i] === '--write-json') { opts.writeJson = argv[i + 1]; i += 1; }
  }
  return opts;
}

/** Shallow-clone one commit. Fails loudly — a skipped repo must never read as a pass. */
function clone(repo, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const run = (args) => spawnSync('git', args, { cwd: dest, encoding: 'utf8', stdio: 'pipe' });
  let r = run(['init', '-q']);
  if (r.status !== 0) throw new Error(`git init failed: ${r.stderr || r.stdout}`);
  r = run(['remote', 'add', 'origin', repo.url]);
  if (r.status !== 0) throw new Error(`git remote add failed: ${r.stderr || r.stdout}`);
  r = run(['fetch', '--depth', '1', '-q', 'origin', repo.sha]);
  if (r.status !== 0) throw new Error(`git fetch of ${repo.sha.slice(0, 8)} failed: ${r.stderr || r.stdout}`);
  r = run(['checkout', '-q', 'FETCH_HEAD']);
  if (r.status !== 0) throw new Error(`git checkout failed: ${r.stderr || r.stdout}`);
}

/**
 * Blocking count for one repo.
 *
 * Read from the summary line the runner prints:
 *   "  Errors:   2 blocking, 13 soft (low confidence)"  -> 2
 *   "  Errors:   0"                                      -> 0
 * Exit code is deliberately NOT used: a repo is allowed to block (NodeGoat
 * must), so the number is the signal, not pass/fail.
 */
function scan(dir) {
  const res = spawnSync(process.execPath, [GATETEST, 'scan', '--suite', 'full', '--project', dir], {
    encoding: 'utf8',
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 20 * 60 * 1000,
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`.replace(ANSI_RE, '');
  const m = out.match(/^\s*Errors:\s*(\d+)\s*(?:blocking)?/m);
  if (!m) {
    throw new Error(
      'could not read a blocking count from the scan output — the summary format may have changed.\n' +
      `Last 40 lines:\n${out.split('\n').slice(-40).join('\n')}`,
    );
  }
  return { blocking: Number(m[1]), findings: readFindings(dir) };
}

/**
 * Every error-severity finding of the run, with its confidence, from the
 * JSON report the scan wrote — the input to confidence calibration (the
 * Fifty, move 09). `null` when the report is missing: the calibration is
 * then reported as not measured, never as "no findings".
 */
function readFindings(dir) {
  const file = path.join(dir, '.gatetest', 'reports', 'gatetest-report-latest.json');
  try {
    return findingsFromReport(JSON.parse(fs.readFileSync(file, 'utf8')), ruleIdentity);
  } catch { // error-ok — reported as calibration: null by the caller
    return null;
  }
}

/**
 * Remove the clone directory. Never throws: the verdict was computed before
 * this runs, and a cleanup failure is not a measurement. On CI a Gradle
 * daemon left behind by ktor's timed-out test run was still writing into
 * the directory, `rmSync` threw ENOTEMPTY, and a gate that had PASSED on
 * all sixteen repos exited 1 (2026-09-05). Retries cover a process that is
 * still exiting; anything else is reported and left for the runner.
 */
function removeTmp(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
    return true;
  } catch (err) { // error-ok — reported below, the gate's verdict stands
    process.stderr.write(`(cleanup) could not remove ${dir}: ${err.message} — the verdict above stands\n`);
    return false;
  }
}

/**
 * Lower every ceiling above its measured count to that count. Pure: mutates
 * the manifest object it is given and returns the changes. Never raises a
 * ceiling (a higher count is a FAIL the caller must not have swallowed),
 * never touches a floor (recall is a floor, not a target).
 * @param {{repos: Array<{name:string, maxBlocking?:number, minBlocking?:number}>}} manifest
 * @param {Array<{name:string, blocking:number}>} measured
 * @returns {Array<{name:string, from:number, to:number}>}
 */
function ratchetManifest(manifest, measured) {
  const byName = new Map(measured.map((m) => [m.name, m.blocking]));
  const changes = [];
  for (const repo of manifest.repos) {
    if (typeof repo.maxBlocking !== 'number') continue;
    const count = byName.get(repo.name);
    if (typeof count !== 'number' || count >= repo.maxBlocking) continue;
    changes.push({ name: repo.name, from: repo.maxBlocking, to: count });
    repo.maxBlocking = count;
  }
  return changes;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const repos = opts.repo ? manifest.repos.filter((r) => r.name === opts.repo) : manifest.repos;
  if (repos.length === 0) {
    console.error(`No repo named "${opts.repo}" in ${path.relative(ROOT, MANIFEST)}`);
    process.exit(2);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-realworld-'));
  const failures = [];
  const measured = [];
  const allFindings = [];

  try {
    for (const repo of repos) {
      const dest = path.join(tmp, repo.name);
      process.stdout.write(`\n--- ${repo.name} @ ${repo.sha.slice(0, 8)}\n    ${repo.why}\n`);
      let blocking;
      let findings;
      try {
        clone(repo, dest);
        ({ blocking, findings } = scan(dest));
      } catch (err) {
        // A repo we could not measure is a failure, never a silent pass —
        // that confusion is the whole reason this file exists.
        failures.push(`${repo.name}: could not be measured — ${err.message}`);
        console.log(`    ERROR  ${err.message}`);
        continue;
      }

      measured.push({
        name: repo.name, url: repo.url, sha: repo.sha, why: repo.why, blocking,
        ...(typeof repo.maxBlocking === 'number' ? { ceiling: repo.maxBlocking } : {}),
        ...(typeof repo.minBlocking === 'number' ? { floor: repo.minBlocking } : {}),
        // Error findings the confidence signals kept off the gate (null:
        // the JSON report could not be read, so not measured).
        softened: findings ? findings.length - blocking : null,
      });
      allFindings.push({
        name: repo.name,
        kind: typeof repo.minBlocking === 'number' ? 'recall' : 'precision',
        ...(typeof repo.minBlocking === 'number' ? { floor: repo.minBlocking } : {}),
        findings,
      });

      if (typeof repo.maxBlocking === 'number') {
        const ok = blocking <= repo.maxBlocking;
        console.log(`    ${ok ? 'ok  ' : 'FAIL'}   ${blocking} blocking (ceiling ${repo.maxBlocking})`);
        if (!ok) {
          failures.push(
            `${repo.name}: ${blocking} blocking findings, ceiling is ${repo.maxBlocking}. ` +
            'Something started over-firing on code we do not control. Fix the rule — ' +
            'do not raise the ceiling.',
          );
        }
      } else if (typeof repo.minBlocking === 'number') {
        const ok = blocking >= repo.minBlocking;
        console.log(`    ${ok ? 'ok  ' : 'FAIL'}   ${blocking} blocking (floor ${repo.minBlocking})`);
        if (!ok) {
          failures.push(
            `${repo.name}: only ${blocking} blocking findings, floor is ${repo.minBlocking}. ` +
            'Recall dropped — a deliberately vulnerable app stopped failing. A quieter ' +
            'scanner is not a better one.',
          );
        }
      }
    }
  } finally {
    if (!opts.keep) removeTmp(tmp);
  }

  if (opts.update) {
    console.log('\nMeasured counts (for updating the manifest deliberately):');
    for (const m of measured) console.log(`  ${m.name.padEnd(10)} ${m.blocking}`);
  }

  // --ratchet: the Fifty, move 06. Ceilings only go down, and a run that
  // measured every repo and breached nothing is the evidence. Lower each
  // ceiling to this run's count, never raise one, never touch a floor, and
  // write the manifest — the nightly ships it on the rolling PR so a human
  // still names each drop before it merges.
  if (opts.ratchet) {
    if (measured.length !== repos.length || failures.length) {
      console.log('\nNOT ratcheting: a repo could not be measured or a ceiling/floor was breached.');
    } else {
      const changes = ratchetManifest(manifest, measured);
      if (changes.length === 0) {
        console.log('\nRatchet: every ceiling already equals its measured count.');
      } else {
        fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
        console.log(`\nRatchet: ${changes.length} ceiling(s) lowered in ${path.relative(ROOT, MANIFEST)}:`);
        for (const c of changes) console.log(`  ${c.name.padEnd(18)} ${c.from} -> ${c.to}`);
        for (const m of measured) if (typeof m.ceiling === 'number') m.ceiling = manifest.repos.find((r) => r.name === m.name).maxBlocking;
      }
    }
  }

  // --write-json <path>: the public precision table. Same contract as
  // scripts/generate-site-stats.js — every number here is this run's own
  // measurement, the page imports the file at build time, and nothing is
  // typed by hand. Written only when every repo was measured: a partial
  // table that omits a failed clone would read as "those repos were fine".
  if (opts.writeJson) {
    if (measured.length !== repos.length) {
      console.log(`\nNOT writing ${opts.writeJson}: ${repos.length - measured.length} repo(s) could not be measured.`);
    } else {
      let engineCommit = 'unknown';
      try {
        engineCommit = require('child_process')
          .execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
      } catch { /* error-ok: a missing .git only costs the commit label on the page */ }
      const out = {
        generatedAt: new Date().toISOString(),
        source: 'scripts/real-world-precision.js',
        note: 'Measured on every run against pinned commits of repositories we do not control. Ceilings only ratchet down. Do not hand-edit — run the script.',
        engineVersion: require(path.join(ROOT, 'package.json')).version,
        engineCommit,
        repos: measured,
        // Confidence calibration (move 09): the block threshold measured
        // against the same run. Null, and said so, if any report could not
        // be read — a calibration on a partial corpus would be typed, not
        // measured.
        calibration: allFindings.every((r) => Array.isArray(r.findings))
          ? calibrate({ repos: allFindings, threshold: BLOCK_THRESHOLD })
          : null,
        calibrationNote: allFindings.every((r) => Array.isArray(r.findings))
          ? `Every error-severity finding of this run, by confidence, against the shipped block threshold ${BLOCK_THRESHOLD}. Written by the same run as the table above.`
          : 'Not measured: a JSON report could not be read on this run.',
      };
      fs.mkdirSync(path.dirname(opts.writeJson), { recursive: true });
      fs.writeFileSync(opts.writeJson, `${JSON.stringify(out, null, 2)}\n`);
      console.log(`\nWrote ${path.relative(ROOT, opts.writeJson)} (${measured.length} repos, engine ${out.engineVersion}@${engineCommit})`);
    }
  }

  console.log('');
  if (failures.length) {
    console.log('REAL-WORLD PRECISION GATE: FAILED\n');
    for (const f of failures) console.log(`  - ${f}`);
    console.log('');
    process.exit(1);
  }
  console.log(`REAL-WORLD PRECISION GATE: PASSED (${measured.length} repo(s))\n`);
}

if (require.main === module) main();

module.exports = { removeTmp, ratchetManifest };
