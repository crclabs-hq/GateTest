#!/usr/bin/env node
'use strict';

/**
 * verify-deploy — CLI over src/core/verify-deploy.js.
 *
 *   node scripts/ops/verify-deploy.js                         # compare with origin/main
 *   node scripts/ops/verify-deploy.js --expect <sha>          # compare with one commit
 *   node scripts/ops/verify-deploy.js --grace-minutes 30      # tolerate a deploy in flight
 *   node scripts/ops/verify-deploy.js --json                  # machine-readable report
 *   node scripts/ops/verify-deploy.js --out verify.json       # ...and write it to a file
 *
 * Exit 0 in sync · 1 lagging / not on main · 2 unreachable. Under
 * GITHUB_ACTIONS it also emits an ::error annotation and writes the report
 * fields to $GITHUB_OUTPUT. Run by deploy-box.yml (verify job) and
 * readiness-probe.yml; the verdict logic and the why live in the core file.
 */

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const core = require('../../src/core/verify-deploy');

const { EXIT, DEFAULT_TIMEOUT_MS } = core;

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

/** `git(args)` returns trimmed stdout or throws — the whole adapter contract. */
function defaultGit(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
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
    report = await core.verify(opts, { git: defaultGit });
  } catch (err) {
    console.error(`verify-deploy: ${err.message}`);
    process.exit(EXIT.UNREACHABLE);
  }
  if (opts.out) fs.writeFileSync(opts.out, `${JSON.stringify(report, null, 2)}\n`);
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else console.log(core.render(report));
  annotate(report, process.env);
  await drainFetchSockets();
  process.exitCode = report.exitCode;
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, defaultGit, annotate };
