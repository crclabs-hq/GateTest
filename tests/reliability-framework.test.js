"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  validateManifest,
  normaliseManifest,
  compareToExpected,
  VALID_CATEGORIES,
  VALID_TIERS,
} = require("../website/app/lib/reliability/manifest.js");

const {
  runCase,
  runSuite,
  tallyFindings,
  findingsSignature,
} = require("../website/app/lib/reliability/runner.js");

const {
  detectDrift,
  renderDriftReport,
  median,
  percentile,
} = require("../website/app/lib/reliability/drift-detector.js");

// ---------------------------------------------------------------------------
// validateManifest
// ---------------------------------------------------------------------------

test("validateManifest: minimal valid code manifest", () => {
  const v = validateManifest({
    name: "foo",
    category: "known-bad",
    tier: "full",
  });
  assert.equal(v.ok, true);
  assert.equal(v.errors.length, 0);
});

test("validateManifest: minimal valid url manifest", () => {
  const v = validateManifest({
    name: "site-1",
    category: "url-known-good",
    tier: "quick",
    url: "https://example.com",
  });
  assert.equal(v.ok, true);
});

test("validateManifest: url category without url field fails", () => {
  const v = validateManifest({
    name: "site-1",
    category: "url-known-good",
    tier: "quick",
  });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("url:")));
});

test("validateManifest: url with non-http(s) scheme fails", () => {
  const v = validateManifest({
    name: "x",
    category: "url-known-good",
    tier: "quick",
    url: "ftp://example.com",
  });
  assert.equal(v.ok, false);
});

test("validateManifest: bad category rejected", () => {
  const v = validateManifest({
    name: "foo",
    category: "made-up",
    tier: "full",
  });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.startsWith("category:")));
});

test("validateManifest: bad tier rejected", () => {
  const v = validateManifest({
    name: "foo",
    category: "known-bad",
    tier: "ultraplus",
  });
  assert.equal(v.ok, false);
});

test("validateManifest: name with invalid chars rejected", () => {
  const v = validateManifest({
    name: "foo bar/baz",
    category: "known-bad",
    tier: "full",
  });
  assert.equal(v.ok, false);
});

test("validateManifest: atLeast > atMost rejected", () => {
  const v = validateManifest({
    name: "x",
    category: "known-bad",
    tier: "full",
    expected: { errors: { mod: { atLeast: 5, atMost: 2 } } },
  });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("atLeast (5) > atMost (2)")));
});

test("validateManifest: negative atLeast rejected", () => {
  const v = validateManifest({
    name: "x",
    category: "known-bad",
    tier: "full",
    expected: { errors: { mod: { atLeast: -1 } } },
  });
  assert.equal(v.ok, false);
});

test("validateManifest: budget overrides typed", () => {
  const v = validateManifest({
    name: "x",
    category: "known-bad",
    tier: "full",
    budgets: { maxDurationMs: -1, deterministic: "yes" },
  });
  assert.equal(v.ok, false);
});

test("validateManifest: labels must be array of strings", () => {
  const v = validateManifest({
    name: "x", category: "known-bad", tier: "full",
    labels: ["ok", 5],
  });
  assert.equal(v.ok, false);
});

test("VALID_CATEGORIES + VALID_TIERS look correct", () => {
  assert.ok(VALID_CATEGORIES.has("known-bad"));
  assert.ok(VALID_CATEGORIES.has("url-known-good"));
  assert.ok(VALID_TIERS.has("nuclear"));
});

// ---------------------------------------------------------------------------
// normaliseManifest
// ---------------------------------------------------------------------------

test("normaliseManifest: fills budget defaults", () => {
  const n = normaliseManifest({
    name: "x", category: "known-bad", tier: "full",
  });
  assert.equal(n.budgets.maxDurationMs, 60000);
  assert.equal(n.budgets.maxMemoryMb, 2048);
  assert.equal(n.budgets.deterministic, true);
});

test("normaliseManifest: derives target from url-* category", () => {
  const n = normaliseManifest({
    name: "x", category: "url-known-good", tier: "quick",
    url: "https://a.com",
  });
  assert.equal(n.target, "url");
  assert.equal(n.url, "https://a.com");
});

// ---------------------------------------------------------------------------
// compareToExpected
// ---------------------------------------------------------------------------

test("compareToExpected: known-good with 0 errors → pass", () => {
  const m = normaliseManifest({ name: "x", category: "known-good", tier: "quick" });
  const issues = compareToExpected(m, { findingsByModule: {}, totals: { errors: 0, warnings: 0 }, durationMs: 100 });
  assert.deepEqual(issues, []);
});

test("compareToExpected: known-good with errors → fail", () => {
  const m = normaliseManifest({ name: "x", category: "known-good", tier: "quick" });
  const issues = compareToExpected(m, { findingsByModule: {}, totals: { errors: 2, warnings: 0 }, durationMs: 100 });
  assert.ok(issues.some((i) => i.includes("known-good")));
});

test("compareToExpected: known-bad missing required errors → fail", () => {
  const m = normaliseManifest({
    name: "x", category: "known-bad", tier: "full",
    expected: { errors: { ssrf: { atLeast: 1 } }, totalErrorsAtLeast: 1 },
  });
  const issues = compareToExpected(m, { findingsByModule: {}, totals: { errors: 0, warnings: 0 }, durationMs: 100 });
  assert.ok(issues.some((i) => i.includes("ssrf.errors 0 < atLeast 1")));
});

test("compareToExpected: budget overrun flagged", () => {
  const m = normaliseManifest({
    name: "x", category: "known-bad", tier: "full",
    budgets: { maxDurationMs: 100 },
  });
  const issues = compareToExpected(m, { findingsByModule: {}, totals: { errors: 0, warnings: 0 }, durationMs: 5000 });
  assert.ok(issues.some((i) => i.includes("duration")));
});

// ---------------------------------------------------------------------------
// tallyFindings + findingsSignature
// ---------------------------------------------------------------------------

test("tallyFindings: groups by module + severity", () => {
  const r = tallyFindings([
    { module: "ssrf", severity: "error" },
    { module: "ssrf", severity: "warning" },
    { module: "lint", severity: "error" },
  ]);
  assert.equal(r.totals.errors, 2);
  assert.equal(r.totals.warnings, 1);
  assert.equal(r.findingsByModule.ssrf.errors, 1);
  assert.equal(r.findingsByModule.ssrf.warnings, 1);
  assert.equal(r.findingsByModule.lint.errors, 1);
});

test("findingsSignature: deterministic across reordering", () => {
  const a = [
    { module: "a", severity: "error", file: "f.js", line: 1, rule: "r1", message: "m" },
    { module: "b", severity: "warning", file: "g.js", line: 2, rule: "r2", message: "n" },
  ];
  const b = [a[1], a[0]];
  assert.equal(findingsSignature(a), findingsSignature(b));
});

// ---------------------------------------------------------------------------
// runCase
// ---------------------------------------------------------------------------

test("runCase: invalid manifest → passed:false with error", async () => {
  const r = await runCase({
    manifest: { name: "x" },
    scanner: { scan: async () => ({ findings: [] }) },
  });
  assert.equal(r.passed, false);
  assert.equal(r.error, "invalid-manifest");
});

test("runCase: known-good with 0 findings → passes", async () => {
  const r = await runCase({
    manifest: { name: "x", category: "known-good", tier: "quick" },
    scanner: { scan: async () => ({ findings: [] }) },
  });
  assert.equal(r.passed, true);
  assert.equal(r.totals.errors, 0);
});

test("runCase: known-bad catching expected finding → passes", async () => {
  const r = await runCase({
    manifest: {
      name: "x", category: "known-bad", tier: "full",
      expected: { errors: { ssrf: { atLeast: 1 } }, totalErrorsAtLeast: 1 },
    },
    scanner: {
      scan: async () => ({
        findings: [{ module: "ssrf", severity: "error", file: "h.js", line: 10 }],
      }),
    },
  });
  assert.equal(r.passed, true);
});

test("runCase: scanner.scan throwing → recorded as scan-failed", async () => {
  const r = await runCase({
    manifest: { name: "x", category: "known-good", tier: "quick" },
    scanner: { scan: async () => { throw new Error("boom"); } },
  });
  assert.equal(r.passed, false);
  assert.equal(r.error, "scan-failed");
});

test("runCase: deterministic repeat detects non-determinism", async () => {
  let i = 0;
  const r = await runCase({
    manifest: {
      name: "x", category: "known-good", tier: "quick",
      budgets: { deterministic: true, maxDurationMs: 5000 },
    },
    scanner: {
      scan: async () => {
        i += 1;
        return {
          findings: i === 1
            ? []
            : [{ module: "lint", severity: "warning", file: "f.js", line: 1 }],
        };
      },
    },
    repeatForDeterminism: true,
  });
  assert.equal(r.passed, false);
  assert.equal(r.deterministic, false);
  assert.ok(r.issues.some((it) => it.includes("non-deterministic")));
});

// ---------------------------------------------------------------------------
// runSuite
// ---------------------------------------------------------------------------

test("runSuite: aggregates pass/fail correctly", async () => {
  const cases = [
    { name: "a", category: "known-good", tier: "quick" },
    { name: "b", category: "known-bad", tier: "full",
      expected: { errors: { ssrf: { atLeast: 1 } }, totalErrorsAtLeast: 1 } },
  ];
  const scanner = {
    scan: async ({ manifest }) => {
      if (manifest.name === "a") return { findings: [] };
      return { findings: [{ module: "ssrf", severity: "error", file: "f", line: 1 }] };
    },
  };
  const suite = await runSuite({ cases, scanner });
  assert.equal(suite.total, 2);
  assert.equal(suite.passed, 2);
  assert.equal(suite.passRate, 1);
});

test("runSuite: one failing case does not block the others", async () => {
  const cases = [
    { name: "x", category: "known-good", tier: "quick" },
    { name: "y", category: "known-good", tier: "quick" },
  ];
  const scanner = {
    scan: async ({ manifest }) => {
      if (manifest.name === "x") throw new Error("scanner broke");
      return { findings: [] };
    },
  };
  const suite = await runSuite({ cases, scanner });
  assert.equal(suite.total, 2);
  assert.equal(suite.passed, 1);
});

// ---------------------------------------------------------------------------
// detectDrift
// ---------------------------------------------------------------------------

test("detectDrift: regression detection", () => {
  const baseline = { results: [
    { name: "a", passed: true, issues: [], totals: { errors: 0, warnings: 0 }, durationMs: 100 },
  ] };
  const latest = { results: [
    { name: "a", passed: false, issues: ["new failure"], totals: { errors: 1, warnings: 0 }, durationMs: 150 },
  ] };
  const drift = detectDrift({ baseline, latest });
  assert.equal(drift.regressions.length, 1);
  assert.equal(drift.regressions[0].name, "a");
});

test("detectDrift: fix detection", () => {
  const baseline = { results: [
    { name: "a", passed: false, issues: ["was failing"], totals: { errors: 1, warnings: 0 }, durationMs: 100 },
  ] };
  const latest = { results: [
    { name: "a", passed: true, issues: [], totals: { errors: 0, warnings: 0 }, durationMs: 100 },
  ] };
  const drift = detectDrift({ baseline, latest });
  assert.equal(drift.fixes.length, 1);
});

test("detectDrift: new and removed cases tracked", () => {
  const baseline = { results: [
    { name: "a", passed: true, issues: [], totals: { errors: 0, warnings: 0 }, durationMs: 100 },
    { name: "b", passed: true, issues: [], totals: { errors: 0, warnings: 0 }, durationMs: 100 },
  ] };
  const latest = { results: [
    { name: "a", passed: true, issues: [], totals: { errors: 0, warnings: 0 }, durationMs: 100 },
    { name: "c", passed: true, issues: [], totals: { errors: 0, warnings: 0 }, durationMs: 100 },
  ] };
  const drift = detectDrift({ baseline, latest });
  assert.deepEqual(drift.newCases, ["c"]);
  assert.deepEqual(drift.removedCases, ["b"]);
});

test("detectDrift: findings delta computed", () => {
  const baseline = { results: [{ name: "a", passed: true, issues: [], totals: { errors: 1, warnings: 2 }, durationMs: 100 }] };
  const latest = { results: [{ name: "a", passed: true, issues: [], totals: { errors: 3, warnings: 1 }, durationMs: 100 }] };
  const drift = detectDrift({ baseline, latest });
  assert.equal(drift.summary.findingsDelta.errors, 2);
  assert.equal(drift.summary.findingsDelta.warnings, -1);
});

test("detectDrift: empty inputs handled gracefully", () => {
  const drift = detectDrift({ baseline: null, latest: null });
  assert.equal(drift.summary.casesAdded, 0);
  assert.equal(drift.summary.casesRemoved, 0);
});

test("renderDriftReport: regressions surfaced prominently", () => {
  const drift = detectDrift({
    baseline: { results: [{ name: "a", passed: true, issues: [], totals: { errors: 0, warnings: 0 }, durationMs: 100 }] },
    latest:   { results: [{ name: "a", passed: false, issues: ["module x stopped firing"], totals: { errors: 0, warnings: 0 }, durationMs: 100 }] },
  });
  const md = renderDriftReport(drift);
  assert.match(md, /Regressions \(1\)/);
  assert.match(md, /module x stopped firing/);
});

// ---------------------------------------------------------------------------
// stats helpers
// ---------------------------------------------------------------------------

test("median: handles even / odd lengths", () => {
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), 0);
});

test("percentile: p95", () => {
  const arr = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.ok(percentile(arr, 95) >= 95);
});

// ---------------------------------------------------------------------------
// Seed corpus sanity — every manifest in reliability-corpus/ is valid
// ---------------------------------------------------------------------------

test("seed corpus: every manifest.json validates", () => {
  // eslint-disable-next-line global-require
  const fs = require("fs");
  // eslint-disable-next-line global-require
  const path = require("path");
  const root = path.join(__dirname, "..", "reliability-corpus");

  function walk(dir, out) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (e.name === "manifest.json") out.push(p);
    }
  }
  const manifests = [];
  if (fs.existsSync(root)) walk(root, manifests);
  assert.ok(manifests.length > 0, "seed corpus has at least one manifest");

  for (const file of manifests) {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const v = validateManifest(data);
    assert.equal(v.ok, true, `manifest invalid: ${file}\n${v.errors.join("\n")}`);
  }
});
