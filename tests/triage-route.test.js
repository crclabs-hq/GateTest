"use strict";

/**
 * Static-source assertions for /api/admin/triage/route.ts.
 *
 * We can't import the .ts route from node:test (no TS loader), so we
 * assert the file shape: admin auth wired in, correct fan-out to the
 * three downstream scans, correct response surface for the UI agent.
 *
 * Same approach as tests/hn-launch-dashboard-api.test.js.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ROUTE_PATH = path.join(
  ROOT,
  "website/app/api/admin/triage/route.ts"
);

function readRoute() {
  return fs.readFileSync(ROUTE_PATH, "utf8");
}

test("triage route: file exists at the contracted path", () => {
  assert.ok(
    fs.existsSync(ROUTE_PATH),
    `expected route file at ${ROUTE_PATH}`
  );
});

test("triage route: enforces admin cookie check (gatetest_admin)", () => {
  const src = readRoute();
  // The admin cookie is canonically named gatetest_admin; the route must
  // reference it via the canonical helper exports.
  assert.match(
    src,
    /ADMIN_COOKIE_NAME|gatetest_admin/,
    "must reference the gatetest_admin cookie / canonical export"
  );
});

test("triage route: uses the canonical isAuthenticatedAdmin helper", () => {
  const src = readRoute();
  assert.match(src, /isAuthenticatedAdmin/);
  assert.match(src, /getAdminConfig/);
  assert.match(src, /getAdminUser/);
});

test("triage route: returns 401 when the admin check fails", () => {
  const src = readRoute();
  assert.match(src, /status:\s*401/);
  assert.match(src, /Unauthorized/);
});

test("triage route: returns 400 when repoUrl is missing or invalid", () => {
  const src = readRoute();
  assert.match(src, /invalid-repoUrl/);
  assert.match(src, /status:\s*400/);
});

test("triage route: returns 400 when liveUrl is missing or invalid", () => {
  const src = readRoute();
  assert.match(src, /invalid-liveUrl/);
});

test("triage route: fans out to all three downstream scan endpoints", () => {
  const src = readRoute();
  assert.match(src, /\/api\/scan\/run/);
  assert.match(src, /\/api\/scan\/server/);
  assert.match(src, /\/api\/web\/scan/);
});

test("triage route: uses Promise.allSettled for parallel fan-out", () => {
  const src = readRoute();
  assert.match(src, /Promise\.allSettled/);
});

test("triage route: forwards x-admin-token on downstream calls", () => {
  const src = readRoute();
  assert.match(src, /deriveAdminToken/);
  assert.match(src, /x-admin-token/);
});

test("triage route: imports correlate / summariseLayer / renderVerdictMarkdown from triage correlator", () => {
  const src = readRoute();
  assert.match(src, /triage\/correlator/);
  assert.match(src, /\bcorrelate\b/);
  assert.match(src, /summariseLayer/);
  assert.match(src, /renderVerdictMarkdown/);
});

test("triage route: pins runtime=nodejs, dynamic=force-dynamic, maxDuration=60", () => {
  const src = readRoute();
  assert.match(src, /export\s+const\s+runtime\s*=\s*["']nodejs["']/);
  assert.match(src, /export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/);
  assert.match(src, /export\s+const\s+maxDuration\s*=\s*60/);
});

test("triage route: response carries verdict, layers, markdown for the UI", () => {
  const src = readRoute();
  assert.match(src, /\bverdict\b/);
  assert.match(src, /\blayers\b/);
  assert.match(src, /\bmarkdown\b/);
});

test("triage route: wraps the orchestrator in a top-level try/catch and logs crashes", () => {
  const src = readRoute();
  assert.match(src, /try\s*\{/);
  assert.match(src, /catch\s*\(/);
  assert.match(src, /\[GateTest\]\s*triage POST crashed/);
  assert.match(src, /triage-failed/);
});

test("triage route: exports POST as the HTTP handler", () => {
  const src = readRoute();
  assert.match(src, /export\s+async\s+function\s+POST\s*\(/);
});

test("triage route: defaults serverUrl to liveUrl when omitted", () => {
  const src = readRoute();
  // Either an explicit `|| liveUrlRaw` fallback or a ternary using the live URL.
  assert.match(src, /serverUrl/);
  assert.match(src, /liveUrl/);
});

test("triage route: does NOT include any new eslint-disable directives", () => {
  const src = readRoute();
  assert.doesNotMatch(src, /eslint-disable/);
});
