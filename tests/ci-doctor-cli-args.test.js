"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseDoctorArgs, DEFAULT_WORKFLOW_PATHS } = require("../website/app/lib/ci-doctor/cli-args.js");

test("parseDoctorArgs: minimal valid run-by-id", () => {
  const a = parseDoctorArgs(["--owner", "crclabs-hq", "--repo", "GateTest", "--run", "12345"]);
  assert.equal(a.errors.length, 0);
  assert.equal(a.owner, "crclabs-hq");
  assert.equal(a.repo, "GateTest");
  assert.equal(a.runId, "12345");
  assert.equal(a.apply, false);
  assert.equal(a.json, false);
  assert.deepEqual(a.workflowPaths, DEFAULT_WORKFLOW_PATHS);
});

test("parseDoctorArgs: minimal valid run-by-pr", () => {
  const a = parseDoctorArgs(["--owner", "x", "--repo", "y", "--pr", "42"]);
  assert.equal(a.errors.length, 0);
  assert.equal(a.prNumber, 42);
});

test("parseDoctorArgs: --pr rejects non-positive integer", () => {
  const a = parseDoctorArgs(["--owner", "x", "--repo", "y", "--pr", "abc"]);
  assert.ok(a.errors.some((e) => e.includes("not a positive integer")));
});

test("parseDoctorArgs: missing owner / repo flagged", () => {
  const a = parseDoctorArgs(["--run", "1"]);
  assert.ok(a.errors.some((e) => e.includes("--owner")));
  assert.ok(a.errors.some((e) => e.includes("--repo")));
});

test("parseDoctorArgs: requires --pr or --run", () => {
  const a = parseDoctorArgs(["--owner", "x", "--repo", "y"]);
  assert.ok(a.errors.some((e) => e.includes("--pr or --run")));
});

test("parseDoctorArgs: rejects both --pr AND --run", () => {
  const a = parseDoctorArgs(["--owner", "x", "--repo", "y", "--pr", "1", "--run", "2"]);
  assert.ok(a.errors.some((e) => e.includes("not both")));
});

test("parseDoctorArgs: --apply / --autoreview / --json flags", () => {
  const a = parseDoctorArgs(["--owner", "x", "--repo", "y", "--run", "1", "--apply", "--autoreview", "--json"]);
  assert.equal(a.errors.length, 0);
  assert.equal(a.apply, true);
  assert.equal(a.autoApplyReviewRequired, true);
  assert.equal(a.json, true);
});

test("parseDoctorArgs: --workflow accepts CSV", () => {
  const a = parseDoctorArgs([
    "--owner", "x", "--repo", "y", "--run", "1",
    "--workflow", ".github/workflows/ci.yml,.github/workflows/release.yml",
  ]);
  assert.deepEqual(a.workflowPaths, [
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
  ]);
});

test("parseDoctorArgs: --workspace overrides default", () => {
  const a = parseDoctorArgs(["--owner", "x", "--repo", "y", "--run", "1", "--workspace", "/tmp/repo"]);
  assert.equal(a.workspaceRoot, "/tmp/repo");
});

test("parseDoctorArgs: --token captured", () => {
  const a = parseDoctorArgs(["--owner", "x", "--repo", "y", "--run", "1", "--token", "abc123"]);
  assert.equal(a.token, "abc123");
});

test("parseDoctorArgs: --help short-circuits validation", () => {
  const a = parseDoctorArgs(["--help"]);
  assert.equal(a.help, true);
  assert.equal(a.errors.length, 0);
});

test("parseDoctorArgs: -h short-circuits validation", () => {
  const a = parseDoctorArgs(["-h"]);
  assert.equal(a.help, true);
});

test("parseDoctorArgs: unknown flag is reported as error", () => {
  const a = parseDoctorArgs(["--owner", "x", "--repo", "y", "--run", "1", "--whatever"]);
  assert.ok(a.errors.some((e) => e.includes("unknown flag")));
});

test("parseDoctorArgs: empty argv → reports all required flags missing", () => {
  const a = parseDoctorArgs([]);
  assert.ok(a.errors.length >= 3);
});
