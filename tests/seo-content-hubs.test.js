"use strict";

/**
 * SEO campaign coverage — glossary / use-cases / blog hubs, the compare hub
 * index, llms.txt, robots AI-crawler opt-in, the shared schema library, and
 * sitemap / IndexNow drift.
 *
 * Like the sibling seo-*-pages tests, we can't import the .ts/.tsx sources
 * under node:test, so we parse them as text (the source IS the contract) and
 * we require the plain-JS all-urls module directly.
 *
 * Run: node --test tests/seo-content-hubs.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const APP = path.resolve(__dirname, "..", "website", "app");
const read = (...p) => fs.readFileSync(path.join(APP, ...p), "utf8");

const {
  buildAllUrls,
  GLOSSARY_SLUGS,
  USE_CASE_SLUGS,
  BLOG_SLUGS,
} = require("../website/app/lib/seo/all-urls.js");

// Pull slugs out of a catalogue .ts by matching `slug: "..."`.
function slugsFromCatalog(src) {
  const out = [];
  const re = /\bslug:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

const sitemap = read("sitemap.ts");
const allUrls = buildAllUrls();

// ─────────────────────────────────────────────────────────────────────────
// Glossary
// ─────────────────────────────────────────────────────────────────────────
test("glossary: catalogue, all-urls, and sitemap stay in lockstep", () => {
  const cat = slugsFromCatalog(read("glossary", "glossary-catalog.ts"));
  assert.ok(cat.length >= 10, `expected >= 10 glossary terms, got ${cat.length}`);
  assert.deepEqual([...cat].sort(), [...GLOSSARY_SLUGS].sort(), "all-urls GLOSSARY_SLUGS drifted from catalogue");
  for (const slug of cat) {
    assert.ok(sitemap.includes(`/glossary/`), "sitemap missing glossary section");
    assert.ok(allUrls.includes(`https://gatetest.ai/glossary/${slug}`), `all-urls missing /glossary/${slug}`);
  }
  assert.ok(allUrls.includes("https://gatetest.ai/glossary"), "all-urls missing glossary index");
});

test("glossary detail page: DefinedTerm + FAQPage + BreadcrumbList + 404", () => {
  const page = read("glossary", "[slug]", "page.tsx");
  assert.match(page, /definedTermSchema/);
  assert.match(page, /faqSchema/);
  assert.match(page, /breadcrumbSchema/);
  assert.match(page, /notFound\(\)/);
  assert.match(page, /generateStaticParams/);
  assert.match(page, /generateMetadata/);
});

test("glossary index: canonical via contentMetadata + CollectionPage schema", () => {
  const idx = read("glossary", "page.tsx");
  assert.match(idx, /contentMetadata\(/);
  assert.match(idx, /path:\s*"\/glossary"/);
  assert.match(idx, /collectionPageSchema/);
});

// ─────────────────────────────────────────────────────────────────────────
// Use cases
// ─────────────────────────────────────────────────────────────────────────
test("use-cases: catalogue, all-urls, and sitemap stay in lockstep", () => {
  const cat = slugsFromCatalog(read("use-cases", "use-cases-catalog.ts"));
  assert.ok(cat.length >= 7, `expected >= 7 use cases, got ${cat.length}`);
  assert.deepEqual([...cat].sort(), [...USE_CASE_SLUGS].sort(), "all-urls USE_CASE_SLUGS drifted from catalogue");
  for (const slug of cat) {
    assert.ok(allUrls.includes(`https://gatetest.ai/use-cases/${slug}`), `all-urls missing /use-cases/${slug}`);
  }
  assert.ok(sitemap.includes("/use-cases/"), "sitemap missing use-cases section");
});

test("use-case detail page: TechArticle + FAQPage + BreadcrumbList + 404", () => {
  const page = read("use-cases", "[slug]", "page.tsx");
  assert.match(page, /articleSchema/);
  assert.match(page, /faqSchema/);
  assert.match(page, /breadcrumbSchema/);
  assert.match(page, /notFound\(\)/);
  assert.match(page, /generateStaticParams/);
});

test("use-cases index: canonical + CollectionPage", () => {
  const idx = read("use-cases", "page.tsx");
  assert.match(idx, /path:\s*"\/use-cases"/);
  assert.match(idx, /collectionPageSchema/);
});

// ─────────────────────────────────────────────────────────────────────────
// Blog
// ─────────────────────────────────────────────────────────────────────────
test("blog: catalogue, all-urls, and sitemap stay in lockstep", () => {
  const cat = slugsFromCatalog(read("blog", "blog-catalog.ts"));
  assert.ok(cat.length >= 3, `expected >= 3 posts, got ${cat.length}`);
  assert.deepEqual([...cat].sort(), [...BLOG_SLUGS].sort(), "all-urls BLOG_SLUGS drifted from catalogue");
  for (const slug of cat) {
    assert.ok(allUrls.includes(`https://gatetest.ai/blog/${slug}`), `all-urls missing /blog/${slug}`);
  }
  assert.ok(sitemap.includes("/blog/"), "sitemap missing blog section");
});

test("blog detail page: BlogPosting + FAQPage + article ogType + 404", () => {
  const page = read("blog", "[slug]", "page.tsx");
  assert.match(page, /blogPostingSchema/);
  assert.match(page, /faqSchema/);
  assert.match(page, /breadcrumbSchema/);
  assert.match(page, /ogType:\s*"article"/);
  assert.match(page, /notFound\(\)/);
});

test("blog posts carry a published date for BlogPosting schema", () => {
  const cat = read("blog", "blog-catalog.ts");
  const dates = cat.match(/datePublished:\s*"\d{4}-\d{2}-\d{2}"/g) || [];
  assert.ok(dates.length >= 3, "every post needs a datePublished");
});

// ─────────────────────────────────────────────────────────────────────────
// Compare hub index (was missing)
// ─────────────────────────────────────────────────────────────────────────
test("compare hub index exists with canonical + CollectionPage + in sitemap", () => {
  const idx = read("compare", "page.tsx");
  assert.match(idx, /path:\s*"\/compare"/);
  assert.match(idx, /collectionPageSchema/);
  assert.ok(sitemap.includes("/compare"), "sitemap missing /compare hub");
  assert.ok(allUrls.includes("https://gatetest.ai/compare"), "all-urls missing /compare");
});

// ─────────────────────────────────────────────────────────────────────────
// robots.txt
// ─────────────────────────────────────────────────────────────────────────
test("robots: opts in named AI crawlers and points at the sitemap", () => {
  const robots = read("robots.ts");
  for (const agent of ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended"]) {
    assert.ok(robots.includes(agent), `robots missing AI crawler ${agent}`);
  }
  assert.match(robots, /sitemap:\s*"https:\/\/gatetest\.ai\/sitemap\.xml"/);
  // sensitive surfaces stay out of the index
  for (const dis of ["/api/", "/admin", "/dashboard"]) {
    assert.ok(robots.includes(dis), `robots should disallow ${dis}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// llms.txt
// ─────────────────────────────────────────────────────────────────────────
test("llms.txt route renders an llmstxt.org map", () => {
  const route = read("llms.txt", "route.ts");
  assert.match(route, /export function GET/);
  assert.match(route, /text\/markdown/);
  assert.match(route, /# GateTest/);
  assert.match(route, /## Glossary/);
  assert.match(route, /## Use cases/);
  assert.match(route, /## Blog/);
});

// ─────────────────────────────────────────────────────────────────────────
// Shared schema library
// ─────────────────────────────────────────────────────────────────────────
test("schema.ts exports the builders the hubs depend on", () => {
  const schema = read("lib", "seo", "schema.ts");
  for (const fn of [
    "faqSchema",
    "breadcrumbSchema",
    "definedTermSchema",
    "blogPostingSchema",
    "articleSchema",
    "organizationSchema",
    "webSiteSchema",
    "collectionPageSchema",
    "contentMetadata",
  ]) {
    assert.ok(schema.includes(`export function ${fn}`), `schema.ts missing ${fn}`);
  }
  // JSON-LD must be </script>-injection safe.
  assert.match(schema, /replace\(\/<\/g/);
});

// ─────────────────────────────────────────────────────────────────────────
// Layout-level structured data
// ─────────────────────────────────────────────────────────────────────────
test("layout emits Organization + WebSite + SoftwareApplication JSON-LD", () => {
  const layout = read("layout.tsx");
  assert.match(layout, /organizationSchema\(\)/);
  assert.match(layout, /webSiteSchema\(\)/);
  assert.match(layout, /SoftwareApplication/);
});

// ─────────────────────────────────────────────────────────────────────────
// Existing landing + docs SEO (regression guards from the brief)
// ─────────────────────────────────────────────────────────────────────────
test("landing layout keeps SoftwareApplication JSON-LD and canonical", () => {
  const layout = read("layout.tsx");
  assert.match(layout, /"@type":\s*"SoftwareApplication"/);
  assert.match(layout, /canonical:\s*"https:\/\/gatetest\.ai"/);
});

test("every IndexNow URL is canonical https on gatetest.ai (no leaks)", () => {
  for (const url of allUrls) {
    assert.ok(url.startsWith("https://gatetest.ai"), `non-canonical URL leaked: ${url}`);
  }
  // de-duped
  assert.equal(new Set(allUrls).size, allUrls.length, "duplicate URLs in IndexNow list");
});
