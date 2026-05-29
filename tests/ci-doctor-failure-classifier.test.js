"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyCIFailures,
  topFailure,
  knownClasses,
  RULES,
} = require("../website/app/lib/ci-doctor/failure-classifier.js");

// ---------------------------------------------------------------------------
// Sanity
// ---------------------------------------------------------------------------

test("classifyCIFailures: empty / non-string input → []", () => {
  assert.deepEqual(classifyCIFailures(""), []);
  assert.deepEqual(classifyCIFailures(null), []);
  assert.deepEqual(classifyCIFailures(undefined), []);
  assert.deepEqual(classifyCIFailures(123), []);
});

test("classifyCIFailures: clean log with no recognised errors → []", () => {
  const log = [
    "::group::Install dependencies",
    "npm install completed successfully",
    "::endgroup::",
    "All tests passed.",
  ].join("\n");
  assert.deepEqual(classifyCIFailures(log), []);
});

test("knownClasses: returns a non-empty unique list", () => {
  const all = knownClasses();
  assert.ok(all.length >= 15);
  assert.equal(new Set(all).size, all.length, "class names must be unique");
});

test("RULES: every rule has the required shape", () => {
  for (const rule of RULES) {
    assert.ok(typeof rule.class === "string" && rule.class.length > 0, `class: ${rule.class}`);
    assert.ok(typeof rule.priority === "number", `priority on ${rule.class}`);
    assert.ok(["high", "medium", "low"].includes(rule.confidence), `confidence on ${rule.class}`);
    assert.ok(typeof rule.autoFixable === "boolean", `autoFixable on ${rule.class}`);
    assert.ok(Array.isArray(rule.patterns) && rule.patterns.length > 0, `patterns on ${rule.class}`);
    assert.ok(typeof rule.suggestedFix === "string" && rule.suggestedFix.length > 0, `suggestedFix on ${rule.class}`);
  }
});

// ---------------------------------------------------------------------------
// Dependency / install
// ---------------------------------------------------------------------------

test("classifies: lockfile drift (npm EUSAGE)", () => {
  const log = "npm error code EUSAGE\nnpm error npm ci can only install packages when your package.json and package-lock.json are in sync.";
  const r = topFailure(log);
  assert.ok(r);
  assert.equal(r.class, "dep-lockfile-drift");
  assert.equal(r.autoFixable, true);
});

test("classifies: lockfile drift (pnpm not up to date)", () => {
  const log = "ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with \"frozen-lockfile\" because pnpm-lock.yaml is not up to date with package.json";
  const r = topFailure(log);
  assert.ok(r);
  assert.equal(r.class, "dep-lockfile-drift");
});

test("classifies: network blip to npm registry", () => {
  const log = "npm ERR! network request to https://registry.npmjs.org/lodash failed, reason: connect ETIMEDOUT registry.npmjs.org:443";
  const r = topFailure(log);
  assert.ok(r);
  assert.equal(r.class, "dep-network-blip");
  assert.equal(r.autoFixable, true);
});

test("classifies: peer dependency conflict", () => {
  const log = "npm error ERESOLVE could not resolve dependency tree\nnpm error peer typescript@\">=4.5\" from @typescript-eslint/parser@5.10.0";
  const r = topFailure(log);
  assert.ok(r);
  assert.equal(r.class, "dep-peer-conflict");
  assert.equal(r.autoFixable, false); // peer conflicts need human review
});

test("classifies: native build failure (sharp)", () => {
  const log = "node-gyp ERR! build error\ngyp ERR! configure error\nCannot find module 'sharp' on linux-x64";
  const r = topFailure(log);
  assert.ok(r);
  assert.equal(r.class, "dep-native-build-fail");
});

// ---------------------------------------------------------------------------
// Build / compile
// ---------------------------------------------------------------------------

test("classifies: TypeScript error code", () => {
  const log = "src/index.ts(42,10): error TS2304: Cannot find name 'foo'.\nFound 1 error in 1 file.";
  const r = topFailure(log);
  assert.ok(r);
  assert.equal(r.class, "typescript-error");
  assert.equal(r.autoFixable, true);
});

test("classifies: Node OOM (heap out of memory)", () => {
  const log = "<--- Last few GCs --->\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory";
  const r = topFailure(log);
  assert.ok(r);
  assert.equal(r.class, "node-oom");
  assert.equal(r.confidence, "high");
});

test("classifies: exit code 137 = OOM SIGKILL", () => {
  const log = "Build script exited with exit code 137";
  const r = topFailure(log);
  assert.ok(r);
  assert.equal(r.class, "node-oom");
});

test("classifies: missing env var (NEXT_PUBLIC pattern)", () => {
  const log = "Error: Required environment variable DATABASE_URL is not set";
  const r = topFailure(log);
  assert.ok(r);
  assert.equal(r.class, "missing-env-var");
  // We do NOT auto-add env vars — Boss Rule territory
  assert.equal(r.autoFixable, false);
});

// ---------------------------------------------------------------------------
// Test failures
// ---------------------------------------------------------------------------

test("classifies: generic test failure (node:test summary)", () => {
  const log = "# tests 12\n# fail 3\n# pass 9\n";
  const r = topFailure(log);
  assert.ok(r);
  assert.equal(r.class, "test-failure");
});

test("classifies: snapshot mismatch", () => {
  const log = "FAIL src/component.test.tsx\n × should render header\n  Snapshot name: `Header > should render header 1`\n  Snapshot failed.";
  // Multiple findings expected; the snapshot-specific one should win (priority 92 > test-failure 90)
  const r = topFailure(log);
  assert.ok(r);
  assert.equal(r.class, "test-snapshot-mismatch");
});

test("classifies: flaky timer / timeout test", () => {
  const log = "FAIL src/api.test.js\n × should resolve\n  Test timed out in 5000ms";
  // test-failure (90) beats test-flaky-timer (70), so the top is test-failure
  // but the timer finding should still appear in the full list
  const all = classifyCIFailures(log);
  const classes = all.map((f) => f.class);
  assert.ok(classes.includes("test-flaky-timer"));
});

// ---------------------------------------------------------------------------
// Lint
// ---------------------------------------------------------------------------

test("classifies: ESLint problem count", () => {
  const log = "/repo/src/index.js\n  1:1  error  Unexpected console statement  no-console\n\n7 problems (3 errors, 4 warnings)";
  const r = topFailure(log);
  assert.ok(r);
  assert.equal(r.class, "lint-error");
});

test("classifies: prettier --check failed", () => {
  const log = "Checking formatting...\nsrc/foo.ts\nCode style issues found in the above file. Forgot to run Prettier?";
  const r = topFailure(log);
  assert.ok(r);
  assert.equal(r.class, "lint-error");
});

// ---------------------------------------------------------------------------
// CI infrastructure
// ---------------------------------------------------------------------------

test("classifies: runner timeout (job exceeded max execution)", () => {
  const log = "Error: The job running on runner ubuntu-latest has exceeded the maximum execution time of 360 minutes.";
  const r = topFailure(log);
  assert.ok(r);
  assert.equal(r.class, "runner-timeout");
  assert.equal(r.confidence, "high");
});

test("classifies: runner lost connection", () => {
  const log = "The hosted runner: GitHub Actions 5 lost communication with the server. Verify the machine is running and has a healthy network connection.";
  const r = topFailure(log);
  assert.ok(r);
  assert.equal(r.class, "runner-lost-connection");
});

test("classifies: disk full (ENOSPC)", () => {
  const log = "Error: write EROFS: ENOSPC No space left on device";
  const r = topFailure(log);
  assert.ok(r);
  assert.equal(r.class, "ci-disk-full");
});

// ---------------------------------------------------------------------------
// GitHub Actions specific
// ---------------------------------------------------------------------------

test("classifies: action version broken / not found", () => {
  const log = "Error: Cannot find action 'actions/checkout@v99' on the marketplace";
  const r = topFailure(log);
  assert.ok(r);
  assert.equal(r.class, "action-version-broken");
});

test("classifies: GITHUB_TOKEN permissions error", () => {
  const log = "Error: Resource not accessible by integration. The GITHUB_TOKEN lacks the required permission.";
  const r = topFailure(log);
  assert.ok(r);
  assert.equal(r.class, "github-token-permissions");
});

test("classifies: git push rejected non-fast-forward", () => {
  const log = "! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs to 'origin'";
  const r = topFailure(log);
  assert.ok(r);
  assert.equal(r.class, "git-push-rejected");
  assert.equal(r.autoFixable, false); // pushing semantics need caller intent
});

// ---------------------------------------------------------------------------
// Vercel specific
// ---------------------------------------------------------------------------

test("classifies: Vercel function exceeds size limit", () => {
  const log = "Error: Serverless Function 'api/big.func' size exceeds the maximum compressed limit of 50 MB";
  const r = topFailure(log);
  assert.ok(r);
  assert.equal(r.class, "vercel-function-too-large");
  assert.equal(r.autoFixable, false); // architectural review needed
});

// ---------------------------------------------------------------------------
// Multi-failure / ordering
// ---------------------------------------------------------------------------

test("classifyCIFailures: surfaces all classes, sorted by priority", () => {
  // OOM (99) + TypeScript error (95) + lint error (80) all in one log
  const log = [
    "src/index.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.",
    "5 problems (5 errors, 0 warnings)",
    "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
  ].join("\n");
  const all = classifyCIFailures(log);
  assert.ok(all.length >= 3);
  // OOM (priority 99) should come first
  assert.equal(all[0].class, "node-oom");
});

test("classifyCIFailures: each class de-duplicated to one finding", () => {
  // Many TypeScript errors → one finding for the class
  const log = Array.from({ length: 20 }, (_, i) =>
    `src/file${i}.ts(${i + 1},1): error TS2304: Cannot find name 'x'.`
  ).join("\n");
  const all = classifyCIFailures(log);
  const tsCount = all.filter((f) => f.class === "typescript-error").length;
  assert.equal(tsCount, 1, "should report TypeScript class exactly once even with many matches");
});

test("classifyCIFailures: evidence is truncated to 300 chars", () => {
  const long = "A".repeat(1000);
  const log = `Error: Cannot find action 'foo' ${long}`;
  const r = topFailure(log);
  assert.ok(r);
  assert.ok(r.evidence.length <= 300);
});

test("topFailure: returns null when nothing classified", () => {
  assert.equal(topFailure("everything is fine"), null);
});

test("topFailure: line number is 1-indexed and accurate", () => {
  const log = [
    "step 1: ok",
    "step 2: ok",
    "step 3: FATAL ERROR: JavaScript heap out of memory",
    "step 4: aborting",
  ].join("\n");
  const r = topFailure(log);
  assert.equal(r.lineNumber, 3);
});
