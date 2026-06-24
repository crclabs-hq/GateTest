/**
 * AI CI-fixer core helpers — extracted from scripts/ai-ci-fixer.js to keep
 * the script under the pr-size hard cap (500 lines per file). Every function
 * here is hermetically testable; the script is just the CLI wrapper +
 * orchestrator that wires them together.
 */

'use strict';

const fs    = require('node:fs');
const path  = require('node:path');
const https = require('node:https');
const { spawnSync } = require('node:child_process');

// Claude API client + retry policy live in a sibling file to keep this file
// under the 500-line PR-size budget. Re-exported below for one-import-surface.
const claude = require('./ai-ci-fixer-claude');

// ── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_MAX_ATTEMPTS  = 3;
const MAX_LOG_LINES         = 200;
const MAX_FILE_BYTES        = 50_000;

// ── Logging (stderr; never pollutes stdout) ─────────────────────────────────

function log(msg) {
  process.stderr.write(`[ai-ci-fixer] ${msg}\n`);
}

function logErr(msg, err) {
  const detail = err && err.message ? `: ${err.message}` : '';
  process.stderr.write(`[ai-ci-fixer] ERROR ${msg}${detail}\n`);
}

// ── GitHub API ──────────────────────────────────────────────────────────────

function githubRequest(token, method, urlPath, body = null, opts = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const reqOpts = {
      hostname: 'api.github.com',
      port: 443,
      path: urlPath,
      method,
      headers: {
        'Accept':              'application/vnd.github+json',
        'Authorization':       `Bearer ${token}`,
        'User-Agent':          'gatetest-ai-ci-fixer',
        'X-GitHub-Api-Version':'2022-11-28',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const transport = opts.transport || https;
    const req = transport.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        let parsed = raw;
        if (raw && (res.headers['content-type'] || '').includes('json')) {
          try { parsed = JSON.parse(raw); } catch { /* keep raw */ }
        }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers, raw });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function isRateLimited(response) {
  if (!response || typeof response.status !== 'number') return false;
  if (response.status === 429) return true;
  if (response.status === 403) {
    const remaining = response.headers?.['x-ratelimit-remaining'];
    if (remaining === '0') return true;
    const msg = typeof response.body === 'object' && response.body
      ? (response.body.message || '')
      : '';
    if (/rate limit|abuse|secondary/i.test(String(msg))) return true;
  }
  return false;
}

async function fetchWorkflowRun(token, repo, runId, opts = {}) {
  return githubRequest(token, 'GET', `/repos/${repo}/actions/runs/${runId}`, null, opts);
}

/**
 * Fetch a URL with no auth headers — used to follow GitHub's 302 redirects
 * to signed log-download URLs (the signed token IS the auth on those).
 *
 * Supports both http: and https: URLs and gives the test transport a way
 * to mock by exposing the same `{ request(opts, cb) }` shape.
 */
function fetchUrl(url, opts = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); }
    catch (err) { reject(new Error(`fetchUrl: invalid URL ${url}: ${err.message}`)); return; }
    const isHttps = parsed.protocol === 'https:';
    const reqOpts = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     `${parsed.pathname}${parsed.search || ''}`,
      method:   'GET',
      headers: {
        'User-Agent': 'gatetest-ai-ci-fixer',
        'Accept':     '*/*',
      },
    };
    // Tests may supply a single transport. In real use we pick https vs http
    // based on the URL — these signed log URLs are always https in practice
    // but the helper stays correct for either.
    const transport = opts.transport || (isHttps ? https : require('node:http'));
    const req = transport.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status:  res.statusCode,
          body:    Buffer.concat(chunks).toString('utf-8'),
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchWorkflowLogs(token, repo, runId, opts = {}) {
  const jobsRes = await githubRequest(token, 'GET', `/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`, null, opts);
  if (jobsRes.status !== 200 || !jobsRes.body || !Array.isArray(jobsRes.body.jobs)) {
    return { ok: false, response: jobsRes, text: '' };
  }
  const failedJobs = jobsRes.body.jobs.filter((j) => j.conclusion === 'failure');
  if (failedJobs.length === 0) return { ok: true, text: '', failedJobs: [] };
  const j = failedJobs[0];
  const logsRes = await githubRequest(token, 'GET', `/repos/${repo}/actions/jobs/${j.id}/logs`, null, opts);

  // GitHub returns 302 with a Location header pointing at a short-lived
  // signed blob URL where the actual log lives. Without following the
  // redirect, the body here is empty (or HTML noise) — the regex in
  // extractFailingFiles matches 0 files, and the fixer falsely concludes
  // there's nothing to repair. This was the silent killer that made the
  // arena demo's first real run say "no-files" despite obvious test
  // failures in the source log.
  if (logsRes.status >= 300 && logsRes.status < 400 && logsRes.headers && logsRes.headers.location) {
    try {
      const signed = await fetchUrl(logsRes.headers.location, opts);
      const followedText = typeof signed.body === 'string' ? signed.body : '';
      return { ok: true, text: followedText, failedJobs, followedRedirect: true };
    } catch (err) {
      logErr('following signed-log redirect', err);
      return { ok: true, text: '', failedJobs, redirectError: err.message };
    }
  }

  const text = typeof logsRes.body === 'string' ? logsRes.body : (logsRes.raw || '');
  return { ok: true, text, failedJobs };
}

async function createPullRequest({ token, repo, head, base, title, body, opts = {} }) {
  return githubRequest(token, 'POST', `/repos/${repo}/pulls`, { title, head, base, body, maintainer_can_modify: true }, opts);
}

async function createIssue({ token, repo, title, body, opts = {} }) {
  return githubRequest(token, 'POST', `/repos/${repo}/issues`, { title, body }, opts);
}

// ── Branch-collision handling ───────────────────────────────────────────────
// When a previous fix-PR for the same run still exists (customer hasn't
// reviewed/merged/closed it yet), rotate the branch name instead of
// force-overwriting their open work.

const MAX_BRANCH_ATTEMPTS = 10;

async function branchExists({ token, repo, branch, transport }) {
  try {
    const res = await githubRequest(
      token, 'GET',
      `/repos/${repo}/branches/${encodeURIComponent(branch)}`,
      null,
      { transport },
    );
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    // Any other status (rate-limit, transient 5xx, auth): treat as exists.
    // Safer to rotate than to clobber.
    return true;
  } catch {
    return true;
  }
}

async function findFreeBranchName({ token, repo, baseRunId, transport }) {
  // First try the canonical name.
  const first = `ai-fix/${baseRunId}`;
  if (!(await branchExists({ token, repo, branch: first, transport }))) {
    return { branch: first, attemptNumber: 1 };
  }
  // Rotate ai-fix/<runId>-attempt-2 … ai-fix/<runId>-attempt-10.
  for (let n = 2; n <= MAX_BRANCH_ATTEMPTS; n++) {
    const candidate = `ai-fix/${baseRunId}-attempt-${n}`;
    if (!(await branchExists({ token, repo, branch: candidate, transport }))) {
      return { branch: candidate, attemptNumber: n };
    }
  }
  return null; // Cap hit — caller should give up + open a fallback issue.
}

// ── Log parsing ─────────────────────────────────────────────────────────────

function tailLines(text, n = MAX_LOG_LINES) {
  if (!text) return '';
  const lines = String(text).split(/\r?\n/);
  if (lines.length <= n) return lines.join('\n');
  return lines.slice(lines.length - n).join('\n');
}

function _shouldKeepPath(p) {
  if (/^https?:/.test(p)) return false;
  if (p.startsWith('node:')) return false;
  if (p.includes('node_modules')) return false;
  if (p.includes('node:internal')) return false;
  return true;
}

/**
 * Split a GitHub Actions log into per-step blocks using ##[group] markers.
 *
 * Returns an array of `{ name, body, failed }`. `failed` is true if the
 * step body contains `##[error]` OR a non-zero exit-code marker.
 *
 * Returns `[]` when no `##[group]` markers are present — callers fall back
 * to whole-log tailing in that case.
 */
function parseStepsFromLog(logText) {
  if (!logText || typeof logText !== 'string') return [];
  if (logText.indexOf('##[group]') === -1) return [];

  const lines = logText.split(/\r?\n/);
  const steps = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const groupIdx = line.indexOf('##[group]');
    const endgroupIdx = line.indexOf('##[endgroup]');
    if (groupIdx !== -1) {
      // Close any unterminated step before opening a new one.
      if (current) {
        current.failed = _stepBodyFailed(current.body);
        steps.push(current);
      }
      const name = line.slice(groupIdx + '##[group]'.length).trim() || `step-${steps.length + 1}`;
      current = { name, body: '', failed: false };
      continue;
    }
    if (endgroupIdx !== -1) {
      if (current) {
        current.failed = _stepBodyFailed(current.body);
        steps.push(current);
        current = null;
      }
      continue;
    }
    if (current) {
      current.body += (current.body ? '\n' : '') + line;
    }
  }
  // Tail the orphan step (some logs omit a trailing ##[endgroup]).
  if (current) {
    current.failed = _stepBodyFailed(current.body);
    steps.push(current);
  }
  return steps;
}

function _stepBodyFailed(body) {
  if (!body) return false;
  if (body.indexOf('##[error]') !== -1) return true;
  // Match "exit code 1", "exit code 137", "Process completed with exit code 2".
  const m = body.match(/exit code (\d+)/i);
  if (m && m[1] !== '0') return true;
  return false;
}

function extractFailingFiles(logText, repoRoot = process.cwd()) {
  if (!logText) return [];
  // Prefer the failing-step body if structured group markers exist.
  let target = logText;
  const steps = parseStepsFromLog(logText);
  if (steps.length > 0) {
    const failed = steps.filter((s) => s.failed);
    if (failed.length > 0) {
      target = failed.map((s) => s.body).join('\n');
    }
  }
  const out = new Set();
  const reAt   = /\bat\s+([^\s()]+\.[a-zA-Z0-9]+):(\d+)(?::\d+)?/g;
  const reBare = /(?:^|\s|\()((?:\/|[A-Za-z]:\\)?[^\s():]+?\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts|py|go|rs|java|rb|php|cs|kt|swift|json|yaml|yml|md))(?::(\d+))(?::\d+)?/g;
  let m;
  while ((m = reAt.exec(target)))   { if (_shouldKeepPath(m[1])) out.add(m[1]); }
  while ((m = reBare.exec(target))) { if (_shouldKeepPath(m[1])) out.add(m[1]); }
  const result = [];
  for (const p of out) {
    let rel = p;
    if (path.isAbsolute(p)) {
      try { rel = path.relative(repoRoot, p); } catch { rel = p; }
    }
    if (rel.startsWith('..') || rel.startsWith('/')) continue;
    result.push(rel.replace(/\\/g, '/'));
  }
  return result;
}

// (Claude prompt / parsing / retrying lives in ./ai-ci-fixer-claude.js)

// ── File ops ────────────────────────────────────────────────────────────────

function readFilesForClaude(filePaths, repoRoot) {
  const out = [];
  for (const rel of filePaths) {
    const abs = path.resolve(repoRoot, rel);
    if (!abs.startsWith(repoRoot)) continue;
    if (!fs.existsSync(abs)) continue;
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE_BYTES) continue;
      const content = fs.readFileSync(abs, 'utf-8');
      out.push({ path: rel, content });
    } catch (err) {
      logErr(`reading ${rel}`, err);
    }
  }
  return out;
}

function applyPatches(patches, repoRoot) {
  const written = [];
  // Snapshot {file, originalContent, newContent, reason} for each patch
  // BEFORE writing to disk. Downstream consumers (in particular
  // scripts/post-inline-suggestions.js) need the pre-write originalContent
  // to compute the changed-line range for GitHub ```suggestion``` blocks.
  // Reading from disk after writing returns the FIXED content — too late.
  // The snapshot lands at `.gatetest/fix-patches.json` (created if missing).
  // Failures here are non-fatal — the patch write still happens.
  const snapshot = [];
  for (const patch of patches) {
    if (!patch || typeof patch.file !== 'string' || typeof patch.content !== 'string') continue;
    if (patch.file.includes('..') || path.isAbsolute(patch.file)) continue;
    const abs = path.resolve(repoRoot, patch.file);
    if (!abs.startsWith(repoRoot)) continue;
    try {
      // Read original BEFORE the write so the snapshot is accurate.
      let originalContent = '';
      try {
        if (fs.existsSync(abs)) originalContent = fs.readFileSync(abs, 'utf-8');
      } catch (readErr) {
        logErr(`reading pre-write original for ${patch.file}`, readErr);
      }
      snapshot.push({
        file: patch.file,
        originalContent,
        newContent: patch.content,
        reason: patch.reason || patch.message || '',
      });

      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, patch.content, 'utf-8');
      written.push(patch.file);
    } catch (err) {
      logErr(`writing ${patch.file}`, err);
    }
  }

  // Best-effort snapshot write. Skip when no patches actually applied
  // (don't pollute the workspace with empty arrays).
  if (snapshot.length > 0) {
    try {
      const snapshotDir = path.join(repoRoot, '.gatetest');
      fs.mkdirSync(snapshotDir, { recursive: true });
      fs.writeFileSync(
        path.join(snapshotDir, 'fix-patches.json'),
        JSON.stringify(snapshot, null, 2),
        'utf-8',
      );
    } catch (err) {
      logErr('writing .gatetest/fix-patches.json snapshot', err);
    }
  }

  return written;
}

// ── Gate + git runners ──────────────────────────────────────────────────────

function runGate(repoRoot, opts = {}) {
  const runner = opts.runner || spawnSync;
  const r = runner(process.execPath, ['bin/gatetest.js', '--suite', 'quick'], {
    cwd: repoRoot, encoding: 'utf-8', timeout: opts.timeoutMs || 5 * 60_000,
  });
  return { ok: r.status === 0, status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error || null };
}

function git(args, repoRoot, opts = {}) {
  const runner = opts.runner || spawnSync;
  const r = runner('git', args, {
    cwd: repoRoot, encoding: 'utf-8', timeout: opts.timeoutMs || 60_000,
  });
  return { ok: r.status === 0, status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error || null };
}

// ── PR + issue bodies ───────────────────────────────────────────────────────

function buildPrBody({ runUrl, logExcerpt, attempt, model, diagnosis, patches }) {
  const safeLog = logExcerpt ? logExcerpt.split(/\r?\n/).slice(-80).join('\n') : '(no log captured)';
  const diag = diagnosis || { rootCause: '', plan: '', confidence: 0, confidenceReason: '' };

  let confidenceBlock = '';
  if (diag.confidence > 0) {
    const { confidenceBadge } = require('./ai-ci-fixer-diagnose');
    const badge = confidenceBadge(diag.confidence);
    confidenceBlock = `**Confidence:** ${badge.emoji} ${badge.label} (${diag.confidence}/5) — ${badge.tone}\n`;
    if (diag.confidenceReason) confidenceBlock += `> ${diag.confidenceReason}\n`;
    confidenceBlock += '\n';
  }

  let diagnosisBlock = '';
  if (diag.rootCause || diag.plan) {
    diagnosisBlock = '### Diagnosis\n\n';
    if (diag.rootCause) diagnosisBlock += `**Root cause:** ${diag.rootCause}\n\n`;
    if (diag.plan)      diagnosisBlock += `**Fix plan:** ${diag.plan}\n\n`;
  }

  let filesBlock = '';
  if (Array.isArray(patches) && patches.length > 0) {
    filesBlock = '### Files changed\n\n';
    for (const p of patches) {
      const tag = p.source === 'flywheel/ast'  ? '`AST`'
                : p.source === 'flywheel/rule' ? '`Rule`'
                : '`Claude`';
      filesBlock += `- ${tag} \`${p.file}\`\n`;
    }
    filesBlock += '\nThe **AST** and **Rule** tags are deterministic flywheel fixes — no Claude tokens spent. ' +
                  '**Claude** tags are bespoke LLM-generated patches.\n\n';
  }

  return `\
This PR was generated by the **GateTest AI CI-fixer**.

**Failing workflow:** ${runUrl}
**Attempt:** ${attempt} • **Model:** ${model}

${confidenceBlock}${diagnosisBlock}${filesBlock}<details>
<summary>CI log excerpt (last 80 lines)</summary>

\`\`\`
${safeLog}
\`\`\`

</details>

---

Review the diagnosis above, glance at the diff, and merge when satisfied.
The AI may have misread the failure or proposed a change that masks
rather than fixes the underlying bug — high-confidence (4-5) patches are
usually fine, lower scores deserve a careful read.

_Generated by GateTest • Powered by Claude_
`;
}

function buildIssueBody({ runUrl, logExcerpt, attempted, lastError, model }) {
  const safeLog = (logExcerpt || '').split(/\r?\n/).slice(-80).join('\n');
  const attemptsSummary = attempted.map(
    (a) => `- attempt ${a.attempt}: ${a.patchCount} patch(es) proposed`
  ).join('\n');
  return `\
The AI CI-fixer ran but couldn't repair this workflow run after all attempts.

**Failing workflow:** ${runUrl}
**Model:** ${model}

### Attempts
${attemptsSummary || '(no attempts recorded)'}

${lastError ? `### Last error\n\`\`\`\n${lastError.message}\n\`\`\`` : ''}

<details>
<summary>CI log excerpt</summary>

\`\`\`
${safeLog}
\`\`\`

</details>

A human will need to investigate. Generated by GateTest AI CI-fixer.
`;
}

// ── Env config ──────────────────────────────────────────────────────────────

function readEnv(env = process.env) {
  // ANTHROPIC_API_KEY presence IS the opt-in. The customer ships the key,
  // they get the fixer. No second flag needed.
  if (!env.ANTHROPIC_API_KEY) return { ok: false, reason: 'AI CI-fixer disabled (no ANTHROPIC_API_KEY)' };
  // GATETEST_AI_CI_FIXER is now an OPT-OUT, not opt-in. Default = enabled
  // when the key is present. Setting it to "0" is the escape hatch for
  // a customer burning through tokens. Any other value (including "1",
  // "true", or undefined) leaves the fixer enabled.
  if (env.GATETEST_AI_CI_FIXER === '0') {
    return { ok: false, reason: 'AI CI-fixer disabled (GATETEST_AI_CI_FIXER=0 — explicitly opted out)' };
  }
  if (!env.GITHUB_TOKEN)      return { ok: false, reason: 'AI CI-fixer disabled (no GITHUB_TOKEN)' };
  if (!env.GITHUB_REPOSITORY) return { ok: false, reason: 'AI CI-fixer disabled (no GITHUB_REPOSITORY)' };
  if (!env.WORKFLOW_RUN_ID)   return { ok: false, reason: 'AI CI-fixer disabled (no WORKFLOW_RUN_ID)' };
  const max = parseInt(env.MAX_FIX_ATTEMPTS || '', 10);
  return {
    ok: true,
    apiKey:      env.ANTHROPIC_API_KEY,
    token:       env.GITHUB_TOKEN,
    repo:        env.GITHUB_REPOSITORY,
    runId:       env.WORKFLOW_RUN_ID,
    maxAttempts: Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_ATTEMPTS,
    model:       env.CLAUDE_MODEL || claude.DEFAULT_MODEL,
  };
}

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  // Core constants
  DEFAULT_MAX_ATTEMPTS, MAX_LOG_LINES, MAX_FILE_BYTES, MAX_BRANCH_ATTEMPTS,
  // Claude constants (re-exported from lib/ai-ci-fixer-claude.js)
  ANTHROPIC_API_HOST:    claude.ANTHROPIC_API_HOST,
  ANTHROPIC_API_PATH:    claude.ANTHROPIC_API_PATH,
  ANTHROPIC_VERSION:     claude.ANTHROPIC_VERSION,
  DEFAULT_MODEL:         claude.DEFAULT_MODEL,
  CLAUDE_TIMEOUT_MS:     claude.CLAUDE_TIMEOUT_MS,
  MAX_INPUT_CHARS:       claude.MAX_INPUT_CHARS,
  CLAUDE_SYSTEM_PROMPT:  claude.CLAUDE_SYSTEM_PROMPT,
  CLAUDE_RETRY_ATTEMPTS: claude.CLAUDE_RETRY_ATTEMPTS,
  CLAUDE_RETRY_DELAYS_MS:claude.CLAUDE_RETRY_DELAYS_MS,
  CLAUDE_RETRY_BUDGET_MS:claude.CLAUDE_RETRY_BUDGET_MS,
  // Logging
  log, logErr,
  // GitHub
  githubRequest, isRateLimited,
  fetchWorkflowRun, fetchWorkflowLogs, fetchUrl,
  createPullRequest, createIssue,
  branchExists, findFreeBranchName,
  // Parsing
  tailLines, extractFailingFiles, parseStepsFromLog,
  buildClaudePrompt:  claude.buildClaudePrompt,
  parseClaudeResponse:claude.parseClaudeResponse,
  callClaude:         claude.callClaude,
  normaliseCiLog:     claude.normaliseCiLog,
  // I/O
  readFilesForClaude, applyPatches,
  // Runners
  runGate, git,
  // Bodies
  buildPrBody, buildIssueBody,
  // Config
  readEnv,
  // Test helpers
  _callClaudeOnce:        claude._callClaudeOnce,
  _isRetryableClaudeError:claude._isRetryableClaudeError,
  _parseRetryAfter:       claude._parseRetryAfter,
};
