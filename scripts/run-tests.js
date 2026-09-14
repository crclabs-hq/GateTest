#!/usr/bin/env node
'use strict';
/**
 * The test runner that cannot report success while doing nothing.
 *
 * `node --test --test-force-exit` was adopted (180bf7c) because one test file
 * left a handle open and the bare runner then hung for hours. Measured
 * 2026-09-05: the flag exits the runner as soon as the tests it has HEARD OF
 * are done — a child still streaming its later suites is cut off, its tests
 * are never counted, and the exit code is 0. Four files, three runs of the
 * same tree: 50, 77, 61 tests. One file alone: 63, 40, 33, 63 names. Every
 * `# fail 0` produced that way was evidence about the tests that happened to
 * finish first, not about the suite (Doctrine §1).
 *
 * This runner spawns one plain `node --test` per file (no force-exit), reads
 * its TAP stream, and ends the child only after the final summary line has
 * been read — so a leaked handle is killed on OUR terms, after every result
 * is in. A file whose stream ends without that summary (crash, `process.exit`
 * mid-run, the per-file wall clock) is a FAILURE, never a silent zero.
 *
 * A leaked handle looks different by Node version. Node ≤22 applies
 * --test-timeout to the file itself: the file is cancelled, the summary is
 * printed, the child is ended after it. Node 24 applies the timeout only to
 * the tests inside the file (measured 2026-09-14: a leaked `setInterval`
 * kept `node --test` alive with no summary, ever), so the file runs into
 * the file timeout. Silence is not a usable signal for it — a module's
 * synchronous execSync can hold a file quiet for minutes — so the runner
 * waits the file timeout out, then ends the TEST process (the grandchild
 * `node --test` spawned, where the leak lives) rather than the parent: the
 * parent then reports the file as failed and prints its summary with every
 * result it had, and the runner reads that summary before ending it. Only
 * a parent that still prints nothing is killed outright, as "did not finish".
 *
 * Usage: node scripts/run-tests.js [--timeout ms] [--file-timeout ms]
 *          [--concurrency n] [--out path] <files or globs…>
 * Globs are expanded here: cmd.exe hands `tests/*.test.js` to node as a
 * literal, and Node's own `--test` then ran all 486 files as ONE file of
 * this runner (`# files 1`) — every per-file verdict gone on Windows.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SUMMARY_RE = /^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/;
const END_RE = /^# duration_ms /;
const RESULT_RE = /^\s*(not )?ok \d+ - (.*)$/;
const GLOB_RE = /[*?]/;
const WIN = process.platform === 'win32';
const SUMMARY_GRACE_MS = 5000;

/**
 * A literal path is kept as it is. A pattern with `*` / `?` in its last
 * segment is matched over that directory here — no dependency, no
 * ExperimentalWarning — and anything richer (`**`, a wildcard directory)
 * goes to fs.globSync where Node has it (22+). A pattern matching nothing is
 * an error: a glob that silently expands to no files is a green empty run.
 */
function expandGlob(arg) {
  if (!GLOB_RE.test(arg) || fs.existsSync(arg)) return [arg];
  const dir = path.dirname(arg);
  const base = path.basename(arg);
  let matches;
  if (!GLOB_RE.test(dir) && !base.includes('**')) {
    const re = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/\\\\]*').replace(/\?/g, '[^/\\\\]')}$`);
    matches = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => path.join(dir, f)) : [];
  } else if (typeof fs.globSync === 'function') {
    matches = fs.globSync(arg);
  } else {
    throw new Error(`cannot expand ${arg}: wildcards outside the last path segment need fs.globSync (Node 22+), this is ${process.version}`);
  }
  if (!matches.length) throw new Error(`${arg} matched no files`);
  return matches.map((m) => m.split(path.sep).join('/')).sort();
}

function parseArgs(argv) {
  const opts = { timeout: 60000, fileTimeout: 15 * 60 * 1000, concurrency: Math.max(1, Math.min(4, os.cpus().length)), out: null, files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--timeout') opts.timeout = Number(argv[++i]);
    else if (a === '--file-timeout') opts.fileTimeout = Number(argv[++i]);
    else if (a === '--concurrency') opts.concurrency = Number(argv[++i]);
    else if (a === '--out') opts.out = argv[++i];
    else opts.files.push(...expandGlob(a));
  }
  if (!opts.files.length) opts.files = fs.readdirSync('tests').filter((f) => f.endsWith('.test.js')).map((f) => path.join('tests', f));
  return opts;
}

/**
 * The TAP reporter escapes `\` and `#` in a test name, so the file's own
 * entry reads `C:\\dev\\x.test.js` on Windows; compared raw it never matched
 * and an empty file counted its own entry as a named test (2026-09-14).
 */
const tapUnescape = (name) => name.replace(/\\([\\#])/g, '$1');
const pathKey = (p) => (WIN ? path.resolve(p).toLowerCase() : path.resolve(p));

/** One TAP line from the child: totals, named results, and the end marker. */
function absorbLine(res, line, child) {
  res.lines.push(line);
  const m = SUMMARY_RE.exec(line);
  if (m) res[m[1]] = Number(m[2]);
  // Node reports the FILE as a test of its own when it has no tests (or
  // when its event loop never drained) — a file with nothing in it says
  // `# tests 1 / # pass 1`. Count results that are not the file itself.
  const r = RESULT_RE.exec(line);
  if (r && pathKey(tapUnescape(r[2].trim())) !== res.selfKey) res.named += 1;
  if (END_RE.test(line)) {
    // Every result is in. A leaked timer / socket / child in the test
    // process is the runner's problem no longer — end it now.
    res.finished = true;
    child.kill('SIGTERM');
    setTimeout(() => killTree(child), 2000).unref();
  }
}

/**
 * Kill the child AND what it spawned. `node --test` runs the file in a
 * grandchild; ending only the parent orphans it, leak and all (neither
 * platform forwards the signal). Windows walks the tree with taskkill;
 * POSIX children are spawned as their own process group so one signal
 * reaches every member.
 */
function killTree(child) {
  if (child.exitCode !== null || child.signalCode) return;
  if (WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}

/**
 * End the TEST process under a `node --test` parent and leave the parent to
 * report it. POSIX: SIGTERM to the parent — Node's runner handles it by
 * killing its child and printing the summary (measured: the file is
 * reported `not ok … exitCode 143`, its earlier results kept). Windows has
 * no signal to hand a parent, so the parent's direct children are found
 * and force-killed; the parent then sees its child die and reports the same.
 */
function endTestProcess(child) {
  if (child.exitCode !== null || child.signalCode) return;
  if (!WIN) { child.kill('SIGTERM'); return; }
  const q = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${child.pid}').ProcessId`], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  for (const pid of String(q.stdout || '').split(/\s+/).filter((p) => /^\d+$/.test(p))) {
    spawnSync('taskkill', ['/pid', pid, '/t', '/f'], { stdio: 'ignore' });
  }
}

/** Spawn one plain `node --test` for a file, TAP on stdout. */
function spawnTestFile(file, opts) {
  // NODE_TEST_CONTEXT is what a `node --test` parent stamps on its children;
  // inherited here it makes the child refuse to run ("called recursively").
  // Dropping it lets this runner be invoked from inside a test.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawn(process.execPath, ['--test', `--test-timeout=${opts.timeout}`, '--test-reporter=tap', file], {
    stdio: ['ignore', 'pipe', 'pipe'], env, detached: !WIN,
  });
}

// Children in flight — an interrupted runner takes them down with it, since
// a detached process group would otherwise outlive it.
const live = new Set();
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { for (const c of live) killTree(c); process.exit(sig === 'SIGINT' ? 130 : 143); });
}

/** Run one file; resolve with its parsed result. Never rejects. */
function runFile(file, opts) {
  return new Promise((resolve) => {
    const res = { file, tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0, named: 0, finished: false, exitCode: null, lines: [], selfKey: pathKey(file) };
    const child = spawnTestFile(file, opts);
    live.add(child);
    let buf = '';
    let done = false;
    let grace = null;
    const finish = (why) => {
      if (done) return;
      done = true;
      live.delete(child);
      clearTimeout(timer);
      clearTimeout(grace);
      res.why = why;
      resolve(res);
    };
    const timer = setTimeout(() => {
      res.timedOut = true;
      res.lines.push(`# runner: still running at the file timeout (${opts.fileTimeout}ms) — ending the test process so the summary can be read`);
      endTestProcess(child);
      grace = setTimeout(() => killTree(child), SUMMARY_GRACE_MS);
    }, opts.fileTimeout);
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { absorbLine(res, buf.slice(0, nl), child); buf = buf.slice(nl + 1); }
    });
    child.stderr.on('data', (d) => { for (const l of String(d).split('\n')) if (l) res.lines.push(`stderr: ${l}`); });
    child.on('error', (err) => { res.lines.push(`spawn error: ${err.message}`); finish('spawn-error'); });
    child.on('close', (code, signal) => {
      if (buf) absorbLine(res, buf, child);
      res.exitCode = code;
      res.signal = signal;
      finish(res.finished ? (res.timedOut ? 'file-timeout-summary' : 'summary') : (res.timedOut ? 'file-timeout' : 'ended-before-summary'));
    });
  });
}

const LEAK = 'a leaked timer, socket or child kept its event loop alive';

function verdict(r) {
  if (!r.finished) return r.timedOut ? `did not finish within the file timeout` : `ended before its summary (exit ${r.exitCode}${r.signal ? `, ${r.signal}` : ''}) — its tests are NOT counted`;
  if (r.timedOut) return `${r.fail} failing, ${r.cancelled} cancelled — still running at the file timeout, so its test process was ended and the results it had are counted (${LEAK}, or a test never ended — run it alone to tell which)`;
  if (r.fail > 0 || r.cancelled > 0) return `${r.fail} failing, ${r.cancelled} cancelled${r.cancelled ? ` (Node cancels a file when --test-timeout elapses for the file itself: ${LEAK}, or its tests took longer than the timeout — run it alone to tell which)` : ''}`;
  if (r.tests === 0 || r.named === 0) return 'reported zero tests';
  return null;
}

function printFailure(r, reason) {
  process.stdout.write(`\n✗ ${r.file}: ${reason}\n`);
  const out = r.lines;
  for (let i = 0; i < out.length; i += 1) {
    if (/^\s*not ok /.test(out[i])) {
      for (let j = i; j < Math.min(out.length, i + 14); j += 1) process.stdout.write(`    ${out[j]}\n`);
    }
  }
  if (!r.finished) for (const l of out.slice(-12)) process.stdout.write(`    ${l}\n`);
}

async function pool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i]); }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return results;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  const results = await pool(opts.files, opts.concurrency, (f) => runFile(f, opts));
  const totals = { files: results.length, tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0, unfinished: 0, failedFiles: 0 };
  let bad = 0;
  for (const r of results) {
    for (const k of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) totals[k] += r[k];
    if (!r.finished) totals.unfinished += 1;
    const reason = verdict(r);
    if (reason) { bad += 1; totals.failedFiles += 1; printFailure(r, reason); }
  }
  if (opts.out) fs.writeFileSync(opts.out, results.map((r) => `# ${r.file}\n${r.lines.join('\n')}\n`).join('\n'));
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write(`\n# files ${totals.files}\n# tests ${totals.tests}\n# pass ${totals.pass}\n# fail ${totals.fail}\n# cancelled ${totals.cancelled}\n# skipped ${totals.skipped}\n# todo ${totals.todo}\n# files that did not finish ${totals.unfinished}\n# duration_s ${secs}\n`);
  if (bad) {
    process.stdout.write(`\nSUITE: FAILED — ${bad} of ${totals.files} file(s) failed or did not finish\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`\nSUITE: PASSED — every one of ${totals.files} file(s) reported its summary\n`);
  }
}

main().catch((err) => { process.stderr.write(`run-tests: ${err.message}\n`); process.exitCode = 2; });
