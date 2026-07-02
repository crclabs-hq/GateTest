"use strict";

/**
 * Marketing regulation pages — static-source meta-tests.
 *
 * Covers Wave 2b of the marketing-site refresh — the SEO factory for
 * compliance-regime landing pages under:
 *   - website/app/regulation/catalog.ts
 *   - website/app/regulation/[slug]/page.tsx
 *   - website/app/regulation/[slug]/layout.tsx
 *   - website/app/regulation/page.tsx
 *
 * We cannot execute the .tsx in node:test, so we lock file shape and
 * catalog content via static-source assertions. The catalog itself is
 * a TypeScript module, but its REGULATIONS array is a plain object
 * literal we can parse out with a regex-tolerant approach: each test
 * walks the source file and asserts the presence of structural markers.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

const CATALOG = path.join(ROOT, "website/app/regulation/catalog.ts");
const FACTORY_PAGE = path.join(ROOT, "website/app/regulation/[slug]/page.tsx");
const FACTORY_LAYOUT = path.join(ROOT, "website/app/regulation/[slug]/layout.tsx");
const INDEX_PAGE = path.join(ROOT, "website/app/regulation/page.tsx");
const SITEMAP = path.join(ROOT, "website/app/sitemap.ts");
const MODULES_DATA = path.join(ROOT, "website/app/components/howitworks/modules-data.ts");

const REQUIRED_SLUGS = ["gdpr", "hipaa", "soc2", "ccpa", "pci-dss", "iso27001"];

function readSrc(p) {
  return fs.readFileSync(p, "utf8");
}

/** Pull every `slug: "..."` literal out of the catalog source. */
function extractSlugs(catalogSrc) {
  const out = [];
  const re = /slug:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(catalogSrc))) out.push(m[1]);
  return out;
}

/** Pull every module name listed under `topThreeModules:` arrays. */
function extractTopThreeModules(catalogSrc) {
  // Find each topThreeModules: [ "x", "y", "z" ] block (multiline tolerant)
  const out = [];
  const re = /topThreeModules:\s*\[([^\]]+)\]/g;
  let m;
  while ((m = re.exec(catalogSrc))) {
    const inner = m[1];
    const names = inner.match(/"([^"]+)"/g) || [];
    out.push(names.map((s) => s.replace(/"/g, "")));
  }
  return out;
}

// =============================================================================
// Catalog — shape & required entries
// =============================================================================

test("regulation catalog: file exists", () => {
  assert.ok(fs.existsSync(CATALOG), `expected ${CATALOG}`);
});

test("regulation catalog: exports REGULATIONS array", () => {
  const src = readSrc(CATALOG);
  assert.match(src, /export\s+const\s+REGULATIONS\s*:\s*Regulation\[\]\s*=/);
});

test("regulation catalog: exports getAllRegulationSlugs helper", () => {
  const src = readSrc(CATALOG);
  assert.match(src, /export\s+function\s+getAllRegulationSlugs\s*\(/);
});

test("regulation catalog: exports getRegulationBySlug helper", () => {
  const src = readSrc(CATALOG);
  assert.match(src, /export\s+function\s+getRegulationBySlug\s*\(/);
});

test("regulation catalog: exports moduleNameToSlug helper", () => {
  const src = readSrc(CATALOG);
  assert.match(src, /export\s+function\s+moduleNameToSlug\s*\(/);
});

test("regulation catalog: defines Regulation type with all required fields", () => {
  const src = readSrc(CATALOG);
  // The interface block lists every field name once
  for (const field of [
    "slug",
    "name",
    "longName",
    "jurisdiction",
    "authoritativeUrl",
    "countriesAffected",
    "fineRange",
    "effectiveSince",
    "whyDevsCareThisYear",
    "topThreeModules",
    "catchableTechnicalFindings",
    "outOfScopeForGateTest",
  ]) {
    assert.match(src, new RegExp(`\\b${field}\\b`), `Regulation interface missing field ${field}`);
  }
});

test("regulation catalog: contains at least 6 entries", () => {
  const slugs = extractSlugs(readSrc(CATALOG));
  assert.ok(slugs.length >= 6, `expected ≥6 slug entries, got ${slugs.length}`);
});

test("regulation catalog: all slugs are URL-safe (lowercase / digits / hyphens)", () => {
  const slugs = extractSlugs(readSrc(CATALOG));
  for (const s of slugs) {
    assert.match(s, /^[a-z0-9-]+$/, `slug "${s}" is not URL-safe`);
  }
});

test("regulation catalog: contains all 6 required slugs", () => {
  const slugs = extractSlugs(readSrc(CATALOG));
  for (const req of REQUIRED_SLUGS) {
    assert.ok(slugs.includes(req), `required slug "${req}" missing from catalog`);
  }
});

test("regulation catalog: each entry has topThreeModules with exactly 3 names", () => {
  const triples = extractTopThreeModules(readSrc(CATALOG));
  assert.ok(triples.length >= 6, `expected ≥6 topThreeModules blocks, got ${triples.length}`);
  for (const t of triples) {
    assert.equal(t.length, 3, `expected exactly 3 modules per regulation, got ${t.length}: ${t.join(", ")}`);
  }
});

test("regulation catalog: every topThreeModules entry references a real module name", () => {
  const modulesSrc = readSrc(MODULES_DATA);
  const triples = extractTopThreeModules(readSrc(CATALOG));
  const flat = new Set(triples.flat());
  for (const modName of flat) {
    // modules-data.ts always has each module declared as { name: "<modName>", ... }
    assert.match(
      modulesSrc,
      new RegExp(`name:\\s*"${modName}"`),
      `module "${modName}" referenced from regulation catalog does not exist in modules-data.ts`
    );
  }
});

test("regulation catalog: every entry has a non-empty fineRange string", () => {
  const src = readSrc(CATALOG);
  // Each block has fineRange: "..." with at least 10 chars of content
  const re = /fineRange:\s*"([^"]+)"/g;
  let m;
  let count = 0;
  while ((m = re.exec(src))) {
    assert.ok(m[1].length >= 10, `fineRange too short: "${m[1]}"`);
    count++;
  }
  assert.ok(count >= 6, `expected ≥6 fineRange entries, got ${count}`);
});

test("regulation catalog: every entry has an authoritativeUrl pointing to https://", () => {
  const src = readSrc(CATALOG);
  const re = /authoritativeUrl:\s*"([^"]+)"/g;
  let m;
  let count = 0;
  while ((m = re.exec(src))) {
    assert.match(m[1], /^https:\/\//, `authoritativeUrl is not https: "${m[1]}"`);
    count++;
  }
  assert.equal(count, REQUIRED_SLUGS.length, `expected one authoritativeUrl per regulation`);
});

// =============================================================================
// Factory page — [slug]/page.tsx
// =============================================================================

test("regulation factory page: file exists", () => {
  assert.ok(fs.existsSync(FACTORY_PAGE), `expected ${FACTORY_PAGE}`);
});

test("regulation factory page: exports generateStaticParams", () => {
  const src = readSrc(FACTORY_PAGE);
  assert.match(src, /export\s+async\s+function\s+generateStaticParams\s*\(/);
});

test("regulation factory page: hero CTAs link to /scan and /modules", () => {
  const src = readSrc(FACTORY_PAGE);
  assert.match(src, /href=["']\/scan["']/, "expected a /scan CTA");
  assert.match(src, /href=["']\/modules["']/, "expected a /modules CTA");
});

test("regulation factory page: renders the Out-of-scope honesty section", () => {
  const src = readSrc(FACTORY_PAGE);
  assert.match(src, /Out of scope/i);
  assert.match(src, /outOfScopeForGateTest/);
});

test("regulation factory page: renders Technical findings section bound to catchableTechnicalFindings", () => {
  const src = readSrc(FACTORY_PAGE);
  assert.match(src, /Technical findings GateTest catches/i);
  assert.match(src, /catchableTechnicalFindings/);
});

test("regulation factory page: emits SoftwareApplication JSON-LD", () => {
  const src = readSrc(FACTORY_PAGE);
  assert.match(src, /application\/ld\+json/);
  assert.match(src, /"@type":\s*"SoftwareApplication"/);
});

test("regulation factory page: emits BreadcrumbList JSON-LD", () => {
  const src = readSrc(FACTORY_PAGE);
  assert.match(src, /"@type":\s*"BreadcrumbList"/);
});

test("regulation factory page: renders chip row for countriesAffected linking to /for/<country>", () => {
  const src = readSrc(FACTORY_PAGE);
  assert.match(src, /\/for\/\$\{[^}]+\}/);
});

test("regulation factory page: renders pricing strip with 4 tiers including $399 Forensic", () => {
  const src = readSrc(FACTORY_PAGE);
  for (const price of ["$29", "$99", "$199", "$399"]) {
    assert.ok(src.includes(price), `expected pricing strip to include ${price}`);
  }
});

test("regulation factory page: trust strip mentions MIT and GitHub Marketplace", () => {
  const src = readSrc(FACTORY_PAGE);
  assert.match(src, /MIT/);
  assert.match(src, /GitHub Marketplace/);
});

test("regulation factory page: HN/PH badge is gated behind NEXT_PUBLIC_LAUNCH_HN env flag", () => {
  const src = readSrc(FACTORY_PAGE);
  // The badge only renders when SHOW_HN_BADGE === true, which is derived from
  // process.env.NEXT_PUBLIC_LAUNCH_HN === "1"
  assert.match(src, /NEXT_PUBLIC_LAUNCH_HN/);
});

test("regulation factory page: no eslint-disable directives", () => {
  const src = readSrc(FACTORY_PAGE);
  assert.ok(!/eslint-disable/.test(src), "factory page must not contain eslint-disable directives");
});

// =============================================================================
// Factory layout — [slug]/layout.tsx
// =============================================================================

test("regulation factory layout: file exists", () => {
  assert.ok(fs.existsSync(FACTORY_LAYOUT), `expected ${FACTORY_LAYOUT}`);
});

test("regulation factory layout: exports generateMetadata with regulation-specific title", () => {
  const src = readSrc(FACTORY_LAYOUT);
  assert.match(src, /export\s+async\s+function\s+generateMetadata/);
  // The title must reference both the short name and the longName
  assert.match(src, /reg\.name/);
  assert.match(src, /reg\.longName/);
  // Canonical URL points at /regulation/<slug>
  assert.match(src, /https:\/\/gatetest\.ai\/regulation\//);
});

test("regulation factory layout: no eslint-disable directives", () => {
  const src = readSrc(FACTORY_LAYOUT);
  assert.ok(!/eslint-disable/.test(src), "factory layout must not contain eslint-disable directives");
});

// =============================================================================
// Index page — /regulation/page.tsx
// =============================================================================

test("regulation index page: file exists", () => {
  assert.ok(fs.existsSync(INDEX_PAGE), `expected ${INDEX_PAGE}`);
});

test("regulation index page: lists all 6 regulations by mapping REGULATIONS", () => {
  const src = readSrc(INDEX_PAGE);
  assert.match(src, /REGULATIONS\.map/);
});

test("regulation index page: has canonical metadata for /regulation", () => {
  const src = readSrc(INDEX_PAGE);
  assert.match(src, /canonical:\s*["']https:\/\/gatetest\.ai\/regulation["']/);
});

test("regulation index page: no eslint-disable directives", () => {
  const src = readSrc(INDEX_PAGE);
  assert.ok(!/eslint-disable/.test(src), "index page must not contain eslint-disable directives");
});

// =============================================================================
// Sitemap
// =============================================================================

test("sitemap: imports getAllRegulationSlugs from regulation/catalog", () => {
  const src = readSrc(SITEMAP);
  assert.match(src, /getAllRegulationSlugs/);
  assert.match(src, /from\s+["']\.\/regulation\/catalog["']/);
});

test("sitemap: emits a URL per regulation slug under /regulation/", () => {
  const src = readSrc(SITEMAP);
  // The generator builds `${base}/regulation/${slug}`
  assert.match(src, /\$\{base\}\/regulation\/\$\{slug\}/);
});

test("sitemap: includes the /regulation index URL", () => {
  const src = readSrc(SITEMAP);
  assert.match(src, /\$\{base\}\/regulation`/);
});

test("sitemap: regulation pages use monthly changeFrequency and priority 0.7", () => {
  const src = readSrc(SITEMAP);
  // Find the regulationPages block and assert both attributes.
  const block = src.split("regulationPages")[1] || "";
  assert.match(block, /changeFrequency:\s*["']monthly["']/);
  assert.match(block, /priority:\s*0\.7/);
});
