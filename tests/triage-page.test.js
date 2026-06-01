"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PAGE_PATH = path.join(ROOT, "website/app/admin/triage/page.tsx");

// Static-source assertions only — same approach as
// tests/hn-launch-dashboard-api.test.js. We can't execute the .tsx
// in node:test, so we lock the file's shape.

test("triage page: file exists", () => {
  assert.ok(fs.existsSync(PAGE_PATH), `expected page at ${PAGE_PATH}`);
});

test('triage page: starts with "use client"', () => {
  const src = fs.readFileSync(PAGE_PATH, "utf8");
  // First non-empty line should be the "use client" directive
  const firstLine = src.split("\n").find((l) => l.trim().length > 0);
  assert.match(String(firstLine), /^"use client";?$/);
});

test("triage page: imports useState from react", () => {
  const src = fs.readFileSync(PAGE_PATH, "utf8");
  assert.match(src, /import\s*\{[^}]*\buseState\b[^}]*\}\s*from\s*["']react["']/);
});

test("triage page: POSTs to /api/admin/triage", () => {
  const src = fs.readFileSync(PAGE_PATH, "utf8");
  assert.match(src, /["']\/api\/admin\/triage["']/);
  assert.match(src, /method:\s*["']POST["']/);
});

test("triage page: renders all three layer sections (source, server, browser)", () => {
  const src = fs.readFileSync(PAGE_PATH, "utf8");
  // The grid iterates over the literal array ["source", "server", "browser"]
  assert.match(src, /["']source["']/);
  assert.match(src, /["']server["']/);
  assert.match(src, /["']browser["']/);
  // And the typed shape declares all three under layers.{source,server,browser}
  assert.match(src, /layers:\s*\{[\s\S]*source:[\s\S]*server:[\s\S]*browser:/);
});

test("triage page: renders verdict headline, rationale, and recommendedNext", () => {
  const src = fs.readFileSync(PAGE_PATH, "utf8");
  assert.match(src, /verdict\.headline/);
  assert.match(src, /verdict\.rationale/);
  assert.match(src, /verdict\.recommendedNext/);
});

test("triage page: has a Copy markdown button using the clipboard API", () => {
  const src = fs.readFileSync(PAGE_PATH, "utf8");
  assert.match(src, /Copy markdown/);
  assert.match(src, /navigator\.clipboard\.writeText/);
  // Has a copy handler
  assert.match(src, /handleCopy/);
});

test("triage page: mobile-responsive — uses sm: / md: Tailwind breakpoints", () => {
  const src = fs.readFileSync(PAGE_PATH, "utf8");
  assert.match(src, /\bsm:/);
  assert.match(src, /\bmd:/);
  // Specifically: the layer grid stacks on mobile, three-col on md
  assert.match(src, /grid-cols-1[^"']*md:grid-cols-3/);
});

test("triage page: NO eslint-disable directives in the file", () => {
  const src = fs.readFileSync(PAGE_PATH, "utf8");
  assert.doesNotMatch(src, /eslint-disable/);
});

test("triage page: handles the 401 case explicitly with an auth message", () => {
  const src = fs.readFileSync(PAGE_PATH, "utf8");
  assert.match(src, /status\s*===\s*401/);
  assert.match(src, /Not authenticated/i);
  assert.match(src, /\/admin/);
});

test("triage page: disables the submit button while loading", () => {
  const src = fs.readFileSync(PAGE_PATH, "utf8");
  // disabled={loading || ...} on the submit button
  assert.match(src, /disabled=\{loading/);
  // And the in-flight label
  assert.match(src, /Triaging/);
});

test("triage page: posts repoUrl + liveUrl in JSON body, serverUrl optional", () => {
  const src = fs.readFileSync(PAGE_PATH, "utf8");
  assert.match(src, /repoUrl/);
  assert.match(src, /liveUrl/);
  assert.match(src, /serverUrl/);
  assert.match(src, /JSON\.stringify\(/);
  // Content-Type header
  assert.match(src, /["']Content-Type["']\s*:\s*["']application\/json["']/);
});

test("triage page: uses the prescribed layer colour scheme (badges)", () => {
  const src = fs.readFileSync(PAGE_PATH, "utf8");
  // At least the source / server / browser badge classes must appear
  assert.match(src, /bg-blue-100[^"']*text-blue-800/);
  assert.match(src, /bg-red-100[^"']*text-red-800/);
  assert.match(src, /bg-amber-100[^"']*text-amber-800/);
});

test("triage page: file under 400 lines", () => {
  const src = fs.readFileSync(PAGE_PATH, "utf8");
  const lineCount = src.split("\n").length;
  assert.ok(lineCount < 400, `expected <400 lines, got ${lineCount}`);
});
