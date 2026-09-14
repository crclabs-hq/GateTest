#!/usr/bin/env node
/**
 * fire-test-webhook — the first-real-push drill, as one command.
 *
 * Signs a realistic GitHub push event with GITHUB_WEBHOOK_SECRET and fires
 * it at the production webhook, then watches BOTH observable surfaces:
 *   - /api/status queue counts (done/dead deltas — is the loop moving?)
 *   - the GitHub commit-status API for the pushed SHA (what the CUSTOMER
 *     sees: `pending` at enqueue, pass/fail at completion)
 *
 * Run it ON THE BOX (it needs GITHUB_WEBHOOK_SECRET from website/.env.local):
 *
 *   node scripts/ops/fire-test-webhook.js --repo octocat/Hello-World
 *
 * This is the 2026-08-06 end-to-end test, repeatable. That run proved the
 * pipeline from the public edge to the GitHub API call and died there on a
 * dead credential; the moment GATETEST_PRIVATE_KEY (or GITHUB_TOKEN) is
 * real, this script is how we watch the first push flow all the way.
 *
 * Options:
 *   --base   default https://gatetest.io
 *   --repo   owner/name of a PUBLIC repo (default octocat/Hello-World)
 *   --wait   seconds to watch before giving up (default 300)
 */

'use strict';

const crypto = require('crypto');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BASE = arg('base', 'https://gatetest.io').replace(/\/$/, '');
const REPO = arg('repo', 'octocat/Hello-World');
const WAIT_S = Number(arg('wait', '300')) || 300;
const SECRET = process.env.GITHUB_WEBHOOK_SECRET || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[fire-test-webhook] ${msg}`);

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': 'GateTest-drill/1.0', ...headers }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

async function main() {
  if (!SECRET) {
    console.error('GITHUB_WEBHOOK_SECRET is not set — run this on the box, or export the secret first.');
    process.exit(1);
  }

  // 1. A real, fetchable SHA — the scan must be able to download the repo.
  const repoInfo = await getJson(`https://api.github.com/repos/${REPO}`);
  const branch = repoInfo.default_branch || 'main';
  const branchInfo = await getJson(`https://api.github.com/repos/${REPO}/branches/${encodeURIComponent(branch)}`);
  const sha = branchInfo.commit && branchInfo.commit.sha;
  if (!/^[0-9a-f]{40}$/i.test(sha || '')) throw new Error(`could not resolve head sha for ${REPO}@${branch}`);
  log(`target ${REPO}@${branch} → ${sha.slice(0, 12)}`);

  // 2. Baseline queue counts.
  const before = (await getJson(`${BASE}/api/status`)).queue || {};
  log(`queue before: ${JSON.stringify(before)}`);

  // 3. Fire the signed push.
  const delivery = `drill-${crypto.randomUUID()}`;
  const body = JSON.stringify({
    after: sha,
    ref: `refs/heads/${branch}`,
    repository: { full_name: REPO },
    head_commit: { id: sha },
  });
  const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  const res = await fetch(`${BASE}/api/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'push',
      'X-GitHub-Delivery': delivery,
      'X-Hub-Signature-256': sig,
      'User-Agent': 'GateTest-drill/1.0',
    },
    body,
    signal: AbortSignal.timeout(20000),
  });
  const resBody = await res.text();
  log(`webhook → ${res.status} ${resBody.slice(0, 200)}`);
  if (res.status !== 202 && res.status !== 200) {
    console.error('webhook did not accept the event — stop here and read the response above.');
    process.exit(1);
  }

  // 4. Watch both surfaces until the job resolves or the clock runs out.
  const deadline = Date.now() + WAIT_S * 1000;
  let lastStatusLine = '';
  while (Date.now() < deadline) {
    await sleep(10_000);
    let queue = {};
    try { queue = (await getJson(`${BASE}/api/status`)).queue || {}; } catch { /* error-ok — transient status-endpoint failure — the loop retries in 10s and prints the last known queue */ }

    let ghStates = [];
    try {
      const statuses = await getJson(`https://api.github.com/repos/${REPO}/commits/${sha}/statuses`);
      ghStates = statuses
        .filter((s) => /gatetest/i.test(s.context || ''))
        .map((s) => `${s.state} (“${String(s.description || '').slice(0, 60)}”)`);
    } catch { /* error-ok — rate limit or no status yet — the loop retries and prints "(none yet)" */ }

    const line = `queue=${JSON.stringify(queue)} · commit-status=${ghStates[0] || '(none yet)'}`;
    if (line !== lastStatusLine) { log(line); lastStatusLine = line; }

    const doneDelta = (queue.done || 0) - (before.done || 0);
    const deadDelta = (queue.dead || 0) - (before.dead || 0);
    if (doneDelta > 0) {
      log('✅ a job COMPLETED — the loop is closed. Check the commit status above for what the customer sees.');
      process.exit(0);
    }
    if (deadDelta > 0) {
      log('❌ the job DEAD-LETTERED. On the box: SELECT status, last_error FROM scan_queue ORDER BY id DESC LIMIT 3;');
      process.exit(2);
    }
  }
  log(`⏱ no resolution within ${WAIT_S}s. On the box: journalctl -u gatetest-tick.service -f`);
  process.exit(3);
}

main().catch((err) => {
  console.error('[fire-test-webhook] failed:', err && err.message ? err.message : err);
  process.exit(1);
});
