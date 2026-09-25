#!/usr/bin/env node
'use strict';

/**
 * deploy-stalled-issue — upserts the one "Production deploy stalled" GitHub
 * issue (issue #706 part 2).
 *
 * Why: production sat on one commit for 16 hours while main moved ten merges
 * ahead; deploy-box.yml's poll job failed nine times and nothing told anyone.
 * `deploy-drift` (same workflow, verify job) answers "is the live commit
 * behind main"; this answers "is the box's OWN pull-deploy.sh reporting
 * failure", from the reason it wrote to its status file — a narrower signal
 * that survives even when the live commit still looks fresh.
 *
 * Shape: same as scripts/post-tracking-issues.js — idempotent upsert on one
 * issue (HTML-comment marker, never a second issue), plain REST with an
 * injectable `fetchImpl` so tests never touch the network, thin CLI at the
 * bottom. Every entry point is best-effort: a problem managing the ISSUE never
 * fails the workflow step that already knows the deploy state.
 *
 * Called from deploy-box.yml (poll-pull-deploy: missed merge, then catch-up)
 * and readiness-probe.yml (deploy/fresh CRITICAL, #700).
 */

const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'GateTest-Deploy-Stalled/1.0';
const TITLE = 'Production deploy stalled';
const LABEL = 'ops';
const MARKER = '<!-- gatetest-bot:deploy-stalled -->';

function log(...args) { console.log('[deploy-stalled-issue]', ...args); }

function short(sha) {
  return String(sha || '').slice(0, 12);
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': USER_AGENT,
  };
}

/** Render the issue title + body for a stalled deploy. Pure — no I/O. */
function renderIssue({ reason, unshipped = [], boxCommand, source, checkedAt }) {
  const when = checkedAt || new Date().toISOString();
  const unshippedList = unshipped.length
    ? unshipped.map((c) => `- \`${short(c.sha)}\` ${c.subject || '(no subject)'}`).join('\n')
    : '_none resolved — see reason below_';
  const command = boxCommand || 'journalctl -u gatetest-pull-deploy -n 100 --no-pager';

  const body = [
    MARKER,
    '',
    `Production is not deploying. Detected by **${source}** at ${when}. This issue is updated on every later failure and closes itself once a run sees the box caught up to \`main\`.`,
    '',
    `**Reason:** ${reason}`,
    '',
    '**Unshipped merges (live commit → main):**',
    unshippedList,
    '',
    '**Box command (see docs/deploy/PULL-DEPLOY.md "Seeing the last result"):**',
    '```bash',
    command,
    '```',
    '',
    '<sub>This issue is **auto-managed by GateTest** (issue #706). Do not edit the marker above.</sub>',
  ].join('\n');

  return { title: TITLE, body };
}

/** The one open "Production deploy stalled" issue, identified by marker (not
 * just title — a title match alone could pick up something a human opened
 * coincidentally with the same words). Returns null if none is open. */
async function findOpenIssue({ owner, repo, token, fetchImpl, githubApi = GITHUB_API }) {
  const res = await fetchImpl(
    `${githubApi}/repos/${owner}/${repo}/issues?state=open&labels=${encodeURIComponent(LABEL)}&per_page=100`,
    { method: 'GET', headers: authHeaders(token) },
  );
  if (res.status !== 200) {
    log(`list issues non-200: ${res.status} — proceeding as if none is open`);
    return null;
  }
  const issues = await res.json().catch(() => []);
  if (!Array.isArray(issues)) return null;
  return issues.find((i) => i && !i.pull_request && typeof i.body === 'string' && i.body.includes(MARKER)) || null;
}

/**
 * "assignee: the repo owner" (issue #706) cannot mean the literal GitHub
 * account/org that owns the repo when that owner is an Organization —
 * GitHub does not allow assigning an issue to an org. When the repo owner
 * IS a user, that user is the assignee outright; when it is an org, the
 * practical equivalent is the human who actually administers this repo —
 * resolved as the collaborator with the `admin` role, first match wins.
 * Best-effort: any failure (network, permissions) resolves to null, which
 * upsertDeployStalledIssue treats as "open unassigned" rather than failing
 * the whole operation over an assignee.
 */
async function resolveRepoOwnerLogin({ owner, repo, token, fetchImpl, githubApi = GITHUB_API }) {
  try {
    const repoRes = await fetchImpl(`${githubApi}/repos/${owner}/${repo}`, { headers: authHeaders(token) });
    if (repoRes.status !== 200) return null;
    const repoData = await repoRes.json().catch((err) => {
      log(`resolveRepoOwnerLogin: repo response not JSON — ${err && err.message ? err.message : err}`);
      return null;
    });
    if (repoData && repoData.owner && repoData.owner.type === 'User' && repoData.owner.login) {
      return repoData.owner.login;
    }
  } catch (err) {
    log(`resolveRepoOwnerLogin: repo lookup failed — ${err && err.message ? err.message : err}`);
    return null;
  }

  try {
    const collabRes = await fetchImpl(
      `${githubApi}/repos/${owner}/${repo}/collaborators?affiliation=direct&per_page=100`,
      { headers: authHeaders(token) },
    );
    if (collabRes.status !== 200) return null;
    const collaborators = await collabRes.json().catch((err) => {
      log(`resolveRepoOwnerLogin: collaborators response not JSON — ${err && err.message ? err.message : err}`);
      return null;
    });
    if (!Array.isArray(collaborators)) return null;
    const admin = collaborators.find((c) => c && (c.role_name === 'admin' || (c.permissions && c.permissions.admin)));
    return admin && admin.login ? admin.login : null;
  } catch (err) {
    log(`resolveRepoOwnerLogin: collaborator lookup failed — ${err && err.message ? err.message : err}`);
    return null;
  }
}

/**
 * Idempotent upsert:
 *   stalled=true,  no open issue   -> create (assignee resolved, label `ops`)
 *   stalled=true,  open issue      -> comment (a later failure, not a new issue)
 *   stalled=false, open issue      -> comment "resolved" + close
 *   stalled=false, no open issue   -> nothing to do
 */
async function upsertDeployStalledIssue(opts) {
  const {
    stalled,
    reason = '',
    unshipped = [],
    boxCommand,
    source = 'deploy pipeline',
    owner,
    repo,
    token,
    fetchImpl,
    githubApi = GITHUB_API,
    checkedAt = new Date().toISOString(),
    runUrl = null,
  } = opts;
  if (!fetchImpl) throw new Error('upsertDeployStalledIssue: fetchImpl required');
  if (!owner || !repo || !token) throw new Error('upsertDeployStalledIssue: owner, repo and token are required');

  const existing = await findOpenIssue({ owner, repo, token, fetchImpl, githubApi });

  if (!stalled) {
    if (!existing) return { action: 'none' };
    await fetchImpl(`${githubApi}/repos/${owner}/${repo}/issues/${existing.number}/comments`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: `Resolved: production has caught up to \`main\` as of ${checkedAt} (**${source}**)${runUrl ? ` — [run](${runUrl})` : ''}. Closing.`,
      }),
    });
    const closeRes = await fetchImpl(`${githubApi}/repos/${owner}/${repo}/issues/${existing.number}`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
    });
    return { action: closeRes.status === 200 ? 'closed' : 'comment-only', number: existing.number };
  }

  if (existing) {
    await fetchImpl(`${githubApi}/repos/${owner}/${repo}/issues/${existing.number}/comments`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: [
          `Still stalled as of ${checkedAt} (**${source}**).`,
          '',
          `**Reason:** ${reason}`,
          runUrl ? `\n[run](${runUrl})` : '',
        ].join('\n'),
      }),
    });
    return { action: 'commented', number: existing.number };
  }

  const { title, body } = renderIssue({ reason, unshipped, boxCommand, source, checkedAt });
  const assignee = await resolveRepoOwnerLogin({ owner, repo, token, fetchImpl, githubApi });
  const payload = { title, body, labels: [LABEL] };
  if (assignee) payload.assignees = [assignee];

  const createRes = await fetchImpl(`${githubApi}/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (createRes.status !== 201) {
    log(`create issue non-201: ${createRes.status}`);
    return { action: 'error', status: createRes.status };
  }
  const created = await createRes.json().catch(() => ({}));
  return { action: 'opened', number: created && created.number, assignee };
}

module.exports = {
  TITLE,
  LABEL,
  MARKER,
  renderIssue,
  findOpenIssue,
  resolveRepoOwnerLogin,
  upsertDeployStalledIssue,
};

// ---------------------------------------------------------------------------
// CLI — invoked directly from a workflow step. Never throws past this point:
// issue-management trouble must never fail the calling job, which already
// has its own exit code for the actual deploy verdict.
//
//   node scripts/ops/deploy-stalled-issue.js --state stalled \
//     --reason "<reason>" --box-command "<cmd>" --source "<name>" \
//     [--unshipped-file unshipped.json] [--run-url <url>]
//   node scripts/ops/deploy-stalled-issue.js --state resolved --source "<name>"
//
// Env: GITHUB_TOKEN (or GH_TOKEN), GITHUB_REPOSITORY (owner/repo).
// ---------------------------------------------------------------------------
if (require.main === module) {
  const fs = require('fs');

  function argVal(name) {
    const i = process.argv.indexOf(name);
    return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : undefined;
  }

  (async () => {
    const state = argVal('--state');
    const reason = argVal('--reason') || '';
    const boxCommand = argVal('--box-command');
    const source = argVal('--source') || 'deploy pipeline';
    const unshippedFile = argVal('--unshipped-file');
    const runUrl =
      argVal('--run-url') ||
      (process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : null);

    let unshipped = [];
    if (unshippedFile) {
      try {
        unshipped = JSON.parse(fs.readFileSync(unshippedFile, 'utf8'));
        if (!Array.isArray(unshipped)) unshipped = [];
      } catch {
        unshipped = [];
      }
    }

    const [owner, repo] = String(process.env.GITHUB_REPOSITORY || '').split('/');
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

    if (state !== 'stalled' && state !== 'resolved') {
      log('--state must be "stalled" or "resolved" — skipping');
      return;
    }
    if (!owner || !repo || !token) {
      log('GITHUB_REPOSITORY and GITHUB_TOKEN (or GH_TOKEN) are required — skipping');
      return;
    }

    const result = await upsertDeployStalledIssue({
      stalled: state === 'stalled',
      reason,
      unshipped,
      boxCommand,
      source,
      owner,
      repo,
      token,
      fetchImpl: globalThis.fetch,
      runUrl,
    });
    log(`${result.action}${result.number ? ` #${result.number}` : ''}`);
  })()
    .then(() => process.exit(0))
    .catch((err) => {
      log('non-fatal error:', err && err.message ? err.message : err);
      process.exit(0);
    });
}
