/**
 * Build the full list of URLs to submit to IndexNow.
 *
 * Source of truth is sitemap.ts. To keep this module JS-runnable from
 * the route handler and CLI without TS compilation, we walk the
 * directory tree the same way sitemap.ts does and emit URLs. The
 * test asserts the two outputs match.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const BASE = "https://gatetest.ai";

const COMPARISON_SLUGS = [
  "sonarqube",
  "snyk",
  "eslint",
  "github-code-scanning",
  "deepsource",
  "semgrep",
  "codeql",
];
const FOR_SLUGS = ["nextjs", "typescript", "nodejs"];
const LEGAL_SLUGS = ["terms", "privacy", "refunds", "acceptable-use"];

/**
 * Convert camelCase to kebab-case — must match website/app/components/howitworks/module-slugs.ts
 */
function moduleNameToSlug(name) {
  return name
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Extract module names from the TS source — same source-of-truth as sitemap.ts.
 *
 * @param {string} [modulesDataPath] override for tests
 */
function readModuleNamesFromSource(modulesDataPath) {
  const candidatePaths = [
    modulesDataPath,
    path.resolve(process.cwd(), "website/app/components/howitworks/modules-data.ts"),
    path.resolve(__dirname, "..", "..", "components", "howitworks", "modules-data.ts"),
  ].filter(Boolean);

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      const src = fs.readFileSync(p, "utf8");
      const out = [];
      const re = /\{\s*name:\s*"([^"]+)"/g;
      let m;
      while ((m = re.exec(src)) !== null) out.push(m[1]);
      return out;
    }
  }
  return [];
}

/**
 * Build the full URL list ready for IndexNow submission. Returns
 * URLs in priority order: home / index / comparisons / for / modules / legal.
 *
 * @param {object} [args]
 * @param {string} [args.modulesDataPath]
 * @returns {string[]}
 */
function buildAllUrls({ modulesDataPath } = {}) {
  const moduleNames = readModuleNamesFromSource(modulesDataPath);
  const moduleSlugs = Array.from(new Set(moduleNames.map(moduleNameToSlug)));

  return [
    BASE,
    `${BASE}/modules`,
    `${BASE}/github/setup`,
    `${BASE}/dashboard`,
    ...COMPARISON_SLUGS.map((s) => `${BASE}/compare/${s}`),
    ...FOR_SLUGS.map((s) => `${BASE}/for/${s}`),
    ...moduleSlugs.map((s) => `${BASE}/modules/${s}`),
    ...LEGAL_SLUGS.map((s) => `${BASE}/legal/${s}`),
  ];
}

module.exports = {
  buildAllUrls,
  readModuleNamesFromSource,
  moduleNameToSlug,
  BASE,
  COMPARISON_SLUGS,
  FOR_SLUGS,
  LEGAL_SLUGS,
};
