/**
 * post-tracking-issues — opens a GitHub Issue for every error-severity
 * finding that the gate flagged but the auto-fixer COULDN'T resolve.
 *
 * Why this exists:
 *   - The auto-fix loop catches most bugs the gate flags, but some classes
 *     (config-level rules, architectural smells, anything without a clean
 *     file:line anchor, anything the fix engine produced no patch for)
 *     need human attention.
 *   - Today those findings show up in the workflow log and the PR summary
 *     comment, then get lost. No tracking, no assignee, no priority.
 *   - This module opens a tracking ISSUE per such finding so they enter
 *     the customer's normal issue-triage flow.
 *
 * Idempotency:
 *   - Every issue carries an HTML-comment signature marker
 *     `<!-- gatetest-bot:finding:<hash> -->`.
 *   - Before opening, we list open issues, find by marker, skip if a
 *     matching one is already open.
 *   - Auto-close (V2): when a previously-tracked finding disappears
 *     from the next scan, close the issue with a "fixed by ..." comment.
 *     V1 just opens; closing is left to the customer's workflow.
 *
 * Inputs:
 *   - Gate JSON report (`.gatetest/reports/gatetest-results.json`)
 *   - Patches snapshot (`.gatetest/fix-patches.json` — files that
 *     WERE auto-fixed; we skip these so we don't open an issue for
 *     something the fix engine already handled)
 *
 * Failure mode: every operation is best-effort, non-blocking. We never
 * fail the workflow on an issue-creation error.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'GateTest-Issue-Tracker/1.0';
// Signature marker shape — repeats across PR comments, review comments,
// and now issues. The `:finding:<sha>` suffix gives each issue a unique
// dedup key derived from the finding's stable identity (module + file +
// line + check-name) — re-scans don't spawn duplicate issues.
const MARKER_PREFIX = '<!-- gatetest-bot:finding:';
const MARKER_SUFFIX = ' -->';

function log(...args) { console.log('[post-tracking-issues]', ...args); }

/**
 * Compute the stable identity hash for a finding. A finding with the
 * same (module, file, line, check) is "the same finding" across scans —
 * so re-scans don't spawn duplicate issues.
 */
function findingHash(finding) {
  const id = [
    finding.module || '',
    finding.file || '',
    finding.line || '',
    finding.name || finding.check || '',
  ].join('|');
  return crypto.createHash('sha1').update(id).digest('hex').slice(0, 12);
}

function markerFor(finding) {
  return `${MARKER_PREFIX}${findingHash(finding)}${MARKER_SUFFIX}`;
}

/**
 * Collect findings worth opening a tracking issue for. The rules:
 *
 *   - severity === 'error' (warnings + info don't get issues)
 *   - the finding's `file` is NOT in the patched-files set (skip
 *     anything the fix engine already resolved)
 *   - the finding has either a `file` OR a non-trivial `message` /
 *     `suggestion` (skip pure no-op entries)
 *
 * Cap the result list at `max` (default 20) per scan so we don't
 * spam customer repos on a noisy first run.
 */
function collectUntrackedFindings({ gateReport, patchedFiles = new Set(), max = 20 }) {
  if (!gateReport || !Array.isArray(gateReport.results)) return [];

  const out = [];
  for (const moduleResult of gateReport.results) {
    const moduleName = moduleResult.module || moduleResult.name || 'unknown';
    if (!Array.isArray(moduleResult.checks)) continue;
    for (const check of moduleResult.checks) {
      if (check.passed) continue;
      if ((check.severity || 'error') !== 'error') continue;
      if (check.file && patchedFiles.has(check.file)) continue;
      // Pure-info checks like "scanning N files" with no message — skip.
      if (!check.file && !check.message && !check.suggestion) continue;
      out.push({
        module: moduleName,
        name: check.name || check.check || 'finding',
        file: check.file || null,
        line: check.line || null,
        message: check.message || '',
        suggestion: check.suggestion || '',
        severity: check.severity || 'error',
      });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/**
 * Render the issue title + body for a single untracked finding.
 */
function renderTrackingIssue(finding, { repoUrl } = {}) {
  const fileLine = finding.file
    ? finding.line ? `${finding.file}:${finding.line}` : finding.file
    : '(repo-wide)';

  // Short, scannable title that a triager can recognise at a glance.
  // Capped at ~80 chars so the GitHub issue list doesn't truncate it.
  const summary = (finding.message || finding.name).slice(0, 80);
  const title = `[GateTest] ${finding.module}: ${fileLine} — ${summary}`;

  const body = [
    markerFor(finding),
    '',
    `## ${finding.module} &middot; ${finding.name}`,
    '',
    finding.file ? `**File:** \`${fileLine}\`` : '**Scope:** repo-wide finding (no specific file)',
    `**Severity:** \`${finding.severity}\``,
    '',
    '### What happened',
    '',
    finding.message || '(no message)',
    '',
    finding.suggestion
      ? ['### Suggested fix', '', finding.suggestion].join('\n')
      : '',
    '',
    '### Why this is an Issue, not an auto-fix PR',
    '',
    'The GateTest auto-fix engine could not produce a verified patch for ' +
      'this finding — typically because the fix needs an architectural ' +
      'decision (rename across files, choose a library, redesign a config), ' +
      'the file is too large, or the finding is repo-wide with no ' +
      'specific anchor line. Triage this manually.',
    '',
    '<sub>This issue is **auto-managed by GateTest**. Re-scans will ' +
      'detect this same finding via its signature marker and will NOT ' +
      'open a duplicate issue. Close this issue once resolved and the ' +
      'next scan will leave it closed.</sub>',
    repoUrl
      ? `<sub>Gate report: ${repoUrl}</sub>`
      : '',
  ].filter((s) => s !== '').join('\n');

  return { title, body };
}

/**
 * Idempotent issue upsert. Lists open issues, finds one matching the
 * finding's marker, opens a new one if no match. Per-issue failure is
 * non-fatal — aggregates outcomes across all findings.
 */
async function upsertTrackingIssues(opts) {
  const {
    findings,
    owner, repo,
    token,
    repoUrl = `https://github.com/${opts.owner}/${opts.repo}`,
    githubApi = GITHUB_API,
    fetchImpl,
    labels = ['gatetest', 'bot'],
  } = opts;
  if (!fetchImpl) throw new Error('upsertTrackingIssues: fetchImpl required');

  const result = { opened: 0, skipped: 0, errors: 0, total: 0, details: [] };

  // Fetch all open issues with our `gatetest` label (paginated). This is
  // the dedup index — every finding's marker must be checked against it.
  const knownMarkers = new Set();
  try {
    for (let page = 1; page <= 5; page += 1) {
      const listRes = await fetchImpl(
        `${githubApi}/repos/${owner}/${repo}/issues?state=open&labels=gatetest&per_page=100&page=${page}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': USER_AGENT,
          },
        },
      );
      if (listRes.status !== 200) {
        log(`list issues non-200: ${listRes.status} — proceeding without dedup index`);
        break;
      }
      const issues = await listRes.json();
      if (!Array.isArray(issues)) break;
      for (const issue of issues) {
        if (issue && typeof issue.body === 'string') {
          // Extract every `<!-- gatetest-bot:finding:<hash> -->` marker
          // from the issue body. Usually one per issue, but tolerate more.
          const matches = issue.body.match(/<!-- gatetest-bot:finding:[a-f0-9]+ -->/g) || [];
          for (const m of matches) knownMarkers.add(m);
        }
      }
      if (issues.length < 100) break;
    }
  } catch (err) {
    log('list issues failed (non-fatal, proceeding):', err && err.message);
  }

  for (const finding of findings) {
    result.total += 1;
    const marker = markerFor(finding);
    if (knownMarkers.has(marker)) {
      result.skipped += 1;
      result.details.push({ finding: marker, reason: 'already-open' });
      continue;
    }
    try {
      const { title, body } = renderTrackingIssue(finding, { repoUrl });
      const res = await fetchImpl(
        `${githubApi}/repos/${owner}/${repo}/issues`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
            'User-Agent': USER_AGENT,
          },
          body: JSON.stringify({ title, body, labels }),
        },
      );
      if (res.status === 201) {
        result.opened += 1;
        const created = await res.json().catch(() => ({}));
        result.details.push({ finding: marker, status: 'opened', number: created && created.number });
      } else {
        result.skipped += 1;
        result.details.push({ finding: marker, status: res.status, reason: 'api-non-201' });
      }
    } catch (err) {
      result.errors += 1;
      result.details.push({ finding: marker, reason: 'exception', message: err && err.message });
    }
  }

  return result;
}

/**
 * Top-level: read inputs from disk, compute findings, post issues.
 * Never throws.
 */
async function runIssueTracker(opts) {
  const {
    workspace = process.cwd(),
    owner, repo, token,
    repoUrl,
    fetchImpl,
    githubApi = GITHUB_API,
    maxIssues = 20,
  } = opts;

  const gateReportPath = path.join(workspace, '.gatetest', 'reports', 'gatetest-results.json');
  if (!fs.existsSync(gateReportPath)) {
    log(`no gate report at ${gateReportPath} — skipping`);
    return { opened: 0, skipped: 0, errors: 0, total: 0, details: [{ reason: 'no-gate-report' }] };
  }
  let gateReport;
  try {
    gateReport = JSON.parse(fs.readFileSync(gateReportPath, 'utf-8'));
  } catch (err) {
    return { opened: 0, skipped: 0, errors: 1, total: 0, details: [{ reason: 'gate-report-parse-error', message: err && err.message }] };
  }

  // Build the patched-files set from the fix snapshot (if present).
  const patchedFiles = new Set();
  const patchPath = path.join(workspace, '.gatetest', 'fix-patches.json');
  if (fs.existsSync(patchPath)) {
    try {
      const patches = JSON.parse(fs.readFileSync(patchPath, 'utf-8'));
      if (Array.isArray(patches)) {
        for (const p of patches) {
          if (p && typeof p.file === 'string') patchedFiles.add(p.file);
        }
      }
    } catch {
      // ignore — patches file optional
    }
  }

  const findings = collectUntrackedFindings({ gateReport, patchedFiles, max: maxIssues });
  if (findings.length === 0) {
    log('no untracked error-severity findings — nothing to file');
    return { opened: 0, skipped: 0, errors: 0, total: 0, details: [] };
  }
  log(`${findings.length} untracked finding(s) eligible for issue tracking`);

  return upsertTrackingIssues({
    findings,
    owner,
    repo,
    token,
    repoUrl,
    githubApi,
    fetchImpl,
  });
}

module.exports = {
  findingHash,
  markerFor,
  collectUntrackedFindings,
  renderTrackingIssue,
  upsertTrackingIssues,
  runIssueTracker,
};
