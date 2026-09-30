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

test("triage route: imports the shared admin gate", () => {
  const src = readRoute();
  // The real admin cookie is gt_admin (plus the OAuth admin session);
  // requireAdminRoute checks both — tests/admin-route-guard.test.js.
  assert.match(src, /import \{ requireAdminRoute \} from "@\/app\/lib\/admin-guard"/);
});

test("triage route: the gate is the first statement, same-origin on this POST", () => {
  const src = readRoute();
  assert.match(src, /export async function POST\(req: NextRequest\) \{\s*const refused = requireAdminRoute\(req, \{ mutating: true \}\);\s*if \(refused\) return refused;/);
});

test("triage route: no local copy of the admin check (401 comes from the gate)", () => {
  const src = readRoute();
  assert.doesNotMatch(src, /isAuthenticatedAdmin|gatetest-admin-v1/);
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
