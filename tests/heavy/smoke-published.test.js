'use strict';
/**
 * scripts/ops/smoke-published.js against the REAL registries.
 *
 * This is the one test in the repo that installs what npm actually serves —
 * a fresh temp dir, an empty npm cache, `npm install @gatetest/cli@latest`,
 * `npx -y @gatetest/mcp-server@latest` — and asks the Marketplaces and
 * ghcr.io what they list. It does not assert that every channel PASSES:
 * today the bare-npx form and the ghcr image are legitimately KNOWN GAPS
 * until 1.61.1 is on npm, and the published mcp-server 1.1.3 is a real FAIL.
 * What it asserts is that the smoke itself is sound: it finishes inside its
 * budget, exits 0 or 1 (never 2 = "could not run", never a throw), reports
 * every channel exactly once, and its exit code matches its own rows.
 *
 * Needs the network; ~2-4 minutes on a cold cache.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'ops', 'smoke-published.js');
const { RESULT, CHANNELS } = require(SCRIPT);
const BUDGET_MS = 12 * 60 * 1000;

describe('post-publish smoke, live', () => {
  it('runs against the registries, exits 0 or 1, and its JSON accounts for every channel', { timeout: BUDGET_MS + 30_000 }, () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--json'], { encoding: 'utf8', timeout: BUDGET_MS, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(r.error, undefined, `spawn error / timeout: ${r.error && r.error.message}\nstderr:\n${r.stderr}`);
    assert.ok(r.status === 0 || r.status === 1, `expected exit 0 or 1, got ${r.status} (signal ${r.signal})\nstderr:\n${r.stderr}\nstdout:\n${r.stdout.slice(0, 2000)}`);
    assert.doesNotMatch(r.stderr, /smoke-published could not run/, r.stderr);

    let report;
    try {
      report = JSON.parse(r.stdout);
    } catch (err) {
      assert.fail(`--json did not print JSON (${err.message}):\n${r.stdout.slice(0, 2000)}`);
    }
    const expectedIds = CHANNELS.flatMap((c) => c.ids).sort();
    assert.deepEqual(report.rows.map((x) => x.id).sort(), expectedIds, 'every channel reported exactly once');
    for (const row of report.rows) {
      assert.ok(Object.values(RESULT).includes(row.result), `${row.id}: unknown result ${row.result}`);
      assert.ok(typeof row.detail === 'string' && row.detail.length > 0, `${row.id}: a row without a detail is a verdict without evidence`);
      assert.ok(typeof row.channel === 'string' && row.channel.length > 0);
    }
    const fails = report.rows.filter((x) => x.result === RESULT.FAIL);
    assert.equal(r.status, fails.length ? 1 : 0, `exit code ${r.status} disagrees with ${fails.length} FAIL row(s): ${JSON.stringify(fails)}`);
    assert.equal(report.exitCode, r.status);
    assert.match(report.publishedCliVersion || '', /^\d+\.\d+\.\d+/, 'npm view @gatetest/cli version must be readable — otherwise the gap rows cannot be classified');

    // Print the table so a reader of the TAP stream sees the state of the channels, not just "ok".
    for (const row of report.rows) process.stderr.write(`  ${row.result.padEnd(11)} ${row.id.padEnd(26)} ${row.version.padEnd(10)} ${row.detail.slice(0, 160)}\n`);
  });
});
