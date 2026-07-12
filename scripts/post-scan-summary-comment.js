#!/usr/bin/env node
/**
 * post-scan-summary-comment.js — posts (or updates) ONE PR comment
 * summarising the gate's verdict: grade + error/warning counts + top
 * findings. This is the piece action.yml's own `block` input
 * description promised ("fresh installs report findings as a PR
 * comment") but that no script actually implemented — inline
 * ```suggestion``` comments (post-inline-suggestions.js) cover
 * individual auto-fixable findings, and track-non-fixable.js opens
 * Issues for non-fixable ones, but neither gives a reviewer the single
 * "what's the overall verdict" comment a PR needs at a glance.
 *
 * Idempotent: looks for an existing comment carrying the
 * HTML marker below and PATCHes it instead of posting a new one on
 * every re-run — a PR that gets re-scanned 10 times should have ONE
 * updated comment, not 10.
 *
 * Grade is derived from the same JSON report install-and-clone runs
 * already produce (.gatetest/reports/gatetest-report-latest.json),
 * using the identical formula the website's playground uses
 * (website/app/api/playground/scan/route.ts computeHealthScore) so a
 * grade means the same thing whether you saw it in CI or on
 * gatetest.ai — base = passed/total*100, penalty = min(50, errors*3).
 *
 * Failures here are NEVER fatal — same contract as every other
 * post-*.js script in this directory. The gate's own exit code is the
 * enforcement layer; this comment is purely informational.
 *
 * Required env (Actions context):
 *   GITHUB_TOKEN       — token with pull-requests: write
 *   GITHUB_REPOSITORY  — owner/repo
 *   GITHUB_EVENT_NAME  — must be `pull_request` or `pull_request_target`
 *   GITHUB_EVENT_PATH  — event payload JSON (for the PR number)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'GateTest-Scan-Summary/1.0';
const COMMENT_MARKER = '<!-- gatetest-scan-summary -->';

function log(...args) { console.log('[post-scan-summary]', ...args); }

function readReport(workspace) {
  const reportPath = path.join(workspace, '.gatetest', 'reports', 'gatetest-report-latest.json');
  if (!fs.existsSync(reportPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
  } catch {
    return null;
  }
}

/** Same formula as website/app/api/playground/scan/route.ts computeHealthScore. */
function computeGrade(report) {
  const modules = report?.summary?.modules || {};
  const checks = report?.summary?.checks || {};
  const totalModules = Number(modules.total || 0);
  const passed = Number(modules.passed || 0);
  const errors = Number(checks.errors || 0);
  const warnings = Number(checks.warnings || 0);

  if (totalModules === 0) return { score: 0, grade: 'F', errors, warnings, total: totalModules, passed };
  const base = Math.round((passed / totalModules) * 100);
  const penalty = Math.min(50, errors * 3);
  const score = Math.max(0, base - penalty);

  let grade;
  if (score >= 90) grade = 'A';
  else if (score >= 75) grade = 'B';
  else if (score >= 60) grade = 'C';
  else if (score >= 40) grade = 'D';
  else grade = 'F';

  return { score, grade, errors, warnings, total: totalModules, passed };
}

function topFindings(report, limit = 10) {
  const findings = [];
  for (const mod of report?.results || []) {
    const checks = mod.checks || [];
    for (const c of checks) {
      if (c.severity !== 'error' && c.severity !== 'warning') continue;
      if (c.passed) continue;
      findings.push({
        module: mod.module || mod.name,
        severity: c.severity,
        message: (c.details && c.details.message) || c.name,
      });
      if (findings.length >= limit) return findings;
    }
  }
  return findings;
}

function renderBody({ grade, runUrl }) {
  const gradeEmoji = { A: '🟢', B: '🟢', C: '🟡', D: '🟠', F: '🔴' }[grade.grade] || '⚪';
  const lines = [
    COMMENT_MARKER,
    `## ${gradeEmoji} GateTest — Grade ${grade.grade} (${grade.score}/100)`,
    '',
    `**${grade.passed}/${grade.total}** modules passed  |  **${grade.errors}** error(s)  |  **${grade.warnings}** warning(s)`,
    '',
  ];

  if (grade.findings && grade.findings.length > 0) {
    lines.push('<details><summary>Top findings</summary>', '');
    for (const f of grade.findings) {
      lines.push(`- **[${f.severity}]** \`${f.module}\` — ${f.message}`);
    }
    lines.push('', '</details>', '');
  }

  lines.push(`[Full run](${runUrl}) · [gatetest.ai](https://gatetest.ai)`);
  return lines.join('\n');
}

async function githubRequest(method, url, token, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  return { status: res.status, data };
}

function readPrNumberFromEvent() {
  try {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath || !fs.existsSync(eventPath)) return null;
    const event = JSON.parse(fs.readFileSync(eventPath, 'utf-8'));
    return (event && event.pull_request && event.pull_request.number) || null;
  } catch {
    return null;
  }
}

async function main() {
  const eventName = process.env.GITHUB_EVENT_NAME || '';
  if (eventName !== 'pull_request' && eventName !== 'pull_request_target') {
    log(`event is "${eventName}" — summary comment only posts on pull_request. Skipping.`);
    return 0;
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) { log('GITHUB_TOKEN not present. Skipping.'); return 0; }

  const repoSlug = process.env.GITHUB_REPOSITORY || '';
  const [owner, repo] = repoSlug.split('/');
  if (!owner || !repo) { log(`GITHUB_REPOSITORY missing/malformed: "${repoSlug}". Skipping.`); return 0; }

  const prNumber = readPrNumberFromEvent();
  if (!prNumber) { log('Could not determine PR number from GITHUB_EVENT_PATH. Skipping.'); return 0; }

  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const report = readReport(workspace);
  if (!report) { log('No JSON report found — skipping summary comment.'); return 0; }

  const grade = computeGrade(report);
  grade.findings = topFindings(report);

  const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${owner}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : `https://github.com/${owner}/${repo}`;

  const body = renderBody({ grade, runUrl });

  try {
    const list = await githubRequest(
      'GET',
      `${GITHUB_API}/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`,
      token,
    );
    const existing = Array.isArray(list.data)
      ? list.data.find((c) => typeof c.body === 'string' && c.body.includes(COMMENT_MARKER))
      : null;

    if (existing) {
      const r = await githubRequest(
        'PATCH',
        `${GITHUB_API}/repos/${owner}/${repo}/issues/comments/${existing.id}`,
        token,
        { body },
      );
      log(`updated existing summary comment #${existing.id} (status ${r.status})`);
    } else {
      const r = await githubRequest(
        'POST',
        `${GITHUB_API}/repos/${owner}/${repo}/issues/${prNumber}/comments`,
        token,
        { body },
      );
      log(`posted new summary comment (status ${r.status})`);
    }
  } catch (err) {
    log('unexpected error (non-fatal):', err && err.message ? err.message : err);
  }
  return 0;
}

main().catch((err) => {
  log('crashed (non-fatal):', err && err.message ? err.message : err);
  process.exit(0);
});

module.exports = { computeGrade, topFindings, renderBody };
