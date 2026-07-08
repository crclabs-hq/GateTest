"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PAGE_PATH = path.join(ROOT, "website/app/admin/pipeline-trace/page.tsx");
const ADMIN_PANEL_PATH = path.join(ROOT, "website/app/admin/AdminPanel.tsx");

// Static-source assertions only — same approach as tests/triage-page.test.js.

test("pipeline-trace page: file exists", () => {
  assert.ok(fs.existsSync(PAGE_PATH), `expected page at ${PAGE_PATH}`);
});

test('pipeline-trace page: starts with "use client"', () => {
  const src = fs.readFileSync(PAGE_PATH, "utf8");
  // split on \r?\n — git checks out CRLF on Windows and a trailing \r broke the $ anchor
  const firstLine = src.split(/\r?\n/).find((l) => l.trim().length > 0);
  assert.match(String(firstLine), /^"use client";?$/);
});

test("pipeline-trace page: imports useState from react", () => {
  const src = fs.readFileSync(PAGE_PATH, "utf8");
  assert.match(src, /import\s*\{[^}]*\buseState\b[^}]*\}\s*from\s*["']react["']/);
});

test("pipeline-trace page: POSTs to /api/admin/triage/pipeline", () => {
  const src = fs.readFileSync(PAGE_PATH, "utf8");
  assert.match(src, /["']\/api\/admin\/triage\/pipeline["']/);
  assert.match(src, /method:\s*["']POST["']/);
});

test("pipeline-trace page: renders all four stage names (source, ci, deploy, live)", () => {
  const src = fs.readFileSync(PAGE_PATH, "utf8");
  // STAGE_ORDER literal contains all four
  assert.match(src, /STAGE_ORDER[\s\S]{0,80}["']source["'][\s\S]{0,80}["']ci["'][\s\S]{0,80}["']deploy["'][\s\S]{0,80}["']live["']/);
  // And the StageName type union
  assert.match(src, /StageName\s*=\s*["']source["']\s*\|\s*["']ci["']\s*\|\s*["']deploy["']\s*\|\s*["']live["']/);
});

test("pipeline-trace page: renders verdict headline, rationale, recommendedNext, divergencePoint", () => {
  const src = fs.readFileSync(PAGE_PATH, "utf8");
  assert.match(src, /verdict\.headline/);
  assert.match(src, /verdict\.rationale/);
  assert.match(src, /verdict\.recommendedNext/);
  assert.match(src, /verdict\.divergencePoint/);
});

test("pipeline-trace page: has both Copy all and Copy markdown buttons with handlers", () => {
  const src = fs.readFileSync(PAGE_PATH, "utf8");
  assert.match(src, /Copy all/);
  assert.match(src, /Copy markdown/);
  assert.match(src, /handleCopyAll/);
  assert.match(src, /handleCopyMarkdown/);
  assert.match(src, /navigator\.clipboard\.writeText/);
});

test("pipeline-trace page: humanAge helper exists (extracted to ./formatters)", () => {
  const formattersPath = path.join(
    ROOT,
    "website/app/admin/pipeline-trace/formatters.ts",
  );
  const src = fs.readFileSync(formattersPath, "utf8");
  assert.match(src, /export\s+function\s+humanAge\s*\(/);
  // The expected branches: just now / min / hr / days
  assert.match(src, /just now/);
  assert.match(src, /min/);
  assert.match(src, /hr/);
  assert.match(src, /days/);
});

test("pipeline-trace page: mobile-responsive — uses sm: / md: Tailwind breakpoints", () => {
  const src = fs.readFileSync(PAGE_PATH, "utf8");
  assert.match(src, /\bsm:/);
  assert.match(src, /\bmd:/);
  // Pipeline visualisation stacks on mobile, horizontal on md
  assert.match(src, /flex-col\s+md:flex-row/);
});

test("pipeline-trace page: NO eslint-disable directives in the file", () => {
  const src = fs.readFileSync(PAGE_PATH, "utf8");
  assert.doesNotMatch(src, /eslint-disable/);
});

test("pipeline-trace page: handles 401 explicitly with auth message + /admin link", () => {
  const src = fs.readFileSync(PAGE_PATH, "utf8");
  assert.match(src, /status\s*===\s*401/);
  assert.match(src, /Not authenticated/i);
  assert.match(src, /\/admin/);
});

test("pipeline-trace page: disables submit while loading", () => {
  const src = fs.readFileSync(PAGE_PATH, "utf8");
  assert.match(src, /disabled=\{loading/);
  // In-flight label
  assert.match(src, /Tracing/);
});

test("pipeline-trace page: light theme — bg-gray-50 wrapper, bg-white shadow-sm cards, no bg-black main", () => {
  const src = fs.readFileSync(PAGE_PATH, "utf8");
  assert.match(src, /bg-gray-50/);
  assert.doesNotMatch(src, /<main[^>]*bg-black/);
  assert.match(src, /bg-white\s+shadow-sm/);
});

test("pipeline-trace page: per-stage details accordion (expandedDetails state)", () => {
  const src = fs.readFileSync(PAGE_PATH, "utf8");
  assert.match(src, /expandedDetails/);
  assert.match(src, /setExpandedDetails/);
  // The accordion toggle reads from the state
  assert.match(src, /expandedDetails\[/);
});

test("pipeline-trace page: uses the prescribed layer colour scheme (verdict badges)", () => {
  const src = fs.readFileSync(PAGE_PATH, "utf8");
  // Required layer badge classes per the spec
  assert.match(src, /bg-blue-100[^"']*text-blue-800/);
  assert.match(src, /bg-purple-100[^"']*text-purple-800/);
  assert.match(src, /bg-orange-100[^"']*text-orange-800/);
  assert.match(src, /bg-amber-100[^"']*text-amber-800/);
  assert.match(src, /bg-pink-100[^"']*text-pink-800/);
  assert.match(src, /bg-emerald-100[^"']*text-emerald-800/);
});

test("pipeline-trace page: file under 600 lines", () => {
  const src = fs.readFileSync(PAGE_PATH, "utf8");
  const lineCount = src.split("\n").length;
  assert.ok(lineCount < 600, `expected <600 lines, got ${lineCount}`);
});

test("AdminPanel: has a Pipeline nav link to /admin/pipeline-trace", () => {
  const src = fs.readFileSync(ADMIN_PANEL_PATH, "utf8");
  assert.match(src, /\/admin\/pipeline-trace/);
  assert.match(src, /Pipeline/);
});
