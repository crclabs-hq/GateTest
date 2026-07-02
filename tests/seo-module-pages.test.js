"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// We can't import the .ts file directly under node:test, so we parse the
// modules-data.ts source as the source of truth for module count.
const MODULES_DATA_PATH = path.resolve(__dirname, "..", "website", "app", "components", "howitworks", "modules-data.ts");
const SLUGS_PATH = path.resolve(__dirname, "..", "website", "app", "components", "howitworks", "module-slugs.ts");
const SITEMAP_PATH = path.resolve(__dirname, "..", "website", "app", "sitemap.ts");
const MODULE_PAGE_PATH = path.resolve(__dirname, "..", "website", "app", "modules", "[slug]", "page.tsx");
const MODULE_INDEX_PATH = path.resolve(__dirname, "..", "website", "app", "modules", "page.tsx");

function countModulesInDataFile() {
  const src = fs.readFileSync(MODULES_DATA_PATH, "utf8");
  // Count occurrences of `name: "...`. Each module entry has exactly one.
  const matches = src.match(/^\s+\{\s+name:\s+"/gm);
  return matches ? matches.length : 0;
}

test("modules-data.ts: holds at least 100 module entries", () => {
  const count = countModulesInDataFile();
  assert.ok(count >= 100, `expected >= 100 modules, got ${count}`);
});

test("module-slugs.ts: exports the right public surface", () => {
  const src = fs.readFileSync(SLUGS_PATH, "utf8");
  // Public functions consumed by the dynamic route + index page
  assert.match(src, /export function getAllModuleSlugs/);
  assert.match(src, /export function getModuleBySlug/);
  assert.match(src, /export function getRelatedModules/);
  assert.match(src, /export function getTotalModuleCount/);
  assert.match(src, /export function getModulesByCategory/);
  // Public type imported by the page
  assert.match(src, /export interface ResolvedModule/);
  // Internal helpers — should NOT be exported
  assert.doesNotMatch(src, /export function moduleNameToSlug/);
  assert.doesNotMatch(src, /export function buildModuleIndex/);
});

test("modules/[slug]/page.tsx: exports generateStaticParams + generateMetadata", () => {
  const src = fs.readFileSync(MODULE_PAGE_PATH, "utf8");
  assert.match(src, /export async function generateStaticParams/);
  assert.match(src, /export async function generateMetadata/);
});

test("modules/[slug]/page.tsx: emits FAQPage + SoftwareApplication structured data", () => {
  const src = fs.readFileSync(MODULE_PAGE_PATH, "utf8");
  assert.match(src, /@type":\s*"FAQPage"/);
  assert.match(src, /@type":\s*"SoftwareApplication"/);
});

test("modules/[slug]/page.tsx: produces canonical URL", () => {
  const src = fs.readFileSync(MODULE_PAGE_PATH, "utf8");
  // We compute the canonical as a const above the metadata block, so the
  // page is canonical-URL aware whether the literal string or a variable
  // reference appears here.
  assert.match(src, /https:\/\/gatetest\.ai\/modules\/\$\{mod\.slug\}/);
  assert.match(src, /alternates:\s*\{\s*canonical/);
});

test("modules/page.tsx: lists all modules + CollectionPage structured data", () => {
  const src = fs.readFileSync(MODULE_INDEX_PATH, "utf8");
  assert.match(src, /getModulesByCategory/);
  assert.match(src, /@type":\s*"CollectionPage"/);
});

test("sitemap.ts: includes /modules + programmatic module pages + all compare pages", () => {
  const src = fs.readFileSync(SITEMAP_PATH, "utf8");
  // The index page URL appears in the file
  assert.ok(src.includes("/modules"), "sitemap must reference /modules index");
  // Module slugs come from getAllModuleSlugs()
  assert.match(src, /getAllModuleSlugs\(\)/);
  // Compare pages that previously existed but weren't in sitemap
  assert.match(src, /semgrep/);
  assert.match(src, /codeql/);
  assert.match(src, /nodejs/);
});

test("sitemap.ts: every comparison slug we ship is referenced by the sitemap", () => {
  const compareDir = path.resolve(__dirname, "..", "website", "app", "compare");
  const dirs = fs.readdirSync(compareDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  const sitemap = fs.readFileSync(SITEMAP_PATH, "utf8");
  for (const dir of dirs) {
    // The sitemap builds compare URLs from a comparisonSlugs array — slug
    // appears as a quoted literal there.
    assert.match(
      sitemap,
      new RegExp(`["']${dir}["']`),
      `compare/${dir} missing from sitemap comparisonSlugs array`
    );
  }
});

test("module slug conversion: kebab-cases camelCase correctly", () => {
  // Re-implement the slug logic in JS to verify shape (since we can't import TS directly)
  function toSlug(name) {
    return name
      .replace(/([a-z])([A-Z])/g, "$1-$2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }
  assert.equal(toSlug("moneyFloat"), "money-float");
  assert.equal(toSlug("tlsSecurity"), "tls-security");
  assert.equal(toSlug("crossFileTaint"), "cross-file-taint");
  assert.equal(toSlug("ssrf"), "ssrf");
  assert.equal(toSlug("aiReview"), "ai-review");
});
