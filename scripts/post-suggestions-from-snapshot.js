#!/usr/bin/env node
/**
 * Entry script invoked by action.yml after AI auto-repair runs.
 *
 * Reads `.gatetest/fix-patches.json` (the snapshot written by
 * `applyPatches` in lib/ai-ci-fixer-core.js), figures out the GitHub PR
 * context from the workflow environment, and posts one inline review
 * comment with a ```suggestion``` block per patched file.
 *
 * The reviewer can then click "Commit suggestion" in GitHub to apply
 * the fix without leaving the UI — the headline feature for HN launch.
 *
 * Failures here are NEVER fatal. The auto-repair PR opens regardless;
 * inline suggestions are an additive surface, not a critical path.
 *
 * Required env (Actions context):
 *   GITHUB_TOKEN       — token with pull-requests: write
 *   GITHUB_REPOSITORY  — owner/repo
 *   GITHUB_EVENT_NAME  — must be `pull_request` (or `pull_request_target`)
 *   GITHUB_REF         — `refs/pull/<N>/merge` — used to extract PR number
 *   GITHUB_SHA         — head commit SHA the suggestions anchor to
 *
 * For non-PR triggers (push, workflow_dispatch), this script no-ops
 * silently. For workflow_run triggers (downstream of another workflow),
 * a follow-up will plumb the upstream PR number; the no-op shape is
 * the safe interim behaviour.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { postInlineSuggestionsForPatches } = require('./post-inline-suggestions');

function log(...args) { console.log('[post-suggestions]', ...args); }

async function main() {
  const eventName = process.env.GITHUB_EVENT_NAME || '';
  const isPrTrigger = eventName === 'pull_request' || eventName === 'pull_request_target';
  if (!isPrTrigger) {
    log(`event is "${eventName}" — only pull_request triggers post inline suggestions today. Skipping.`);
    return 0;
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    log('GITHUB_TOKEN not present. Skipping.');
    return 0;
  }

  const repoSlug = process.env.GITHUB_REPOSITORY || '';
  const [owner, repo] = repoSlug.split('/');
  if (!owner || !repo) {
    log(`GITHUB_REPOSITORY missing or malformed: "${repoSlug}". Skipping.`);
    return 0;
  }

  // Extract PR number from `refs/pull/<N>/merge` (the canonical form
  // for pull_request-triggered workflows).
  const ref = process.env.GITHUB_REF || '';
  const refMatch = ref.match(/^refs\/pull\/(\d+)\/(merge|head)$/);
  if (!refMatch) {
    log(`GITHUB_REF doesn't look like a PR ref: "${ref}". Skipping.`);
    return 0;
  }
  const prNumber = Number(refMatch[1]);

  // For pull_request triggers, GITHUB_SHA is the MERGE commit, not the
  // PR head. GitHub's inline-comment API requires the PR HEAD SHA — the
  // PR's `head.sha`. We grab it from GITHUB_HEAD_REF env (the PR head
  // branch) — actually, the cleanest is to fetch the PR and read its
  // head.sha. But the simplest robust shortcut: `pull_request.head.sha`
  // is exposed via GITHUB_EVENT_PATH (the event payload JSON). Read it.
  const headSha = readHeadShaFromEvent() || process.env.GITHUB_SHA;
  if (!headSha) {
    log('Could not determine head SHA. Skipping.');
    return 0;
  }

  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const patchFile = path.join(workspace, '.gatetest', 'fix-patches.json');
  if (!fs.existsSync(patchFile)) {
    log(`no patch snapshot at ${patchFile} — fix engine did not produce patches. Skipping.`);
    return 0;
  }

  log(`posting inline suggestions for ${owner}/${repo}#${prNumber} (head=${headSha.slice(0, 7)})`);

  try {
    const r = await postInlineSuggestionsForPatches({
      patchFile: '.gatetest/fix-patches.json',
      workspace,
      owner,
      repo,
      prNumber,
      headSha,
      token,
      fetchImpl: globalThis.fetch,
    });
    log(`outcome: posted=${r.posted}, skipped=${r.skipped}, errors=${r.errors}, total=${r.total}`);
    if (r.details && r.details.length > 0) {
      for (const d of r.details) log('  •', d);
    }
  } catch (err) {
    log('unexpected error (non-fatal):', err && err.message ? err.message : err);
  }
  return 0;
}

function readHeadShaFromEvent() {
  try {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath || !fs.existsSync(eventPath)) return null;
    const event = JSON.parse(fs.readFileSync(eventPath, 'utf-8'));
    return (event && event.pull_request && event.pull_request.head && event.pull_request.head.sha) || null;
  } catch {
    return null;
  }
}

main()
  .then((code) => process.exit(code || 0))
  .catch((err) => {
    log('top-level reject (non-fatal):', err && err.message ? err.message : err);
    process.exit(0);
  });
