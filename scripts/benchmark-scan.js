#!/usr/bin/env node
'use strict';

/**
 * Scan-speed benchmark harness — Known Issue #31.
 *
 * Measures REAL wall-clock times for the quick and full suites against
 * representative repos, so public speed claims are backed by evidence
 * (or honestly revised). Bible steer (Craig 2026-07-08): honesty over
 * bravado — big repos take longer and that's common sense.
 *
 * Usage:
 *   node scripts/benchmark-scan.js <repoDir> [repoDir2 ...]
 *     [--runs 3] [--suites quick,full] [--out docs/BENCHMARKS.md]
 *
 * Each (repo × suite) runs N times; we report min/median/max wall ms.
 * Results append a dated, machine-stamped section to the output file.
 * Zero dependencies. Runs the CLI exactly as a customer would
 * (`--report-only` so a failing gate doesn't skew timing with exit
 * handling).
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'bin', 'gatetest.js');

function parseArgs(argv) {
  const repos = [];
  let runs = 3;
  let suites = ['quick', 'full'];
  let out = path.join(__dirname, '..', 'docs', 'BENCHMARKS.md');
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs') runs = Number(argv[++i]) || 3;
    else if (a === '--suites') suites = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--out') out = path.resolve(argv[++i]);
    else repos.push(path.resolve(a));
  }
  return { repos, runs, suites, out };
}

function countSourceFiles(dir) {
  let count = 0;
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!skip.has(e.name)) stack.push(path.join(current, e.name));
      } else if (/\.(js|jsx|ts|tsx|py|go|rs|rb|java|css|html|json|yml|yaml|md)$/i.test(e.name)) {
        count += 1;
      }
    }
  }
  return count;
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function fmtMs(ms) {
  return ms >= 60_000
    ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
    : `${(ms / 1000).toFixed(1)}s`;
}

function benchOne(repoDir, suite) {
  const started = Date.now();
  const res = spawnSync(process.execPath, [CLI, '--suite', suite, '--report-only'], {
    cwd: repoDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30 * 60_000, // 30-minute hard ceiling per run — honesty has limits
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
  const wallMs = Date.now() - started;
  return {
    wallMs,
    timedOut: res.error?.code === 'ETIMEDOUT',
    exitCode: res.status,
  };
}

function main() {
  const { repos, runs, suites, out } = parseArgs(process.argv);
  if (repos.length === 0) {
    console.error('Usage: node scripts/benchmark-scan.js <repoDir> [...] [--runs N] [--suites quick,full] [--out FILE]');
    process.exit(1);
  }

  const rows = [];
  for (const repo of repos) {
    if (!fs.existsSync(repo)) {
      console.error(`skip (not found): ${repo}`);
      continue;
    }
    const files = countSourceFiles(repo);
    for (const suite of suites) {
      const timings = [];
      let timedOut = false;
      for (let i = 0; i < runs; i++) {
        process.stdout.write(`bench ${path.basename(repo)} ${suite} run ${i + 1}/${runs}... `);
        const r = benchOne(repo, suite);
        if (r.timedOut) {
          timedOut = true;
          console.log('TIMED OUT (30m ceiling)');
          break;
        }
        timings.push(r.wallMs);
        console.log(fmtMs(r.wallMs));
      }
      rows.push({
        repo: path.basename(repo),
        files,
        suite,
        runs: timings.length,
        min: timings.length ? Math.min(...timings) : null,
        median: timings.length ? median(timings) : null,
        max: timings.length ? Math.max(...timings) : null,
        timedOut,
      });
    }
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const lines = [];
  lines.push('');
  lines.push(`## Benchmark run — ${stamp}`);
  lines.push('');
  lines.push(`Machine: ${os.platform()} ${os.arch()}, ${os.cpus()[0]?.model || 'unknown CPU'} × ${os.cpus().length}, ${Math.round(os.totalmem() / 1024 ** 3)} GB RAM, Node ${process.version}`);
  lines.push('');
  lines.push('| Repo | Source files | Suite | Runs | Min | Median | Max |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    lines.push(
      r.timedOut
        ? `| ${r.repo} | ${r.files} | ${r.suite} | — | — | >30m (timed out) | — |`
        : `| ${r.repo} | ${r.files} | ${r.suite} | ${r.runs} | ${fmtMs(r.min)} | ${fmtMs(r.median)} | ${fmtMs(r.max)} |`
    );
  }
  lines.push('');

  const header = fs.existsSync(out)
    ? ''
    : '# GateTest Scan Benchmarks\n\nReal measured wall-clock times. These numbers back (or bound) every public speed claim — Known Issue #31.\n';
  fs.appendFileSync(out, header + lines.join('\n'));
  console.log(`\nResults appended to ${out}`);
  console.table(rows.map((r) => ({ ...r, min: r.min && fmtMs(r.min), median: r.median && fmtMs(r.median), max: r.max && fmtMs(r.max) })));
}

main();
