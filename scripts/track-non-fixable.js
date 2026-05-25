#!/usr/bin/env node
/**
 * Entry script invoked by action.yml after gate + auto-fix.
 *
 * Opens one GitHub Issue per error-severity finding the gate flagged
 * but auto-fix didn't patch. Reuses the same idempotent signature-marker
 * pattern as PR comments — re-scans never spawn duplicate issues.
 *
 * Required env (GitHub Actions context):
 *   GITHUB_TOKEN       — token with issues: write
 *   GITHUB_REPOSITORY  — owner/repo
 *
 * Optional:
 *   GATETEST_MAX_ISSUES — cap issues opened per scan (default 20)
 *
 * Failures are never fatal. We `process.exit(0)` no matter what.
 */

'use strict';

const { runIssueTracker } = require('./post-tracking-issues');

function log(...args) { console.log('[track-non-fixable]', ...args); }

async function main() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    log('GITHUB_TOKEN not present. Skipping.');
    return;
  }
  const repoSlug = process.env.GITHUB_REPOSITORY || '';
  const [owner, repo] = repoSlug.split('/');
  if (!owner || !repo) {
    log(`GITHUB_REPOSITORY missing or malformed: "${repoSlug}". Skipping.`);
    return;
  }
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const maxIssues = Number(process.env.GATETEST_MAX_ISSUES || 20);
  const repoUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${repoSlug}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : `https://github.com/${repoSlug}`;

  try {
    const r = await runIssueTracker({
      workspace,
      owner,
      repo,
      token,
      repoUrl,
      maxIssues,
      fetchImpl: globalThis.fetch,
    });
    log(`outcome: opened=${r.opened}, skipped=${r.skipped}, errors=${r.errors}, total=${r.total}`);
    if (r.details && r.details.length > 0) {
      for (const d of r.details.slice(0, 10)) log('  •', d);
      if (r.details.length > 10) log(`  ... and ${r.details.length - 10} more`);
    }
  } catch (err) {
    log('unexpected error (non-fatal):', err && err.message ? err.message : err);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log('top-level reject (non-fatal):', err && err.message ? err.message : err);
    process.exit(0);
  });
