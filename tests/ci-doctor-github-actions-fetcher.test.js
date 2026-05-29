"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  fetchWorkflowRun,
  listJobs,
  fetchJobLogs,
  fetchFailedJobLogs,
  resolveToken,
  authHeaders,
  validateOwnerRepo,
  GH_API,
} = require("../website/app/lib/ci-doctor/github-actions-fetcher.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetch(routes) {
  return async (url, init) => {
    const route = routes[url];
    if (!route) {
      return { ok: false, status: 404, text: async () => "not in route table", json: async () => ({}) };
    }
    const headers = init && init.headers ? init.headers : {};
    return {
      ok: route.ok !== false,
      status: route.status || 200,
      headers: { get: (k) => (route.headers || {})[k] },
      text: async () => (typeof route.body === "string" ? route.body : JSON.stringify(route.body)),
      json: async () => (typeof route.body === "string" ? JSON.parse(route.body) : route.body),
      _requestHeaders: headers,
    };
  };
}

// ---------------------------------------------------------------------------
// resolveToken
// ---------------------------------------------------------------------------

test("resolveToken: explicit arg wins", () => {
  const old = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "from-env";
  assert.equal(resolveToken("explicit"), "explicit");
  process.env.GITHUB_TOKEN = old;
});

test("resolveToken: GATETEST_GITHUB_TOKEN > GITHUB_TOKEN", () => {
  const oldA = process.env.GATETEST_GITHUB_TOKEN;
  const oldB = process.env.GITHUB_TOKEN;
  process.env.GATETEST_GITHUB_TOKEN = "gatetest-token";
  process.env.GITHUB_TOKEN = "github-token";
  assert.equal(resolveToken(), "gatetest-token");
  process.env.GATETEST_GITHUB_TOKEN = oldA;
  process.env.GITHUB_TOKEN = oldB;
});

test("resolveToken: returns null when no token configured", () => {
  const oldA = process.env.GATETEST_GITHUB_TOKEN;
  const oldB = process.env.GITHUB_TOKEN;
  delete process.env.GATETEST_GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  assert.equal(resolveToken(), null);
  if (oldA !== undefined) process.env.GATETEST_GITHUB_TOKEN = oldA;
  if (oldB !== undefined) process.env.GITHUB_TOKEN = oldB;
});

// ---------------------------------------------------------------------------
// authHeaders
// ---------------------------------------------------------------------------

test("authHeaders: includes Authorization Bearer when token present", () => {
  const h = authHeaders("abc123");
  assert.equal(h.Authorization, "Bearer abc123");
  assert.match(h["User-Agent"], /GateTest-CI-Doctor/);
  assert.equal(h["X-GitHub-Api-Version"], "2022-11-28");
});

test("authHeaders: omits Authorization when no token", () => {
  const h = authHeaders(null);
  assert.equal(h.Authorization, undefined);
});

// ---------------------------------------------------------------------------
// validateOwnerRepo
// ---------------------------------------------------------------------------

test("validateOwnerRepo: valid → ok (no throw)", () => {
  validateOwnerRepo("crclabs-hq", "GateTest");
  validateOwnerRepo("a", "b");
  validateOwnerRepo("with.dot", "with-dash_underscore");
});

test("validateOwnerRepo: rejects empty / invalid chars", () => {
  assert.throws(() => validateOwnerRepo("", "x"), TypeError);
  assert.throws(() => validateOwnerRepo("x", ""), TypeError);
  assert.throws(() => validateOwnerRepo("path/traversal", "x"), TypeError);
  assert.throws(() => validateOwnerRepo("x", "name with space"), TypeError);
  assert.throws(() => validateOwnerRepo(null, "x"), TypeError);
});

// ---------------------------------------------------------------------------
// fetchWorkflowRun
// ---------------------------------------------------------------------------

test("fetchWorkflowRun: returns normalised metadata", async () => {
  const _fetch = makeFetch({
    [`${GH_API}/repos/crclabs-hq/GateTest/actions/runs/12345`]: {
      ok: true,
      status: 200,
      body: {
        id: 12345,
        name: "CI",
        head_sha: "abc",
        status: "completed",
        conclusion: "failure",
        html_url: "https://github.com/.../runs/12345",
        event: "pull_request",
        created_at: "2026-05-29T00:00:00Z",
        updated_at: "2026-05-29T00:05:00Z",
      },
    },
  });
  const r = await fetchWorkflowRun({ owner: "crclabs-hq", repo: "GateTest", runId: 12345, _fetch });
  assert.equal(r.id, 12345);
  assert.equal(r.name, "CI");
  assert.equal(r.headSha, "abc");
  assert.equal(r.conclusion, "failure");
});

test("fetchWorkflowRun: 404 throws with GH_HTTP_404 code", async () => {
  const _fetch = makeFetch({}); // route table empty → 404
  await assert.rejects(
    fetchWorkflowRun({ owner: "x", repo: "y", runId: 1, _fetch }),
    (err) => err.code === "GH_HTTP_404"
  );
});

test("fetchWorkflowRun: validates owner/repo", async () => {
  await assert.rejects(fetchWorkflowRun({ owner: "", repo: "y", runId: 1 }), TypeError);
});

test("fetchWorkflowRun: requires runId", async () => {
  await assert.rejects(
    fetchWorkflowRun({ owner: "x", repo: "y", _fetch: makeFetch({}) }),
    TypeError
  );
});

// ---------------------------------------------------------------------------
// listJobs
// ---------------------------------------------------------------------------

test("listJobs: returns normalised job list", async () => {
  const _fetch = makeFetch({
    [`${GH_API}/repos/x/y/actions/runs/1/jobs?per_page=100`]: {
      body: {
        total_count: 2,
        jobs: [
          { id: 11, name: "build", status: "completed", conclusion: "success" },
          { id: 22, name: "test", status: "completed", conclusion: "failure" },
        ],
      },
    },
  });
  const jobs = await listJobs({ owner: "x", repo: "y", runId: 1, _fetch });
  assert.equal(jobs.length, 2);
  assert.equal(jobs[1].name, "test");
  assert.equal(jobs[1].conclusion, "failure");
});

test("listJobs: empty jobs list handled gracefully", async () => {
  const _fetch = makeFetch({
    [`${GH_API}/repos/x/y/actions/runs/1/jobs?per_page=100`]: { body: { jobs: [] } },
  });
  const jobs = await listJobs({ owner: "x", repo: "y", runId: 1, _fetch });
  assert.equal(jobs.length, 0);
});

// ---------------------------------------------------------------------------
// fetchJobLogs
// ---------------------------------------------------------------------------

test("fetchJobLogs: returns plain text body", async () => {
  const _fetch = makeFetch({
    [`${GH_API}/repos/x/y/actions/jobs/42/logs`]: {
      body: "2026-05-29T00:01:00Z FATAL ERROR: JavaScript heap out of memory\n",
    },
  });
  const logs = await fetchJobLogs({ owner: "x", repo: "y", jobId: 42, _fetch });
  assert.match(logs, /heap out of memory/);
});

test("fetchJobLogs: passes Authorization header when token present", async () => {
  let captured;
  const _fetch = async (url, init) => {
    captured = init.headers;
    return { ok: true, status: 200, text: async () => "ok" };
  };
  await fetchJobLogs({ owner: "x", repo: "y", jobId: 1, token: "test-token", _fetch });
  assert.equal(captured.Authorization, "Bearer test-token");
});

test("fetchJobLogs: 403 throws with code", async () => {
  const _fetch = async () => ({ ok: false, status: 403, text: async () => "rate limited" });
  await assert.rejects(
    fetchJobLogs({ owner: "x", repo: "y", jobId: 1, _fetch }),
    (err) => err.code === "GH_HTTP_403"
  );
});

// ---------------------------------------------------------------------------
// fetchFailedJobLogs (integration)
// ---------------------------------------------------------------------------

test("fetchFailedJobLogs: returns map of failed job logs only", async () => {
  const _fetch = makeFetch({
    [`${GH_API}/repos/x/y/actions/runs/1/jobs?per_page=100`]: {
      body: {
        jobs: [
          { id: 1, name: "lint", status: "completed", conclusion: "success" },
          { id: 2, name: "test", status: "completed", conclusion: "failure" },
          { id: 3, name: "build", status: "completed", conclusion: "failure" },
        ],
      },
    },
    [`${GH_API}/repos/x/y/actions/jobs/2/logs`]: { body: "TEST FAILED LOG" },
    [`${GH_API}/repos/x/y/actions/jobs/3/logs`]: { body: "BUILD FAILED LOG" },
  });
  const map = await fetchFailedJobLogs({ owner: "x", repo: "y", runId: 1, _fetch });
  assert.equal(map.size, 2);
  assert.equal(map.get("test"), "TEST FAILED LOG");
  assert.equal(map.get("build"), "BUILD FAILED LOG");
  assert.equal(map.has("lint"), false);
});

test("fetchFailedJobLogs: includes cancelled jobs as failed", async () => {
  const _fetch = makeFetch({
    [`${GH_API}/repos/x/y/actions/runs/2/jobs?per_page=100`]: {
      body: {
        jobs: [
          { id: 7, name: "slow-job", status: "completed", conclusion: "cancelled" },
        ],
      },
    },
    [`${GH_API}/repos/x/y/actions/jobs/7/logs`]: { body: "Job was cancelled" },
  });
  const map = await fetchFailedJobLogs({ owner: "x", repo: "y", runId: 2, _fetch });
  assert.equal(map.size, 1);
  assert.match(map.get("slow-job"), /cancelled/);
});

test("fetchFailedJobLogs: per-job log fetch failure surfaces as placeholder string", async () => {
  let callCount = 0;
  const _fetch = async (url) => {
    callCount += 1;
    if (callCount === 1) {
      // list jobs
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jobs: [{ id: 9, name: "missing-log", status: "completed", conclusion: "failure" }],
        }),
      };
    }
    // log fetch fails
    return { ok: false, status: 410, text: async () => "log archive expired" };
  };
  const map = await fetchFailedJobLogs({ owner: "x", repo: "y", runId: 3, _fetch });
  assert.equal(map.size, 1);
  assert.match(map.get("missing-log"), /CI Doctor: log fetch failed/);
});

test("fetchFailedJobLogs: empty failed list → empty map", async () => {
  const _fetch = makeFetch({
    [`${GH_API}/repos/x/y/actions/runs/4/jobs?per_page=100`]: {
      body: {
        jobs: [
          { id: 1, name: "all-good", status: "completed", conclusion: "success" },
        ],
      },
    },
  });
  const map = await fetchFailedJobLogs({ owner: "x", repo: "y", runId: 4, _fetch });
  assert.equal(map.size, 0);
});

// ---------------------------------------------------------------------------
// End-to-end with v0.1 classifier
// ---------------------------------------------------------------------------

test("integration: failed job logs → classifier produces a finding", async () => {
  // eslint-disable-next-line global-require
  const { topFailure } = require("../website/app/lib/ci-doctor/failure-classifier.js");
  const _fetch = makeFetch({
    [`${GH_API}/repos/x/y/actions/runs/1/jobs?per_page=100`]: {
      body: {
        jobs: [{ id: 1, name: "build", status: "completed", conclusion: "failure" }],
      },
    },
    [`${GH_API}/repos/x/y/actions/jobs/1/logs`]: {
      body: "step 1: install\nstep 2: build\nFATAL ERROR: JavaScript heap out of memory\nstep 3: aborted",
    },
  });
  const map = await fetchFailedJobLogs({ owner: "x", repo: "y", runId: 1, _fetch });
  const logText = map.get("build");
  const finding = topFailure(logText);
  assert.ok(finding);
  assert.equal(finding.class, "node-oom");
});
