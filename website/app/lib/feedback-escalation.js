/**
 * Feedback escalation — turns a stored "down" event into a GitHub issue on
 * our own repository, so bad feedback reaches us before it reaches a
 * review site (Craig 2026-09-16). No human on our side has to start it.
 *
 * Decision table (tests/feedback-loop.test.js holds every row):
 *   up                                → none
 *   down, no text                     → none (nothing to act on)
 *   down + text                       → issue  "Customer feedback: <surface> <tier>"   label customer-feedback
 *   finding surface + rule            → issue  "Possible false positive: <rule>"        label false-positive
 *   finding, same rule, open issue    → comment on that issue instead (7-day lookback
 *                                       in feedback_events, then the issue must still be open)
 *
 * All I/O goes through an injected fetchImpl (same shape as
 * suppression-command.js) so the route is unit-testable end to end. The
 * caller supplies the token — the route resolves it through
 * github-app.ts (PAT first, App installation second) and, when neither is
 * configured, skips escalation and says so in the response rather than
 * failing the customer's request.
 */

'use strict';

const { siteUrl } = require('./site-url');

const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'GateTest/1.0';
const FETCH_TIMEOUT_MS = 10_000;
/** The repository feedback issues land in. One definition — import it. */
const FEEDBACK_REPO = { owner: 'crclabs-hq', repo: 'GateTest' };
const LABELS = { feedback: 'customer-feedback', falsePositive: 'false-positive' };
const DEDUPE_DAYS = 7;

function fetchTimeoutSignal() {
  try {
    return typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? AbortSignal.timeout(FETCH_TIMEOUT_MS)
      : undefined;
  } catch { return undefined; }
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': USER_AGENT,
    'Content-Type': 'application/json',
  };
}

/**
 * Pure: what, if anything, should happen for this event.
 *
 * @param {{ rating: string, text?: string|null, surface: string, tier?: string|null, rule?: string|null }} event
 * @param {{ issueNumber: number } | null} [priorOpenIssue]  an open issue already tracking this rule
 * @returns {{ kind: 'none', reason: string } | { kind: 'issue'|'comment', title: string, label: string, issueNumber?: number }}
 */
function escalationDecision(event, priorOpenIssue = null) {
  if (!event || event.rating !== 'down') return { kind: 'none', reason: 'rating is not down' };
  if (event.surface === 'finding' && event.rule) {
    const title = `Possible false positive: ${event.rule}`;
    if (priorOpenIssue && priorOpenIssue.issueNumber) {
      return { kind: 'comment', title, label: LABELS.falsePositive, issueNumber: priorOpenIssue.issueNumber };
    }
    return { kind: 'issue', title, label: LABELS.falsePositive };
  }
  if (!event.text) return { kind: 'none', reason: 'down rating without text' };
  return {
    kind: 'issue',
    title: `Customer feedback: ${event.surface} ${event.tier || 'untiered'}`,
    label: LABELS.feedback,
  };
}

/** Markdown body for the issue or comment. `text` is already redacted. */
function composeIssueBody(event, rowId) {
  const lines = [
    `- Surface: \`${event.surface}\``,
    `- Tier: \`${event.tier || 'untiered'}\``,
    `- Page: \`${event.page || 'unknown'}\``,
    `- Scan id: \`${event.scanId || 'none'}\``,
  ];
  if (event.rule) lines.push(`- Rule: \`${event.rule}\``);
  lines.push('', '**What the customer said** (redacted before storage):', '');
  lines.push(event.text ? `> ${event.text.replace(/\n/g, '\n> ')}` : '> (no text)');
  lines.push('', `Triage: ${siteUrl('/admin/feedback')}${rowId ? ` (row ${rowId})` : ''}`);
  return lines.join('\n');
}

/**
 * Is the issue a prior escalation pointed at still open? Closed issues are
 * not commented on — a fresh issue is the right signal that it came back.
 */
async function isIssueOpen({ token, fetchImpl, issueNumber }) {
  const doFetch = fetchImpl || globalThis.fetch;
  try {
    const res = await doFetch(
      `${GITHUB_API}/repos/${FEEDBACK_REPO.owner}/${FEEDBACK_REPO.repo}/issues/${issueNumber}`,
      { method: 'GET', signal: fetchTimeoutSignal(), headers: ghHeaders(token) },
    );
    if (res.status !== 200) return false;
    const data = await res.json();
    return data && data.state === 'open';
  } catch { return false; }
}

/**
 * Carry out a decision against GitHub.
 *
 * @returns {Promise<{ escalated: boolean, reason?: string, issueNumber?: number, ref?: string }>}
 */
async function escalate({ decision, event, rowId, token, fetchImpl }) {
  if (!decision || decision.kind === 'none') return { escalated: false, reason: (decision && decision.reason) || 'nothing to escalate' };
  if (!token) return { escalated: false, reason: 'no git host credential configured' };
  const doFetch = fetchImpl || globalThis.fetch;
  const base = `${GITHUB_API}/repos/${FEEDBACK_REPO.owner}/${FEEDBACK_REPO.repo}/issues`;
  const body = composeIssueBody(event, rowId);
  const url = decision.kind === 'comment' ? `${base}/${decision.issueNumber}/comments` : base;
  const payload = decision.kind === 'comment'
    ? { body: `Reported again.\n\n${body}` }
    : { title: decision.title, body, labels: [decision.label] };
  try {
    const res = await doFetch(url, {
      method: 'POST', signal: fetchTimeoutSignal(), headers: ghHeaders(token), body: JSON.stringify(payload),
    });
    if (res.status !== 201) return { escalated: false, reason: `git host returned ${res.status}` };
    const data = await res.json();
    const issueNumber = decision.kind === 'comment' ? decision.issueNumber : Number(data && data.number);
    return { escalated: true, kind: decision.kind, issueNumber, ref: (data && data.html_url) || null };
  } catch (err) {
    return { escalated: false, reason: `git host request failed: ${err && err.message ? err.message : err}` };
  }
}

module.exports = {
  FEEDBACK_REPO,
  LABELS,
  DEDUPE_DAYS,
  escalationDecision,
  composeIssueBody,
  isIssueOpen,
  escalate,
};
