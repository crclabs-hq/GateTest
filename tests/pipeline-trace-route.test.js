"use strict";

/**
 * Static-source assertions for /api/admin/triage/pipeline/route.ts.
 *
 * We can't import the .ts route from node:test (no TS loader), so we
 * assert the file shape: admin auth wired in, parallel fan-out to the
 * four pipeline stages (source / ci / deploy / live), correlator wired
 * up correctly, correct response surface for the UI agent.
 *
 * Same approach as tests/triage-route.test.js.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ROUTE_PATH = path.join(
  ROOT,
  "website/app/api/admin/triage/pipeline/route.ts"
);

function readRoute() {
  return fs.readFileSync(ROUTE_PATH, "utf8");
}

test("pipeline-trace route: file exists at the contracted path", () => {
  assert.ok(
    fs.existsSync(ROUTE_PATH),
    `expected route file at ${ROUTE_PATH}`
  );
});

test("pipeline-trace route: enforces admin cookie check (gatetest_admin)", () => {
  const src = readRoute();
  assert.match(
    src,
    /ADMIN_COOKIE_NAME|gatetest_admin/,
    "must reference the gatetest_admin cookie / canonical export"
  );
});

test("pipeline-trace route: uses the canonical isAuthenticatedAdmin helper", () => {
  const src = readRoute();
  assert.match(src, /isAuthenticatedAdmin/);
  assert.match(src, /getAdminConfig/);
  assert.match(src, /getAdminUser/);
});

test("pipeline-trace route: returns 401 when the admin check fails", () => {
  const src = readRoute();
  assert.match(src, /status:\s*401/);
  assert.match(src, /Unauthorized/);
});

test("pipeline-trace route: returns 400 when repoUrl is missing or invalid", () => {
  const src = readRoute();
  assert.match(src, /invalid-repoUrl/);
  assert.match(src, /status:\s*400/);
});

test("pipeline-trace route: returns 400 when liveUrl is missing or invalid", () => {
  const src = readRoute();
  assert.match(src, /invalid-liveUrl/);
});

test("pipeline-trace route: validates liveUrl is an http(s) URL", () => {
  const src = readRoute();
  // Must check protocol family — http or https only.
  assert.match(src, /isValidLiveUrl/);
  assert.match(src, /protocol\s*===\s*["']http:["']|protocol\s*===\s*["']https:["']/);
});

test("pipeline-trace route: returns 503 when no GitHub token is configured", () => {
  const src = readRoute();
  assert.match(src, /no-github-token|GATETEST_GITHUB_TOKEN/);
  assert.match(src, /status:\s*503/);
});

test("pipeline-trace route: reads GATETEST_GITHUB_TOKEN or GITHUB_TOKEN", () => {
  const src = readRoute();
  assert.match(src, /GATETEST_GITHUB_TOKEN/);
  assert.match(src, /GITHUB_TOKEN/);
});

test("pipeline-trace route: calls GitHub branch endpoint for source SHA", () => {
  const src = readRoute();
  assert.match(src, /\/repos\/.+\/branches\//);
});

test("pipeline-trace route: calls GitHub workflow runs endpoint for CI stage", () => {
  const src = readRoute();
  assert.match(src, /\/actions\/runs\?branch=/);
});

test("pipeline-trace route: calls GitHub deployments endpoint for deploy stage", () => {
  const src = readRoute();
  assert.match(src, /\/deployments\?ref=/);
});

test("pipeline-trace route: fetches the live URL with a no-cache header", () => {
  const src = readRoute();
  // The live probe must set cache-control: no-cache so we never read a stale
  // edge-cached copy when the whole point is to detect staleness.
  assert.match(src, /["']cache-control["']\s*:\s*["']no-cache["']/);
});

test("pipeline-trace route: sets a GateTest user-agent on the live URL probe", () => {
  const src = readRoute();
  assert.match(src, /GateTest-PipelineTrace/);
});

test("pipeline-trace route: uses Promise.allSettled for parallel fan-out", () => {
  const src = readRoute();
  assert.match(src, /Promise\.allSettled/);
});

test("pipeline-trace route: imports trace + renderTraceMarkdown from pipeline-trace correlator", () => {
  const src = readRoute();
  assert.match(src, /pipeline-trace\/correlator/);
  assert.match(src, /\btrace\b/);
  assert.match(src, /renderTraceMarkdown/);
});

test("pipeline-trace route: pins runtime=nodejs, dynamic=force-dynamic, maxDuration=60", () => {
  const src = readRoute();
  assert.match(src, /export\s+const\s+runtime\s*=\s*["']nodejs["']/);
  assert.match(src, /export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/);
  assert.match(src, /export\s+const\s+maxDuration\s*=\s*60/);
});

test("pipeline-trace route: response carries verdict, stages, markdown for the UI", () => {
  const src = readRoute();
  assert.match(src, /\bverdict\b/);
  assert.match(src, /\bstages\b/);
  assert.match(src, /\bmarkdown\b/);
});

test("pipeline-trace route: response carries tracedAt + durationMs + inputs", () => {
  const src = readRoute();
  assert.match(src, /tracedAt/);
  assert.match(src, /durationMs/);
  assert.match(src, /\binputs\b/);
});

test("pipeline-trace route: wraps the orchestrator in a top-level try/catch and logs crashes", () => {
  const src = readRoute();
  assert.match(src, /try\s*\{/);
  assert.match(src, /catch\s*\(/);
  assert.match(src, /\[GateTest\][^"\n]*pipeline[^"\n]*crashed/i);
  assert.match(src, /pipeline-trace-failed/);
});

test("pipeline-trace route: exports POST as the HTTP handler", () => {
  const src = readRoute();
  assert.match(src, /export\s+async\s+function\s+POST\s*\(/);
});

test("pipeline-trace route: extracts SHA markers from the live HTML body", () => {
  const src = readRoute();
  // Must look for at least the meta-commit form and the Next.js build-id form
  // — those are the two real-world signals every Vercel/Next deploy emits.
  // The route's regex uses `name=["']commit["']` — assert the source contains
  // both the literal "commit" marker and the Next.js build-id pattern.
  assert.ok(src.includes('name=["\']commit["\']') || src.includes("name=[\"']commit[\"']") || /name=.{0,4}commit/.test(src),
    "must extract <meta name=\"commit\"> SHA marker");
  assert.match(src, /_next/);
});

test("pipeline-trace route: accepts both 'owner/repo' shorthand and full GitHub URL", () => {
  const src = readRoute();
  assert.match(src, /parseRepoUrl/);
  // Shorthand pattern must accept owner/repo with no protocol prefix —
  // detected by the github.com hostname check + a shorthand regex pair.
  assert.match(src, /github\.com/);
  assert.match(src, /A-Za-z0-9\._-/);
});

test("pipeline-trace route: does NOT include any new eslint-disable directives", () => {
  const src = readRoute();
  assert.doesNotMatch(src, /eslint-disable/);
});
