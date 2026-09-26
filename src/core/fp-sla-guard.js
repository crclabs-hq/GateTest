'use strict';
/**
 * fp-sla-guard.js — the false-positive SLA enforcement logic (the Fifty,
 * move 20). GateTest's practice since #633/#694 is a control-pair test per
 * retracted false positive; this is the part that checks the practice is
 * being kept: no issue labelled `false-positive` sits open past 7 days
 * without a `retracted` or `not-a-false-positive` label.
 *
 * Pure logic lives here, with no `gh`/network call of its own, so it is
 * fully unit-testable. `fetchOpenFalsePositiveIssues` is the one place that
 * shells out, and only `tests/false-positive-ledger.test.js` calls it, gated
 * behind an env flag so the fast suite never touches the network (Doctrine
 * #8's environment split is about CI vs local, not about live vs offline —
 * this one is deliberately offline by default everywhere).
 */

const { execFileSync } = require('child_process');

const SLA_DAYS = 7;
const CLOSING_LABELS = new Set(['retracted', 'not-a-false-positive']);

/**
 * @param {{number:number, createdAt:string, labels:{name:string}[]}[]} issues
 * @param {Date} [now]
 * @returns {{ ok: boolean, breaches: {number:number, ageDays:number}[] }}
 */
function checkSla(issues, now = new Date()) {
  const breaches = [];
  for (const issue of issues || []) {
    const labelNames = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
    if (labelNames.some((n) => CLOSING_LABELS.has(n))) continue;
    const ageMs = now.getTime() - new Date(issue.createdAt).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays > SLA_DAYS) breaches.push({ number: issue.number, ageDays: Math.round(ageDays * 10) / 10 });
  }
  return { ok: breaches.length === 0, breaches };
}

/** True when `gh` is installed and authenticated — checked before any real call. */
function ghAvailable(execFn = execFileSync) {
  try {
    execFn('gh', ['auth', 'status'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Shells out to `gh issue list` for open `false-positive`-labelled issues.
 * Never called by the fast suite directly — only behind
 * GATETEST_FP_SLA_NETWORK_CHECK=1 and a passing `ghAvailable()`.
 */
function fetchOpenFalsePositiveIssues(repo, execFn = execFileSync) {
  const out = execFn(
    'gh',
    ['issue', 'list', '--repo', repo, '--label', 'false-positive', '--state', 'open', '--json', 'number,createdAt,labels'],
    { encoding: 'utf8' }
  );
  return JSON.parse(out);
}

module.exports = { checkSla, ghAvailable, fetchOpenFalsePositiveIssues, SLA_DAYS, CLOSING_LABELS };
