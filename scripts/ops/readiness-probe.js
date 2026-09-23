#!/usr/bin/env node
'use strict';

/**
 * Production readiness probe — CLI wrapper.
 *
 *   node scripts/ops/readiness-probe.js                       # probe gatetest.io
 *   node scripts/ops/readiness-probe.js --expect-head          # ...and require the
 *                                                              #    live commit to
 *                                                              #    match local HEAD
 *   node scripts/ops/readiness-probe.js --base https://staging.example --json
 *
 * Exit code 0 = ready, 1 = a critical step failed. Safe to run on a
 * schedule: every step is a GET, or a POST we expect to be REJECTED. It
 * never completes a payment and never writes customer data.
 *
 * See src/core/readiness-probe.js for why this exists — short version: on
 * 2026-07-27 the whole test suite was green while production was 102
 * commits stale with /billing returning 404.
 */

const { execSync, execFileSync } = require('child_process');
const { runReadinessProbe } = require('../../src/core/readiness-probe');

const C = {
  reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m',
};

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}
const hasFlag = (name) => process.argv.includes(name);

function localHead() {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/**
 * `deployAdapter(args)` -> trimmed stdout or throws — the adapter the
 * deploy/fresh drift check (issue #683) uses to compare the live commit
 * against origin/main. Actions checks out full history (fetch-depth: 0),
 * so this always has something to compare against.
 */
function deployAdapter(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

(async () => {
  const baseUrl = arg('--base', 'https://gatetest.io');
  let expectedCommit = arg('--expect-commit', null);
  if (!expectedCommit && hasFlag('--expect-head')) {
    expectedCommit = localHead();
    if (!expectedCommit) {
      console.error('--expect-head: could not read git HEAD (not a git checkout?)');
      process.exit(2);
    }
  }

  let report;
  try {
    report = await runReadinessProbe({ baseUrl, expectedCommit, deployAdapter });
  } catch (err) {
    console.error(`readiness probe could not run: ${err.message}`);
    process.exit(2);
  }

  if (hasFlag('--json')) {
    console.log(JSON.stringify({ baseUrl, expectedCommit, ...report }, null, 2));
    process.exit(report.ready ? 0 : 1);
  }

  console.log(`\n${C.bold}GateTest readiness probe${C.reset} ${C.dim}${baseUrl}${C.reset}`);
  if (expectedCommit) console.log(`${C.dim}expecting commit ${expectedCommit.slice(0, 12)}${C.reset}`);
  console.log('');

  for (const s of report.steps) {
    if (s.ok) {
      console.log(`  ${C.green}✓${C.reset} ${s.name.padEnd(34)} ${C.dim}${s.detail}${C.reset}`);
    } else {
      const mark = s.severity === 'critical' ? `${C.red}✗${C.reset}` : `${C.yellow}!${C.reset}`;
      console.log(`  ${mark} ${s.name.padEnd(34)} ${s.detail}`);
      if (s.fix) console.log(`      ${C.dim}→ ${s.fix}${C.reset}`);
    }
  }

  const { passed, total, critical, productBroken, brokenAreas } = report.summary;
  console.log('');
  if (report.ready) {
    console.log(`  ${C.green}${C.bold}READY${C.reset}  ${passed}/${total} steps passed\n`);
  } else {
    // "10/11 passed" is technically true and practically useless — it reads
    // as "almost fine" whether the one failure is an unset optional key or a
    // dead product. Lead with WHICH areas are broken, and say plainly when
    // the product itself does not work, because this probe has run red for
    // 100 consecutive scheduled runs and a reader needs to spot a new
    // failure inside a familiar red.
    if (productBroken) {
      console.log(`  ${C.red}${C.bold}PRODUCT BROKEN${C.reset}  the free scan does not work for visitors right now`);
      console.log(`  ${C.dim}This is not a configuration nit — a stranger arriving today gets nothing.${C.reset}`);
    } else {
      console.log(`  ${C.red}${C.bold}NOT READY${C.reset}  ${passed}/${total} passed, ${critical} critical failure(s)`);
    }
    console.log(`  ${C.dim}broken: ${brokenAreas.join(', ')}${C.reset}`);
    console.log(`  ${C.dim}Fix the critical steps above before treating this deployment as live.${C.reset}\n`);
  }
  process.exit(report.ready ? 0 : 1);
})();
