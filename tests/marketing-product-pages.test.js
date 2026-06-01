"use strict";

/**
 * Marketing product pages — static-source meta-tests.
 *
 * Covers the two public product pages under Wave 1 of the marketing-site
 * refresh:
 *   - website/app/triage/page.tsx
 *   - website/app/pipeline-trace/page.tsx
 *
 * Mirrors the convention from tests/triage-page.test.js (admin variant) —
 * we cannot execute the .tsx in node:test, so we lock the file's shape
 * to defend against silent regressions.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

const TRIAGE_PAGE = path.join(ROOT, "website/app/triage/page.tsx");
const TRIAGE_LAYOUT = path.join(ROOT, "website/app/triage/layout.tsx");
const PIPELINE_PAGE = path.join(ROOT, "website/app/pipeline-trace/page.tsx");
const PIPELINE_LAYOUT = path.join(ROOT, "website/app/pipeline-trace/layout.tsx");

function readSrc(p) {
  return fs.readFileSync(p, "utf8");
}

// =============================================================================
// /triage public page
// =============================================================================

test("triage marketing page: file exists", () => {
  assert.ok(fs.existsSync(TRIAGE_PAGE), `expected ${TRIAGE_PAGE}`);
});

test("triage marketing page: has H1 mentioning Triage", () => {
  const src = readSrc(TRIAGE_PAGE);
  // The H1 includes the gradient span "Triage"
  assert.match(src, /<h1[\s\S]*?Triage[\s\S]*?<\/h1>/);
});

test("triage marketing page: has CTA(s) linking to /scan", () => {
  const src = readSrc(TRIAGE_PAGE);
  // Link href="/scan" appears at least twice (hero CTA + final CTA)
  const matches = src.match(/href=["']\/scan["']/g) || [];
  assert.ok(matches.length >= 2, `expected ≥2 /scan links, got ${matches.length}`);
});

test("triage marketing page: has 'How it works' section heading", () => {
  const src = readSrc(TRIAGE_PAGE);
  assert.match(src, /id=["']how-it-works["']/);
  assert.match(src, /How it works/i);
});

test("triage marketing page: lists all 9 cascade rules", () => {
  const src = readSrc(TRIAGE_PAGE);
  assert.match(src, /CASCADE_RULES/);
  // The visible heading says "9 rules"
  assert.match(src, /9 rules/);
  // The rule array has nine entries numbered 1..9
  for (let i = 1; i <= 9; i++) {
    assert.match(src, new RegExp(`\\bn:\\s*${i}\\b`), `rule ${i} missing`);
  }
});

test("triage marketing page: mentions every verdict layer label", () => {
  const src = readSrc(TRIAGE_PAGE);
  for (const layer of ["SOURCE", "SERVER", "BROWSER", "BUILD", "MIXED", "UNKNOWN"]) {
    assert.match(src, new RegExp(`\\b${layer}\\b`), `verdict label ${layer} missing`);
  }
});

test("triage marketing page: has 'Honest limitations' section", () => {
  const src = readSrc(TRIAGE_PAGE);
  assert.match(src, /Honest limitations/i);
  // And actually says what triage does NOT do
  assert.match(src, /Heuristic, not provable/);
});

test("triage marketing page: has JSON-LD SoftwareApplication structured data", () => {
  const src = readSrc(TRIAGE_PAGE);
  assert.match(src, /application\/ld\+json/);
  assert.match(src, /"@type":\s*"SoftwareApplication"/);
  assert.match(src, /DeveloperApplication/);
  // JSX object literal — keys are bare identifiers, values are string literals.
  assert.match(src, /price:\s*"29"/);
});

test("triage marketing page: NO eslint-disable directives", () => {
  const src = readSrc(TRIAGE_PAGE);
  assert.doesNotMatch(src, /eslint-disable/);
});

test("triage marketing page: mobile-responsive — uses sm: / md: breakpoints", () => {
  const src = readSrc(TRIAGE_PAGE);
  assert.match(src, /\bsm:/);
  assert.match(src, /\bmd:/);
});

test("triage marketing page: imports shared Navbar + Footer", () => {
  const src = readSrc(TRIAGE_PAGE);
  assert.match(src, /import\s+Navbar\s+from\s+["'][^"']+\/components\/Navbar["']/);
  assert.match(src, /import\s+Footer\s+from\s+["'][^"']+\/components\/Footer["']/);
});

test("triage marketing page: gates HN/Product Hunt badge behind NEXT_PUBLIC_LAUNCH_HN env var", () => {
  const src = readSrc(TRIAGE_PAGE);
  assert.match(src, /NEXT_PUBLIC_LAUNCH_HN/);
});

test("triage layout: exports metadata with correct title/canonical", () => {
  const src = readSrc(TRIAGE_LAYOUT);
  assert.match(src, /export\s+const\s+metadata\s*:\s*Metadata/);
  assert.match(src, /title:[\s\S]{0,180}Triage/);
  assert.match(src, /canonical:\s*["']https:\/\/gatetest\.ai\/triage["']/);
  assert.match(src, /description:[\s\S]{0,400}9-rule cascade/);
});

// =============================================================================
// /pipeline-trace public page
// =============================================================================

test("pipeline-trace marketing page: file exists", () => {
  assert.ok(fs.existsSync(PIPELINE_PAGE), `expected ${PIPELINE_PAGE}`);
});

test("pipeline-trace marketing page: has H1 mentioning Pipeline Trace", () => {
  const src = readSrc(PIPELINE_PAGE);
  assert.match(src, /<h1[\s\S]*?Pipeline Trace[\s\S]*?<\/h1>/);
});

test("pipeline-trace marketing page: has CTA(s) linking to /scan", () => {
  const src = readSrc(PIPELINE_PAGE);
  const matches = src.match(/href=["']\/scan["']/g) || [];
  assert.ok(matches.length >= 2, `expected ≥2 /scan links, got ${matches.length}`);
});

test("pipeline-trace marketing page: has 'How it works' section heading", () => {
  const src = readSrc(PIPELINE_PAGE);
  assert.match(src, /id=["']how-it-works["']/);
  assert.match(src, /How it works/i);
});

test("pipeline-trace marketing page: lists all 10 cascade rules", () => {
  const src = readSrc(PIPELINE_PAGE);
  assert.match(src, /CASCADE_RULES/);
  // The visible heading says "10 rules"
  assert.match(src, /10 rules/);
  for (let i = 1; i <= 10; i++) {
    assert.match(src, new RegExp(`\\bn:\\s*${i}\\b`), `rule ${i} missing`);
  }
});

test("pipeline-trace marketing page: mentions every pipeline stage", () => {
  const src = readSrc(PIPELINE_PAGE);
  for (const stage of ["SOURCE", "CI", "DEPLOY", "LIVE", "EDGE"]) {
    assert.match(src, new RegExp(`\\b${stage}\\b`), `stage ${stage} missing`);
  }
});

test("pipeline-trace marketing page: has 'Honest limitations' section", () => {
  const src = readSrc(PIPELINE_PAGE);
  assert.match(src, /Honest limitations/i);
  // Specifically the GitHub-API limitation
  assert.match(src, /Reads GitHub APIs/);
});

test("pipeline-trace marketing page: has JSON-LD SoftwareApplication structured data", () => {
  const src = readSrc(PIPELINE_PAGE);
  assert.match(src, /application\/ld\+json/);
  assert.match(src, /"@type":\s*"SoftwareApplication"/);
  assert.match(src, /DeveloperApplication/);
  assert.match(src, /price:\s*"29"/);
});

test("pipeline-trace marketing page: NO eslint-disable directives", () => {
  const src = readSrc(PIPELINE_PAGE);
  assert.doesNotMatch(src, /eslint-disable/);
});

test("pipeline-trace marketing page: mobile-responsive — uses sm: / md: breakpoints", () => {
  const src = readSrc(PIPELINE_PAGE);
  assert.match(src, /\bsm:/);
  assert.match(src, /\bmd:/);
  // Pipeline visualisation explicitly stacks on mobile, horizontal on md
  assert.match(src, /flex-col\s+md:flex-row/);
});

test("pipeline-trace marketing page: imports shared Navbar + Footer", () => {
  const src = readSrc(PIPELINE_PAGE);
  assert.match(src, /import\s+Navbar\s+from\s+["'][^"']+\/components\/Navbar["']/);
  assert.match(src, /import\s+Footer\s+from\s+["'][^"']+\/components\/Footer["']/);
});

test("pipeline-trace marketing page: gates HN/Product Hunt badge behind NEXT_PUBLIC_LAUNCH_HN env var", () => {
  const src = readSrc(PIPELINE_PAGE);
  assert.match(src, /NEXT_PUBLIC_LAUNCH_HN/);
});

test("pipeline-trace layout: exports metadata with correct title/canonical", () => {
  const src = readSrc(PIPELINE_LAYOUT);
  assert.match(src, /export\s+const\s+metadata\s*:\s*Metadata/);
  assert.match(src, /title:[\s\S]{0,200}Pipeline Trace/);
  assert.match(src, /canonical:\s*["']https:\/\/gatetest\.ai\/pipeline-trace["']/);
  assert.match(src, /description:[\s\S]{0,400}10-rule cascade/);
});

// =============================================================================
// Cross-page sanity — both pages reference the matching correlator file
// =============================================================================

test("triage marketing page: references the correlator source path", () => {
  const src = readSrc(TRIAGE_PAGE);
  assert.match(src, /website\/app\/lib\/triage\/correlator\.js/);
});

test("pipeline-trace marketing page: references the correlator source path", () => {
  const src = readSrc(PIPELINE_PAGE);
  assert.match(src, /website\/app\/lib\/pipeline-trace\/correlator\.js/);
});
