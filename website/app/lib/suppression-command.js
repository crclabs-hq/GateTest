/**
 * Suppression in place (2026-08-18 audit advancement #13, competitor
 * complaint #15): a reviewer who decides a finding is noise should not
 * have to leave the PR, learn our config grammar, and open a second PR.
 * They reply
 *
 *     @gatetest ignore <module:rule>
 *
 * under the GateTest comment, and this module appends the rule to
 * `.gatetestignore` on the PR's own head branch — same commit stream the
 * reviewer is already looking at, effective from the next scan, and
 * removable with a one-line revert. Every suppression is also recorded so
 * chronically-dismissed rules feed the precision flywheel.
 *
 * Safety model:
 *   - only OWNER / MEMBER / COLLABORATOR comment authors are honoured
 *     (drive-by commenters and bots cannot rewrite a repo's config);
 *   - the rule token is strictly validated and newline-stripped, so a
 *     comment can never inject arbitrary lines into the file;
 *   - fork PRs are refused: we will not push to a branch the repo does
 *     not own.
 *
 * All I/O goes through an injected fetchImpl — unit-testable end to end.
 */

'use strict';

const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'GateTest/1.0';
const FETCH_TIMEOUT_MS = 10_000;

function fetchTimeoutSignal() {
  try {
    return typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? AbortSignal.timeout(FETCH_TIMEOUT_MS)
      : undefined;
  } catch { return undefined; }
}

// `module`, `module:rule`, `*:rule`, optional `@glob` scope — the exact
// grammar src/core/ignore-file.js parses. Anything else is rejected.
const RULE_RE = /^(\*|[A-Za-z][\w-]*)(:[A-Za-z][\w./-]*)?(@[\w./*-]+)?$/;
const MAX_RULE_LENGTH = 120;

/**
 * Parse a comment body for the suppression command. The command must sit
 * on its own line so prose that merely mentions it doesn't trigger.
 *
 * @param {string} body
 * @returns {{ rule: string } | null}
 */
function parseSuppressionCommand(body) {
  if (typeof body !== 'string' || body.length === 0 || body.length > 65536) return null;
  const m = body.match(/^\s*@gatetest\s+ignore\s+(\S+)\s*$/im);
  if (!m) return null;
  const rule = m[1].replace(/[\r\n]/g, '').trim();
  if (rule.length > MAX_RULE_LENGTH || !RULE_RE.test(rule)) return null;
  return { rule };
}

/** Repo insiders only — and never a bot (loop protection). */
function isAuthorizedCommenter({ authorAssociation, userType }) {
  if (String(userType || '').toLowerCase() === 'bot') return false;
  return ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(String(authorAssociation || '').toUpperCase());
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': USER_AGENT,
  };
}

/**
 * Append the rule to `.gatetestignore` on the PR head branch and reply
 * with an acknowledgement. Never throws — every outcome is a reason.
 *
 * @param {object} args
 * @param {string} args.owner
 * @param {string} args.repo
 * @param {number} args.prNumber
 * @param {string} args.rule       validated by parseSuppressionCommand
 * @param {string} args.actor      commenter login (for the audit line)
 * @param {string} args.token
 * @param {typeof fetch} [args.fetchImpl]
 * @returns {Promise<{ ok: boolean, reason?: string, branch?: string, already?: boolean }>}
 */
async function applySuppression({ owner, repo, prNumber, rule, actor, token, fetchImpl }) {
  const doFetch = fetchImpl || fetch;

  // 1. Resolve the PR head branch — and refuse forks.
  let head;
  try {
    const res = await doFetch(`${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}`, {
      signal: fetchTimeoutSignal(),
      headers: ghHeaders(token),
    });
    if (!res.ok) return { ok: false, reason: `pull lookup failed (${res.status})` };
    const pr = await res.json();
    head = pr && pr.head;
    if (!head || !head.ref) return { ok: false, reason: 'pull has no head ref' };
    const headRepo = head.repo && head.repo.full_name;
    if (headRepo && headRepo.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) {
      return { ok: false, reason: 'fork PR — GateTest does not push to branches the repository does not own' };
    }
  } catch (err) {
    return { ok: false, reason: `pull lookup error: ${err && err.message ? err.message : err}` };
  }
  const branch = head.ref;

  // 2. Read the current .gatetestignore on that branch (404 → new file).
  let existing = '';
  let sha = null;
  try {
    const res = await doFetch(
      `${GITHUB_API}/repos/${owner}/${repo}/contents/.gatetestignore?ref=${encodeURIComponent(branch)}`,
      { signal: fetchTimeoutSignal(), headers: ghHeaders(token) });
    if (res.status === 200) {
      const file = await res.json();
      sha = file.sha || null;
      existing = Buffer.from(String(file.content || ''), 'base64').toString('utf-8');
    } else if (res.status !== 404) {
      return { ok: false, reason: `.gatetestignore read failed (${res.status})` };
    }
  } catch (err) {
    return { ok: false, reason: `.gatetestignore read error: ${err && err.message ? err.message : err}` };
  }

  // 3. Idempotent: an already-present rule is a success, not a duplicate line.
  const present = existing
    .split(/\r?\n/)
    .some((l) => l.split('#')[0].trim() === rule);
  if (present) return { ok: true, already: true, branch };

  const line = `${rule}  # suppressed by @${actor} via PR #${prNumber}`;
  const next = existing.length === 0
    ? `# GateTest suppressions — one rule per line (module, module:rule, *:rule, optionally @glob)\n${line}\n`
    : `${existing.replace(/\n?$/, '\n')}${line}\n`;

  // 4. Commit to the PR branch.
  try {
    const res = await doFetch(
      `${GITHUB_API}/repos/${owner}/${repo}/contents/.gatetestignore`,
      {
        method: 'PUT',
        signal: fetchTimeoutSignal(),
        headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `chore(gatetest): suppress ${rule} (requested by @${actor})`,
          content: Buffer.from(next, 'utf-8').toString('base64'),
          branch,
          ...(sha ? { sha } : {}),
        }),
      });
    if (res.status !== 200 && res.status !== 201) {
      return { ok: false, reason: `.gatetestignore write failed (${res.status})` };
    }
  } catch (err) {
    return { ok: false, reason: `.gatetestignore write error: ${err && err.message ? err.message : err}` };
  }

  // 5. Acknowledge in the thread — best-effort, the suppression already landed.
  try {
    await doFetch(`${GITHUB_API}/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
      method: 'POST',
      signal: fetchTimeoutSignal(),
      headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: `🤫 Suppressed \`${rule}\` — appended to \`.gatetestignore\` on \`${branch}\`. It stops appearing from the next scan; delete the line to restore it. Suppressions also tune GateTest's precision for everyone.`,
      }),
    });
  } catch { /* error-ok — ack is cosmetic — the file change is the outcome */ }

  return { ok: true, branch };
}

/**
 * Record the suppression so chronically-dismissed rules feed the
 * precision flywheel. Best-effort: a telemetry failure never affects the
 * suppression itself.
 *
 * @param {Function} sql  Neon tagged template
 */
async function recordSuppression(sql, { repository, rule, actor, prNumber }) {
  if (!sql || typeof sql !== 'function') return false;
  await sql`CREATE TABLE IF NOT EXISTS rule_suppressions (
    id BIGSERIAL PRIMARY KEY,
    repository TEXT NOT NULL,
    rule TEXT NOT NULL,
    actor TEXT,
    pr_number INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`INSERT INTO rule_suppressions (repository, rule, actor, pr_number)
            VALUES (${repository}, ${rule}, ${actor || null}, ${prNumber || null})`;
  return true;
}

module.exports = {
  parseSuppressionCommand,
  isAuthorizedCommenter,
  applySuppression,
  recordSuppression,
};
