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
// Country-specific landing pages — kept in lockstep with
// website/app/for/countries.ts. Tests assert no drift.
const COUNTRY_SLUGS = [
  "usa",
  "uk",
  "eu",
  "australia",
  "new-zealand",
  "singapore",
  "canada",
];
const LEGAL_SLUGS = ["terms", "privacy", "refunds", "acceptable-use"];

// CWE Top 25 slugs — kept in lockstep with website/app/find/cwe-catalog.ts.
// Same numeric ids in the same order. Tests assert no drift.
const CWE_SLUGS = [
  "cwe-787-out-of-bounds-write",
  "cwe-79-xss",
  "cwe-89-sql-injection",
  "cwe-416-use-after-free",
  "cwe-78-os-command-injection",
  "cwe-20-improper-input-validation",
  "cwe-125-out-of-bounds-read",
  "cwe-22-path-traversal",
  "cwe-352-csrf",
  "cwe-434-unrestricted-file-upload",
  "cwe-862-missing-authorization",
  "cwe-476-null-pointer-dereference",
  "cwe-287-improper-authentication",
  "cwe-190-integer-overflow",
  "cwe-502-deserialization-of-untrusted-data",
  "cwe-77-command-injection",
  "cwe-119-buffer-overflow",
  "cwe-798-hardcoded-credentials",
  "cwe-918-ssrf",
  "cwe-306-missing-authentication",
  "cwe-362-race-condition",
  "cwe-269-improper-privilege-management",
  "cwe-94-code-injection",
  "cwe-863-incorrect-authorization",
  "cwe-276-incorrect-default-permissions",
];

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
    `${BASE}/find`,
    `${BASE}/github/setup`,
    `${BASE}/dashboard`,
    ...COMPARISON_SLUGS.map((s) => `${BASE}/compare/${s}`),
    ...FOR_SLUGS.map((s) => `${BASE}/for/${s}`),
    ...moduleSlugs.map((s) => `${BASE}/modules/${s}`),
    ...CWE_SLUGS.map((s) => `${BASE}/find/${s}`),
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
  CWE_SLUGS,
};
