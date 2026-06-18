"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const CATALOG_PATH = path.resolve(__dirname, "..", "website", "app", "find", "cwe-catalog.ts");
const CWE_PAGE_PATH = path.resolve(__dirname, "..", "website", "app", "find", "[slug]", "page.tsx");
const CWE_INDEX_PATH = path.resolve(__dirname, "..", "website", "app", "find", "page.tsx");
const SITEMAP_PATH = path.resolve(__dirname, "..", "website", "app", "sitemap.ts");

const { CWE_SLUGS } = require("../website/app/lib/seo/all-urls.js");

// Parse the CWE catalogue to surface ids + slugs without compiling TS.
function readCweEntries() {
  const src = fs.readFileSync(CATALOG_PATH, "utf8");
  // Each entry is shaped like: { rank: N, id: NUM, name: "...", slug: "..."
  const re = /\{\s*rank:\s*(\d+),\s*id:\s*(\d+),\s*name:\s*"([^"]+)",\s*\n?\s*slug:\s*"([^"]+)"/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({ rank: Number(m[1]), id: Number(m[2]), name: m[3], slug: m[4] });
  }
  return out;
}

test("cwe-catalog.ts: exactly 25 entries (CWE Top 25)", () => {
  const entries = readCweEntries();
  assert.equal(entries.length, 25, `expected 25 CWEs, got ${entries.length}`);
});

test("cwe-catalog.ts: ranks 1..25 with no gaps or duplicates", () => {
  const entries = readCweEntries();
  const ranks = entries.map((e) => e.rank).sort((a, b) => a - b);
  for (let i = 0; i < 25; i++) {
    assert.equal(ranks[i], i + 1, `expected rank ${i + 1} at position ${i}, got ${ranks[i]}`);
  }
});

test("cwe-catalog.ts: every entry has a slug starting with cwe-<id>-", () => {
  const entries = readCweEntries();
  for (const e of entries) {
    assert.ok(
      e.slug.startsWith(`cwe-${e.id}-`),
      `entry id=${e.id} has bad slug "${e.slug}"`
    );
  }
});

test("cwe-catalog.ts: ids are unique", () => {
  const entries = readCweEntries();
  const ids = entries.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate CWE ids");
});

test("cwe-catalog.ts: slugs are unique", () => {
  const entries = readCweEntries();
  const slugs = entries.map((e) => e.slug);
  assert.equal(new Set(slugs).size, slugs.length, "duplicate slugs");
});

test("all-urls.js CWE_SLUGS stays in lockstep with cwe-catalog.ts", () => {
  const entries = readCweEntries();
  const catalogSlugs = entries.sort((a, b) => a.rank - b.rank).map((e) => e.slug);
  assert.deepEqual(CWE_SLUGS, catalogSlugs, "CWE_SLUGS out of sync with catalog");
});

test("find/[slug]/page.tsx: emits FAQPage + TechArticle structured data", () => {
  const src = fs.readFileSync(CWE_PAGE_PATH, "utf8");
  assert.match(src, /@type":\s*"FAQPage"/);
  assert.match(src, /@type":\s*"TechArticle"/);
});

test("find/[slug]/page.tsx: generateStaticParams + generateMetadata exported", () => {
  const src = fs.readFileSync(CWE_PAGE_PATH, "utf8");
  assert.match(src, /export async function generateStaticParams/);
  assert.match(src, /export async function generateMetadata/);
});

test("find/[slug]/page.tsx: canonical URL points at /find/<slug>", () => {
  const src = fs.readFileSync(CWE_PAGE_PATH, "utf8");
  assert.match(src, /https:\/\/gatetest\.ai\/find\/\$\{cwe\.slug\}/);
  assert.match(src, /alternates:\s*\{\s*canonical/);
});

test("find/page.tsx: CollectionPage structured data + lists all 25", () => {
  const src = fs.readFileSync(CWE_INDEX_PATH, "utf8");
  assert.match(src, /@type":\s*"CollectionPage"/);
  assert.match(src, /CWE_TOP_25\.map/);
});

test("sitemap.ts: imports getAllCweSlugs and emits CWE URLs", () => {
  const src = fs.readFileSync(SITEMAP_PATH, "utf8");
  assert.match(src, /getAllCweSlugs/);
  assert.match(src, /\/find/);
});
