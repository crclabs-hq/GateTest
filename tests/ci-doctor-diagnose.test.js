"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  diagnose,
  renderReport,
  resolveRunIdForPR,
  sanitiseJobName,
} = require("../website/app/lib/ci-doctor/diagnose.js");
const { GH_API } = require("../website/app/lib/ci-doctor/github-actions-fetcher.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetch(routes) {
  return async (url) => {
    const route = routes[url];
    if (!route) {
      return { ok: false, status: 404, text: async () => "not in route table", json: async () => ({}) };
    }
    return {
      ok: route.ok !== false,
      status: route.status || 200,
      text: async () => (typeof route.body === "string" ? route.body : JSON.stringify(route.body)),
      json: async () => (typeof route.body === "string" ? JSON.parse(route.body) : route.body),
    };
  };
}

function makeFs(initial = {}) {
  // Normalize separators so the fake fs behaves like a real one on
  // Windows too: the applier builds paths with path.join (backslashes
  // on win32), while tests key this map with forward slashes. Real
  // filesystems accept both — the double must as well.
  const norm = (p) => String(p).replace(/\\/g, "/");
  const files = new Map(Object.entries(initial).map(([k, v]) => [norm(k), v]));
  return {
    files,
    existsSync: (p) => files.has(norm(p)),
    readFileSync: (p) => files.get(norm(p)),
    writeFileSync: (p, data) => { files.set(norm(p), data); },
  };
}

function makeExec(responses = []) {
  let i = 0;
  const calls = [];
  return {
    calls,
    run: async (cmd, opts) => {
      calls.push({ cmd, cwd: opts.cwd });
      return responses[Math.min(i++, responses.length - 1)] || { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

const OOM_LOG = [
  "step 1: install",
  "step 2: build",
  "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
  "step 3: aborted",
].join("\n");

const LINT_LOG = [
  "/repo/src/index.js",
  "  1:1  error  Unexpected console statement  no-console",
  "",
  "5 problems (5 errors, 0 warnings)",
].join("\n");

// ---------------------------------------------------------------------------
// sanitiseJobName
// ---------------------------------------------------------------------------

test("sanitiseJobName: matrix expansion is stripped", () => {
  assert.equal(sanitiseJobName("test (node-22, ubuntu-latest)"), "test");
  assert.equal(sanitiseJobName("build_x86"), "build_x86");
  assert.equal(sanitiseJobName("lint"), "lint");
});

test("sanitiseJobName: handles null gracefully", () => {
  assert.equal(sanitiseJobName(null), null);
  assert.equal(sanitiseJobName(""), "");
});

// ---------------------------------------------------------------------------
// diagnose — bail-outs
// ---------------------------------------------------------------------------

test("diagnose: missing owner/repo → error report", async () => {
  const r = await diagnose({});
  assert.equal(r.error, "owner-and-repo-required");
});

test("diagnose: no runId and no prNumber → error report", async () => {
  const r = await diagnose({ owner: "x", repo: "y" });
  assert.equal(r.error, "no-runId");
});

// ---------------------------------------------------------------------------
// diagnose — happy path, dry run
// ---------------------------------------------------------------------------

test("diagnose: classifies failed jobs and produces proposals", async () => {
  const _fetch = makeFetch({
    [`${GH_API}/repos/x/y/actions/runs/1`]: {
      body: {
        id: 1, name: "CI", head_sha: "abc",
        status: "completed", conclusion: "failure",
        html_url: "https://github.com/x/y/runs/1",
        event: "pull_request",
        created_at: "2026-05-29T00:00:00Z",
        updated_at: "2026-05-29T00:05:00Z",
      },
    },
    [`${GH_API}/repos/x/y/actions/runs/1/jobs?per_page=100`]: {
      body: {
        jobs: [
          { id: 11, name: "build", status: "completed", conclusion: "failure" },
          { id: 22, name: "lint", status: "completed", conclusion: "failure" },
        ],
      },
    },
    [`${GH_API}/repos/x/y/actions/jobs/11/logs`]: { body: OOM_LOG },
    [`${GH_API}/repos/x/y/actions/jobs/22/logs`]: { body: LINT_LOG },
  });
  const r = await diagnose({
    owner: "x",
    repo: "y",
    runId: 1,
    recipeContext: { workflowPaths: [".github/workflows/ci.yml"] },
    workspaceRoot: "/workspace",
    _fetch,
  });
  assert.equal(r.run.id, 1);
  assert.equal(r.jobs.length, 2);
  // Build job: OOM classified
  const build = r.jobs.find((j) => j.name === "build");
  assert.ok(build);
  assert.ok(build.findings.some((f) => f.class === "node-oom"));
  assert.ok(build.proposals.some((p) => p.proposal && p.proposal.class === "node-oom"));
  // Lint job: lint-error classified
  const lint = r.jobs.find((j) => j.name === "lint");
  assert.ok(lint);
  assert.ok(lint.findings.some((f) => f.class === "lint-error"));
});

test("diagnose: dry run (apply=false) does NOT touch files or run commands", async () => {
  const _fetch = makeFetch({
    [`${GH_API}/repos/x/y/actions/runs/1`]: {
      body: {
        id: 1, name: "CI", head_sha: "abc", status: "completed", conclusion: "failure",
        html_url: "url", event: "push", created_at: "t", updated_at: "t",
      },
    },
    [`${GH_API}/repos/x/y/actions/runs/1/jobs?per_page=100`]: {
      body: { jobs: [{ id: 11, name: "build", status: "completed", conclusion: "failure" }] },
    },
    [`${GH_API}/repos/x/y/actions/jobs/11/logs`]: { body: OOM_LOG },
  });
  const fs = makeFs({ "/workspace/.github/workflows/ci.yml": "        run: npm run build" });
  const exec = makeExec();
  const r = await diagnose({
    owner: "x",
    repo: "y",
    runId: 1,
    recipeContext: { workflowPaths: [".github/workflows/ci.yml"] },
    workspaceRoot: "/workspace",
    apply: false,
    _fetch,
    _fs: fs,
    _exec: exec,
  });
  // No applies in the report (dry mode)
  assert.equal(r.jobs[0].applies.length, 0);
  // File untouched
  assert.equal(fs.files.get("/workspace/.github/workflows/ci.yml"), "        run: npm run build");
  // No exec calls
  assert.equal(exec.calls.length, 0);
});

// ---------------------------------------------------------------------------
// diagnose — apply mode
// ---------------------------------------------------------------------------

test("diagnose: apply=true with node-oom finding actually patches the workflow", async () => {
  const _fetch = makeFetch({
    [`${GH_API}/repos/x/y/actions/runs/1`]: {
      body: {
        id: 1, name: "CI", head_sha: "abc", status: "completed", conclusion: "failure",
        html_url: "url", event: "push", created_at: "t", updated_at: "t",
      },
    },
    [`${GH_API}/repos/x/y/actions/runs/1/jobs?per_page=100`]: {
      body: { jobs: [{ id: 11, name: "build", status: "completed", conclusion: "failure" }] },
    },
    [`${GH_API}/repos/x/y/actions/jobs/11/logs`]: { body: OOM_LOG },
  });
  const fs = makeFs({
    "/workspace/.github/workflows/ci.yml": "      - name: Build\n        run: npm run build\n",
  });
  const exec = makeExec();
  const r = await diagnose({
    owner: "x",
    repo: "y",
    runId: 1,
    recipeContext: { workflowPaths: [".github/workflows/ci.yml"] },
    workspaceRoot: "/workspace",
    apply: true,
    _fetch,
    _fs: fs,
    _exec: exec,
  });
  assert.equal(r.summary.proposalsAutoApplied, 1);
  assert.match(fs.files.get("/workspace/.github/workflows/ci.yml"), /NODE_OPTIONS: --max-old-space-size=8192/);
});

test("diagnose: requiresHumanReview proposals NOT applied unless flag set", async () => {
  // Snapshot-mismatch fires requiresHumanReview: true. The applier
  // should report needs-review without touching anything.
  const SNAPSHOT_LOG = "FAIL src/comp.test.tsx\n × renders\n  Snapshot name: `Header > renders 1`\n  Snapshot failed.";
  const _fetch = makeFetch({
    [`${GH_API}/repos/x/y/actions/runs/2`]: {
      body: {
        id: 2, name: "CI", head_sha: "z", status: "completed", conclusion: "failure",
        html_url: "url", event: "push", created_at: "t", updated_at: "t",
      },
    },
    [`${GH_API}/repos/x/y/actions/runs/2/jobs?per_page=100`]: {
      body: { jobs: [{ id: 33, name: "test", status: "completed", conclusion: "failure" }] },
    },
    [`${GH_API}/repos/x/y/actions/jobs/33/logs`]: { body: SNAPSHOT_LOG },
  });
  const fs = makeFs();
  const exec = makeExec();
  const r = await diagnose({
    owner: "x",
    repo: "y",
    runId: 2,
    workspaceRoot: "/workspace",
    apply: true,
    autoApplyReviewRequired: false,
    _fetch,
    _fs: fs,
    _exec: exec,
  });
  // Snapshot recipe ALWAYS sets requiresHumanReview; should report
  // needs-review.
  assert.equal(r.summary.proposalsNeedingReview, 1);
  assert.equal(r.summary.proposalsAutoApplied, 0);
  assert.equal(exec.calls.length, 0);
});

// ---------------------------------------------------------------------------
// diagnose — PR-number resolution
// ---------------------------------------------------------------------------

test("diagnose: resolves prNumber → runId via API", async () => {
  const _fetch = makeFetch({
    [`${GH_API}/repos/x/y/pulls/42`]: {
      body: { head: { sha: "deadbeef" } },
    },
    [`${GH_API}/repos/x/y/actions/runs?head_sha=deadbeef&per_page=50`]: {
      body: {
        workflow_runs: [
          { id: 99, conclusion: "success", updated_at: "2026-05-29T00:00:00Z" },
          { id: 100, conclusion: "failure", updated_at: "2026-05-29T00:05:00Z" },
        ],
      },
    },
    [`${GH_API}/repos/x/y/actions/runs/100`]: {
      body: {
        id: 100, name: "CI", head_sha: "deadbeef",
        status: "completed", conclusion: "failure",
        html_url: "url", event: "pull_request", created_at: "t", updated_at: "t",
      },
    },
    [`${GH_API}/repos/x/y/actions/runs/100/jobs?per_page=100`]: { body: { jobs: [] } },
  });
  const r = await diagnose({ owner: "x", repo: "y", prNumber: 42, _fetch });
  assert.equal(r.run.id, 100);
});

test("resolveRunIdForPR: throws when PR doesn't exist", async () => {
  const _fetch = makeFetch({});
  await assert.rejects(
    resolveRunIdForPR({ owner: "x", repo: "y", prNumber: 999, _fetch }),
    /not accessible/
  );
});

// ---------------------------------------------------------------------------
// renderReport
// ---------------------------------------------------------------------------

test("renderReport: error report renders compactly", () => {
  const md = renderReport({ error: "no-runId" });
  assert.match(md, /Error: no-runId/);
});

test("renderReport: success report includes summary table + per-job findings", () => {
  const md = renderReport({
    run: { id: 1, name: "CI", conclusion: "failure", htmlUrl: "url", headSha: "abc" },
    jobs: [
      {
        name: "build",
        conclusion: "failure",
        logBytes: 1234,
        findings: [
          {
            class: "node-oom",
            confidence: "high",
            lineNumber: 3,
            evidence: "FATAL ERROR: heap out of memory",
            suggestedFix: "Bump NODE_OPTIONS",
            autoFixable: true,
          },
        ],
        proposals: [
          {
            forClass: "node-oom",
            proposal: {
              class: "node-oom",
              description: "Bump heap to 8192MB",
              requiresHumanReview: false,
            },
          },
        ],
        applies: [],
      },
    ],
    summary: {
      jobsAnalysed: 1,
      findings: 1,
      proposals: 1,
      proposalsAutoApplied: 0,
      proposalsNeedingReview: 0,
      proposalsErrored: 0,
    },
  });
  assert.match(md, /CI Doctor report/);
  assert.match(md, /\*\*Run:\*\* \[CI #1\]\(url\)/);
  assert.match(md, /Findings.+1/);
  assert.match(md, /node-oom/);
  assert.match(md, /Bump heap to 8192MB/);
});
