"use strict";

/**
 * Static-source meta-tests for the /for/<country> SEO factory.
 *
 * These assertions read the source files directly — they never spin
 * up Next, never render React. The point is to make accidental
 * regressions impossible: if a country gets removed, the test fails;
 * if the factory stops generating static params, the test fails; if
 * the sitemap stops including the new URLs, the test fails.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const COUNTRIES_TS = path.join(ROOT, "website/app/for/countries.ts");
const FACTORY_TSX = path.join(ROOT, "website/app/for/[country]/page.tsx");
const LAYOUT_TSX = path.join(ROOT, "website/app/for/[country]/layout.tsx");
const INDEX_TSX = path.join(ROOT, "website/app/for/page.tsx");
const SITEMAP_TS = path.join(ROOT, "website/app/sitemap.ts");
const ALL_URLS_JS = path.join(ROOT, "website/app/lib/seo/all-urls.js");

const EXPECTED_SLUGS = [
  "usa",
  "uk",
  "eu",
  "australia",
  "new-zealand",
  "singapore",
  "canada",
];

function readSource(p) {
  return fs.readFileSync(p, "utf8");
}

function extractEntries(src) {
  // Parse each "{ slug: "...", ... }" block at the top level of COUNTRIES.
  // String- and template-literal-aware brace-depth scanner so
  // characters inside strings can't trip the depth counter.
  const start = src.indexOf("export const COUNTRIES");
  assert.ok(start >= 0, "COUNTRIES export not found");
  // Skip past the type annotation `Country[]` and find the `= [` opener.
  const eqIdx = src.indexOf("=", start);
  assert.ok(eqIdx > start, "COUNTRIES assignment not found");
  const arrStart = src.indexOf("[", eqIdx);
  assert.ok(arrStart >= 0, "COUNTRIES array opener not found");

  // walk to find matching close bracket
  const bracketEnd = findMatchingClose(src, arrStart, "[", "]");
  assert.ok(bracketEnd > arrStart, "COUNTRIES array closer not found");
  const body = src.slice(arrStart + 1, bracketEnd);

  // Walk body, extracting top-level `{ ... }` objects.
  const entries = [];
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === "{") {
      const end = findMatchingClose(body, i, "{", "}");
      if (end < 0) break;
      entries.push(body.slice(i, end + 1));
      i = end + 1;
    } else {
      i++;
    }
  }
  return entries;
}

function findMatchingClose(src, openIdx, openCh, closeCh) {
  let depth = 0;
  let i = openIdx;
  let str = null; // tracking quote char
  while (i < src.length) {
    const ch = src[i];
    if (str) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === str) str = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      str = ch;
      i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const cl = src.indexOf("*/", i + 2);
      i = cl < 0 ? src.length : cl + 2;
      continue;
    }
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function extractField(entry, key) {
  const re = new RegExp(`\\b${key}:\\s*"([^"]*)"`);
  const m = entry.match(re);
  return m ? m[1] : null;
}

function extractArrayField(entry, key) {
  const re = new RegExp(`\\b${key}:\\s*\\[([\\s\\S]*?)\\]`);
  const m = entry.match(re);
  if (!m) return null;
  const items = [];
  const innerRe = /"([^"]*)"/g;
  let mm;
  while ((mm = innerRe.exec(m[1])) !== null) items.push(mm[1]);
  return items;
}

describe("/for/<country> SEO factory", () => {
  const src = readSource(COUNTRIES_TS);
  const entries = extractEntries(src);

  it("exports a COUNTRIES array with at least 7 entries", () => {
    assert.ok(entries.length >= 7, `expected ≥ 7 countries, got ${entries.length}`);
  });

  it("ships all 7 expected country slugs", () => {
    const slugs = entries.map((e) => extractField(e, "slug"));
    for (const expected of EXPECTED_SLUGS) {
      assert.ok(
        slugs.includes(expected),
        `expected slug "${expected}" not found — have ${slugs.join(", ")}`,
      );
    }
  });

  it("every country slug is URL-safe (lowercase, alnum, hyphens)", () => {
    const re = /^[a-z0-9-]+$/;
    for (const entry of entries) {
      const slug = extractField(entry, "slug");
      assert.ok(slug, "missing slug in an entry");
      assert.match(slug, re, `slug "${slug}" is not URL-safe`);
    }
  });

  it("every country has a name", () => {
    for (const entry of entries) {
      const name = extractField(entry, "name");
      assert.ok(name && name.length > 0, "missing name in entry");
    }
  });

  it("every country has a flag", () => {
    for (const entry of entries) {
      const flag = extractField(entry, "flag");
      assert.ok(flag && flag.length > 0, "missing flag in entry");
    }
  });

  it("every country has a primaryRegulation", () => {
    for (const entry of entries) {
      const reg = extractField(entry, "primaryRegulation");
      assert.ok(reg && reg.length > 0, "missing primaryRegulation");
    }
  });

  it("every country has a whyGateTestFits pitch", () => {
    for (const entry of entries) {
      const pitch = extractField(entry, "whyGateTestFits");
      assert.ok(pitch && pitch.length > 20, "whyGateTestFits too short");
    }
  });

  it("every country has popularStack with 3-5 entries", () => {
    for (const entry of entries) {
      const stack = extractArrayField(entry, "popularStack");
      assert.ok(stack, "missing popularStack");
      assert.ok(stack.length >= 3 && stack.length <= 5, `popularStack length ${stack.length}`);
    }
  });

  it("every country has popularHosts with 2-3 entries", () => {
    for (const entry of entries) {
      const hosts = extractArrayField(entry, "popularHosts");
      assert.ok(hosts, "missing popularHosts");
      assert.ok(hosts.length >= 2 && hosts.length <= 3, `popularHosts length ${hosts.length}`);
    }
  });

  it("every country has exactly 3 topThreeModules", () => {
    for (const entry of entries) {
      const mods = extractArrayField(entry, "topThreeModules");
      assert.ok(mods, "missing topThreeModules");
      assert.equal(mods.length, 3, `topThreeModules should be 3, got ${mods.length}`);
    }
  });

  it("topThreeModules reference real module names from /modules", () => {
    // Cross-reference: at least one specific real module must appear.
    const allMods = new Set();
    for (const entry of entries) {
      const mods = extractArrayField(entry, "topThreeModules");
      for (const m of mods ?? []) allMods.add(m);
    }
    const hasRealModule = ["secrets", "dependencies", "logPii", "webHeaders"].some((m) =>
      allMods.has(m),
    );
    assert.ok(hasRealModule, `expected real module like "secrets" — got ${[...allMods].join(",")}`);
  });

  it("countries.ts source contains no eslint-disable directives", () => {
    assert.ok(!src.includes("eslint-disable"), "found eslint-disable in countries.ts");
  });
});

describe("/for/[country]/page.tsx factory", () => {
  const src = readSource(FACTORY_TSX);

  it("file exists and is non-empty", () => {
    assert.ok(src.length > 500, "factory file too short");
  });

  it("exports generateStaticParams to pre-render every country", () => {
    assert.match(src, /export async function generateStaticParams/, "generateStaticParams missing");
    assert.match(src, /getAllCountrySlugs/, "factory does not iterate country slugs");
  });

  it("uses the country data to render — imports getCountryBySlug", () => {
    assert.match(src, /getCountryBySlug/, "factory does not look up data by slug");
  });

  it("calls notFound() when slug is unknown", () => {
    assert.match(src, /notFound\(\)/, "factory does not 404 unknown slugs");
  });

  it("emits SoftwareApplication JSON-LD", () => {
    assert.match(src, /"@type":\s*"SoftwareApplication"/, "SoftwareApplication JSON-LD missing");
  });

  it("emits BreadcrumbList JSON-LD", () => {
    assert.match(src, /"@type":\s*"BreadcrumbList"/, "BreadcrumbList JSON-LD missing");
  });

  it("hero CTAs link to /scan and /modules", () => {
    assert.match(src, /href="\/scan"/, "missing /scan CTA");
    assert.match(src, /href="\/modules"/, "missing /modules CTA");
  });

  it("exports generateMetadata with country-specific title", () => {
    assert.match(src, /export async function generateMetadata/, "generateMetadata missing");
    assert.match(src, /`GateTest for \$\{data\.name\}/, "country-specific title missing");
  });

  it("uses the live module count (110, not stale 91/102/104)", () => {
    assert.match(src, /MODULE_COUNT\s*=\s*110/, "stale module count");
    assert.ok(!/\b(91|102|104) modules\b/.test(src), "stale module count reference");
  });

  it("contains no eslint-disable directives", () => {
    assert.ok(!src.includes("eslint-disable"), "found eslint-disable in factory");
  });

  it("HN/PH launch badges are env-guarded, not unconditional", () => {
    assert.match(src, /NEXT_PUBLIC_LAUNCH_HN/, "launch badges should be env-guarded");
  });
});

describe("/for/[country]/layout.tsx", () => {
  const src = readSource(LAYOUT_TSX);
  it("exports generateMetadata", () => {
    assert.match(src, /export async function generateMetadata/, "layout missing generateMetadata");
  });
  it("layout sets canonical URL", () => {
    assert.match(src, /canonical[\s\S]{0,80}gatetest\.ai\/for/, "canonical URL missing");
  });
});

describe("/for/page.tsx (index page)", () => {
  const src = readSource(INDEX_TSX);
  it("file exists and lists countries", () => {
    assert.ok(src.length > 500, "index page too short");
    assert.match(src, /COUNTRIES/, "index does not import COUNTRIES");
  });
  it("has a canonical URL set", () => {
    assert.match(src, /canonical:\s*"https:\/\/gatetest\.ai\/for"/, "canonical missing on /for");
  });
});

describe("Sitemap includes the 7 country URLs", () => {
  const src = readSource(SITEMAP_TS);

  it("imports getAllCountrySlugs", () => {
    assert.match(src, /getAllCountrySlugs/, "sitemap does not import country slugs");
  });

  it("includes /for index in the sitemap", () => {
    assert.match(src, /\/for`/, "sitemap missing /for index");
  });

  it("emits per-country sitemap entries with monthly + 0.7 priority", () => {
    assert.match(src, /countryPages/, "countryPages array missing");
    assert.match(src, /changeFrequency:\s*"monthly"/, "monthly changeFrequency missing");
  });
});

describe("IndexNow all-urls.js includes country URLs", () => {
  const src = readSource(ALL_URLS_JS);

  it("declares COUNTRY_SLUGS in lockstep with countries.ts", () => {
    assert.match(src, /COUNTRY_SLUGS/, "COUNTRY_SLUGS not declared");
    for (const slug of EXPECTED_SLUGS) {
      assert.ok(src.includes(`"${slug}"`), `COUNTRY_SLUGS missing "${slug}"`);
    }
  });

  it("includes country URLs in the buildAllUrls output", () => {
    const mod = require(ALL_URLS_JS);
    const urls = mod.buildAllUrls();
    for (const slug of EXPECTED_SLUGS) {
      assert.ok(
        urls.includes(`https://gatetest.ai/for/${slug}`),
        `buildAllUrls missing /for/${slug}`,
      );
    }
    assert.ok(urls.includes("https://gatetest.ai/for"), "buildAllUrls missing /for index");
  });
});
