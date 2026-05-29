/**
 * CI Doctor — GitHub Actions log fetcher (v0.4).
 *
 * Programmatic access to GitHub Actions workflow runs and job logs so
 * the doctor can run against a real failed CI run end-to-end:
 *
 *   1. `fetchWorkflowRun({owner, repo, runId, token})`
 *        Returns the run's high-level metadata (status, conclusion,
 *        head SHA, workflow name).
 *
 *   2. `listJobs({owner, repo, runId, token})`
 *        Returns the list of jobs in the run, each with status,
 *        conclusion, and IDs needed to fetch their logs.
 *
 *   3. `fetchJobLogs({owner, repo, jobId, token})`
 *        Returns the plain-text log for a single job (follows
 *        GitHub's 302 to its log-archive storage).
 *
 *   4. `fetchFailedJobLogs({owner, repo, runId, token})`
 *        Convenience: returns a Map<jobName, logText> with logs for
 *        every job whose conclusion is "failure" or "cancelled".
 *
 * Boss-Rule respect
 * -----------------
 *   - GitHub API integration is already established in this codebase
 *     (github-bridge.js, mcp-server, etc.) — this module reuses the
 *     same auth model (PAT via env / argument). It is not a NEW
 *     third-party integration.
 *   - READ-ONLY. The fetcher never posts to GitHub. Re-triggering
 *     workflow runs lives in a separate module (v0.5).
 *   - HTTP client is injectable for tests.
 *
 * Auth
 * ----
 *   Tokens supplied in priority order:
 *     1. explicit `token` argument
 *     2. process.env.GATETEST_GITHUB_TOKEN
 *     3. process.env.GITHUB_TOKEN
 *   If none are set, requests are made unauthenticated (works for
 *   public repos within GitHub's 60 req/hr unauth cap).
 */

"use strict";

const GH_API = "https://api.github.com";

function resolveToken(explicit) {
  if (explicit && typeof explicit === "string") return explicit;
  if (process.env.GATETEST_GITHUB_TOKEN) return process.env.GATETEST_GITHUB_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  return null;
}

function authHeaders(token) {
  const headers = {
    "User-Agent": "GateTest-CI-Doctor/0.4",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function validateOwnerRepo(owner, repo) {
  if (!owner || typeof owner !== "string") throw new TypeError("owner is required");
  if (!repo || typeof repo !== "string") throw new TypeError("repo is required");
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) {
    throw new TypeError(`invalid owner/repo: ${owner}/${repo}`);
  }
}

async function ghJson(url, { token, _fetch } = {}) {
  const fetchImpl = _fetch || (typeof fetch === "function" ? fetch : null);
  if (!fetchImpl) throw new Error("ghJson: no fetch available; pass _fetch for tests");
  const res = await fetchImpl(url, { headers: authHeaders(token), redirect: "follow" });
  if (!res || !res.ok) {
    const status = res ? res.status : "no-response";
    const body = res && typeof res.text === "function" ? await res.text().catch(() => "") : "";
    const err = new Error(`GitHub API ${status} for ${url}: ${body.slice(0, 200)}`);
    err.code = `GH_HTTP_${status}`;
    err.status = res ? res.status : null;
    throw err;
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// fetchWorkflowRun
// ---------------------------------------------------------------------------

/**
 * Fetch metadata for a single workflow run.
 *
 * @param {object} args
 * @param {string} args.owner
 * @param {string} args.repo
 * @param {number|string} args.runId
 * @param {string} [args.token]
 * @param {function} [args._fetch]
 * @returns {Promise<{
 *   id: number, name: string, headSha: string,
 *   status: string, conclusion: string|null,
 *   htmlUrl: string, event: string, createdAt: string, updatedAt: string,
 * }>}
 */
async function fetchWorkflowRun({ owner, repo, runId, token, _fetch }) {
  validateOwnerRepo(owner, repo);
  if (runId === undefined || runId === null) throw new TypeError("runId is required");
  const url = `${GH_API}/repos/${owner}/${repo}/actions/runs/${runId}`;
  const data = await ghJson(url, { token: resolveToken(token), _fetch });
  return {
    id: data.id,
    name: data.name,
    headSha: data.head_sha,
    status: data.status,
    conclusion: data.conclusion,
    htmlUrl: data.html_url,
    event: data.event,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

// ---------------------------------------------------------------------------
// listJobs
// ---------------------------------------------------------------------------

/**
 * List the jobs in a workflow run.
 */
async function listJobs({ owner, repo, runId, token, _fetch }) {
  validateOwnerRepo(owner, repo);
  if (runId === undefined || runId === null) throw new TypeError("runId is required");
  const url = `${GH_API}/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100`;
  const data = await ghJson(url, { token: resolveToken(token), _fetch });
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  return jobs.map((j) => ({
    id: j.id,
    name: j.name,
    status: j.status,
    conclusion: j.conclusion,
    startedAt: j.started_at,
    completedAt: j.completed_at,
    htmlUrl: j.html_url,
    runId: j.run_id,
    workflowName: j.workflow_name,
  }));
}

// ---------------------------------------------------------------------------
// fetchJobLogs — plain text
// ---------------------------------------------------------------------------

/**
 * Fetch the raw log text for a single job. GitHub returns 302 to a
 * temporary signed URL; `fetch` follows the redirect automatically.
 */
async function fetchJobLogs({ owner, repo, jobId, token, _fetch }) {
  validateOwnerRepo(owner, repo);
  if (jobId === undefined || jobId === null) throw new TypeError("jobId is required");
  const url = `${GH_API}/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`;
  const fetchImpl = _fetch || (typeof fetch === "function" ? fetch : null);
  if (!fetchImpl) throw new Error("fetchJobLogs: no fetch available; pass _fetch for tests");
  const res = await fetchImpl(url, { headers: authHeaders(resolveToken(token)), redirect: "follow" });
  if (!res || !res.ok) {
    const status = res ? res.status : "no-response";
    const err = new Error(`GitHub log fetch ${status} for job ${jobId}`);
    err.code = `GH_HTTP_${status}`;
    err.status = res ? res.status : null;
    throw err;
  }
  return res.text();
}

// ---------------------------------------------------------------------------
// fetchFailedJobLogs — convenience for the orchestrator
// ---------------------------------------------------------------------------

/**
 * Returns a map of {jobName -> logText} for every job in the run whose
 * conclusion is "failure" or "cancelled". Jobs that are still in
 * progress are skipped.
 *
 * The map is the right shape to feed into the v0.1 classifier — caller
 * does `for (const [jobName, log] of map) { classifyCIFailures(log) }`.
 *
 * @returns {Promise<Map<string, string>>}
 */
async function fetchFailedJobLogs({ owner, repo, runId, token, _fetch }) {
  const jobs = await listJobs({ owner, repo, runId, token, _fetch });
  const failed = jobs.filter((j) => j.conclusion === "failure" || j.conclusion === "cancelled");
  const out = new Map();
  for (const job of failed) {
    try {
      const logs = await fetchJobLogs({ owner, repo, jobId: job.id, token, _fetch });
      out.set(job.name, logs);
    } catch (err) {
      // Log fetch can fail per-job (transient 5xx, archive expired,
      // re-run that nuked the old log). Surface the error in the map
      // so callers see what's missing.
      out.set(job.name, `[GateTest CI Doctor: log fetch failed — ${err.message || String(err)}]`);
    }
  }
  return out;
}

module.exports = {
  fetchWorkflowRun,
  listJobs,
  fetchJobLogs,
  fetchFailedJobLogs,
  // exported for tests / extension
  resolveToken,
  authHeaders,
  validateOwnerRepo,
  GH_API,
};
