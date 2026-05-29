/**
 * Reliability corpus — manifest loader & validator.
 *
 * A reliability test case lives in a directory:
 *
 *   reliability-corpus/<category>/<name>/
 *     manifest.json   ← what we expect from the scan
 *     src/...         ← actual code to scan
 *
 * `manifest.json` shape:
 *
 *   {
 *     "name": "sqli-string-concat",
 *     "category": "known-bad" | "known-good" | "oss-snapshot" | "mixed",
 *     "tier": "quick" | "full" | "scan_fix" | "nuclear",
 *     "description": "string",
 *     "expected": {
 *       "errors":   { "<module>": { "atLeast": n, "atMost": m } },
 *       "warnings": { "<module>": { "atLeast": n, "atMost": m } },
 *       "totalErrorsAtLeast": n,    // overall floor
 *       "totalErrorsAtMost":  m,    // overall ceiling
 *     },
 *     "budgets": {
 *       "maxDurationMs": 30000,
 *       "maxMemoryMb":   1024,
 *       "deterministic": true       // must produce identical findings across runs
 *     },
 *     "labels":  ["cwe-89", "owasp-a3", "py-flask"],
 *     "source":  "hand-crafted" | "cwe-bench-1234" | "nist-sard-abc",
 *     "createdAt": "ISO date"
 *   }
 *
 * The runner (runner.js) loads + validates manifests, runs the scan,
 * compares results, and produces a CaseResult. The drift detector
 * (drift-detector.js) compares CaseResults across runs and flags
 * regressions.
 */

"use strict";

const VALID_CATEGORIES = new Set([
  "known-bad",         // code with planted vulnerabilities
  "known-good",        // code that should produce 0 errors
  "oss-snapshot",      // frozen-SHA pointer to a real OSS repo
  "mixed",             // hand-crafted with mixed signal
  "url-known-good",    // URL we own that should scan clean
  "url-known-bad",     // URL we own with known issues (test fixtures)
  "url-snapshot",      // frozen capture of a public URL with known shape
]);
const VALID_TIERS = new Set(["quick", "full", "scan_fix", "nuclear"]);
const VALID_TARGET_TYPES = new Set(["code", "url"]);

/**
 * Validate a manifest object. Returns `{ ok, errors }`.
 *
 * @param {object} manifest
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateManifest(manifest) {
  const errors = [];

  if (!manifest || typeof manifest !== "object") {
    return { ok: false, errors: ["manifest is missing or not an object"] };
  }

  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    errors.push("name: must be a non-empty string");
  } else if (!/^[a-z0-9._-]+$/i.test(manifest.name)) {
    errors.push(`name: must be alphanumeric / hyphen / underscore / dot, got: "${manifest.name}"`);
  }

  if (!VALID_CATEGORIES.has(manifest.category)) {
    errors.push(`category: must be one of ${Array.from(VALID_CATEGORIES).join(", ")}, got: "${manifest.category}"`);
  }

  if (!VALID_TIERS.has(manifest.tier)) {
    errors.push(`tier: must be one of ${Array.from(VALID_TIERS).join(", ")}, got: "${manifest.tier}"`);
  }

  // Target: code (default) or url. URL categories require url field.
  const targetType = manifest.target || (manifest.category && manifest.category.startsWith("url-") ? "url" : "code");
  if (!VALID_TARGET_TYPES.has(targetType)) {
    errors.push(`target: must be one of ${Array.from(VALID_TARGET_TYPES).join(", ")}, got: "${targetType}"`);
  }
  if (targetType === "url") {
    if (typeof manifest.url !== "string" || !/^https?:\/\//.test(manifest.url)) {
      errors.push(`url: must be a http(s) URL when target=url`);
    }
  }

  if (manifest.expected && typeof manifest.expected === "object") {
    const e = manifest.expected;
    const checkBounds = (label, spec) => {
      for (const [mod, b] of Object.entries(spec || {})) {
        if (!b || typeof b !== "object") {
          errors.push(`expected.${label}.${mod}: must be an object`);
          continue;
        }
        if (b.atLeast !== undefined && (!Number.isInteger(b.atLeast) || b.atLeast < 0)) {
          errors.push(`expected.${label}.${mod}.atLeast: must be a non-negative integer`);
        }
        if (b.atMost !== undefined && (!Number.isInteger(b.atMost) || b.atMost < 0)) {
          errors.push(`expected.${label}.${mod}.atMost: must be a non-negative integer`);
        }
        if (b.atLeast !== undefined && b.atMost !== undefined && b.atLeast > b.atMost) {
          errors.push(`expected.${label}.${mod}: atLeast (${b.atLeast}) > atMost (${b.atMost})`);
        }
      }
    };
    checkBounds("errors", e.errors);
    checkBounds("warnings", e.warnings);
    if (e.totalErrorsAtLeast !== undefined && (!Number.isInteger(e.totalErrorsAtLeast) || e.totalErrorsAtLeast < 0)) {
      errors.push("expected.totalErrorsAtLeast: must be a non-negative integer");
    }
    if (e.totalErrorsAtMost !== undefined && (!Number.isInteger(e.totalErrorsAtMost) || e.totalErrorsAtMost < 0)) {
      errors.push("expected.totalErrorsAtMost: must be a non-negative integer");
    }
  } else if (manifest.expected !== undefined) {
    errors.push("expected: must be an object when present");
  }

  if (manifest.budgets && typeof manifest.budgets === "object") {
    const b = manifest.budgets;
    if (b.maxDurationMs !== undefined && (typeof b.maxDurationMs !== "number" || b.maxDurationMs <= 0)) {
      errors.push("budgets.maxDurationMs: must be a positive number");
    }
    if (b.maxMemoryMb !== undefined && (typeof b.maxMemoryMb !== "number" || b.maxMemoryMb <= 0)) {
      errors.push("budgets.maxMemoryMb: must be a positive number");
    }
    if (b.deterministic !== undefined && typeof b.deterministic !== "boolean") {
      errors.push("budgets.deterministic: must be a boolean");
    }
  } else if (manifest.budgets !== undefined) {
    errors.push("budgets: must be an object when present");
  }

  if (manifest.labels !== undefined && !Array.isArray(manifest.labels)) {
    errors.push("labels: must be an array of strings");
  } else if (Array.isArray(manifest.labels)) {
    for (const l of manifest.labels) {
      if (typeof l !== "string") {
        errors.push("labels: every entry must be a string");
        break;
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Normalise a manifest — fill in defaults for omitted optional fields.
 * Caller should validate FIRST; normaliseManifest assumes a valid input
 * (it does not re-validate).
 */
function normaliseManifest(manifest) {
  const targetType = manifest.target || (manifest.category && manifest.category.startsWith("url-") ? "url" : "code");
  return {
    name: manifest.name,
    category: manifest.category,
    tier: manifest.tier,
    target: targetType,
    url: targetType === "url" ? manifest.url : null,
    description: manifest.description || "",
    expected: {
      errors: manifest.expected?.errors || {},
      warnings: manifest.expected?.warnings || {},
      totalErrorsAtLeast: manifest.expected?.totalErrorsAtLeast ?? null,
      totalErrorsAtMost: manifest.expected?.totalErrorsAtMost ?? null,
    },
    budgets: {
      maxDurationMs: manifest.budgets?.maxDurationMs ?? 60_000,
      maxMemoryMb: manifest.budgets?.maxMemoryMb ?? 2048,
      deterministic: manifest.budgets?.deterministic ?? true,
    },
    labels: Array.isArray(manifest.labels) ? manifest.labels.slice() : [],
    source: manifest.source || "hand-crafted",
    createdAt: manifest.createdAt || null,
  };
}

/**
 * Compare a single CaseResult against its manifest expectations and
 * return a list of bound violations. Empty array = case passes.
 *
 * @param {object} manifest    normalised manifest
 * @param {object} caseResult  { findingsByModule: { mod: { errors: n, warnings: n } }, totals: {...} }
 * @returns {string[]}         human-readable violation messages
 */
function compareToExpected(manifest, caseResult) {
  const issues = [];
  const totals = caseResult.totals || { errors: 0, warnings: 0 };
  const byMod = caseResult.findingsByModule || {};

  if (manifest.expected.totalErrorsAtLeast !== null && totals.errors < manifest.expected.totalErrorsAtLeast) {
    issues.push(`total errors ${totals.errors} < expected atLeast ${manifest.expected.totalErrorsAtLeast}`);
  }
  if (manifest.expected.totalErrorsAtMost !== null && totals.errors > manifest.expected.totalErrorsAtMost) {
    issues.push(`total errors ${totals.errors} > expected atMost ${manifest.expected.totalErrorsAtMost}`);
  }

  const checkModule = (label, expectedMap) => {
    for (const [mod, bounds] of Object.entries(expectedMap)) {
      const actualCount = byMod[mod] && byMod[mod][label] ? byMod[mod][label] : 0;
      if (bounds.atLeast !== undefined && actualCount < bounds.atLeast) {
        issues.push(`${mod}.${label} ${actualCount} < atLeast ${bounds.atLeast}`);
      }
      if (bounds.atMost !== undefined && actualCount > bounds.atMost) {
        issues.push(`${mod}.${label} ${actualCount} > atMost ${bounds.atMost}`);
      }
    }
  };
  checkModule("errors", manifest.expected.errors);
  checkModule("warnings", manifest.expected.warnings);

  // known-good cases must produce zero errors regardless of module bounds
  if (manifest.category === "known-good" && totals.errors > 0) {
    issues.push(`known-good corpus must produce 0 errors, got ${totals.errors}`);
  }

  // Budget overruns
  if (caseResult.durationMs > manifest.budgets.maxDurationMs) {
    issues.push(`duration ${caseResult.durationMs}ms > budget ${manifest.budgets.maxDurationMs}ms`);
  }
  if (caseResult.peakMemoryMb && caseResult.peakMemoryMb > manifest.budgets.maxMemoryMb) {
    issues.push(`memory ${caseResult.peakMemoryMb.toFixed(1)}MB > budget ${manifest.budgets.maxMemoryMb}MB`);
  }

  return issues;
}

module.exports = {
  validateManifest,
  normaliseManifest,
  compareToExpected,
  VALID_CATEGORIES,
  VALID_TIERS,
  VALID_TARGET_TYPES,
};
