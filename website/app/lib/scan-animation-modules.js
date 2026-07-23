/**
 * Module names shown by /api/scan/status's while-scanning progress
 * animation. These MUST be the modules the paid scan actually runs —
 * before 2026-07-23 the animation showed an invented 18-name list that
 * included modules the website scan never runs (mutation) and fabricated
 * per-module check counts (`5 + i*3`), contradicting the honesty standard
 * the rest of the product holds (KI #61).
 *
 * quick: the 4-module quick tier (matches TIERS.quick / runTier).
 * full:  the real `full` suite from src/core/config.js MINUS mutation +
 *        chaos, which cli-engine-runner.js skips on website scans (KI #55).
 *
 * Plain CJS so tests/scan-animation-honesty.test.js can require() it and
 * diff it against the engine's real suite list — drift fails the suite.
 */

const QUICK_ANIMATION_MODULES = ["syntax", "lint", "secrets", "codeQuality"];

const FULL_ANIMATION_MODULES = [
  "memory", "syntax", "lint", "secrets", "codeQuality", "unitTests",
  "integrationTests", "e2e", "visual", "accessibility", "performance",
  "security", "seo", "links", "compatibility", "dataIntegrity",
  "documentation", "dependencies", "sbom", "dockerfile", "ciSecurity",
  "shell", "sqlMigrations", "terraform", "kubernetes", "promptSafety",
  "deadCode", "secretRotation", "webHeaders", "typescriptStrictness",
  "undefinedRef", "flakyTests", "errorSwallow", "nPlusOne", "retryHygiene",
  "raceCondition", "resourceLeak", "ssrf", "hardcodedUrl", "envVars",
  "asyncIteration", "homoglyph", "openapiDrift", "prSize", "prQuality",
  "redos", "cronExpression", "datetimeBug", "importCycle", "moneyFloat",
  "logPii", "featureFlag", "tlsSecurity", "cookieSecurity", "crossFileTaint",
  "python", "go", "rust", "java", "ruby", "php", "csharp", "kotlin",
  "swift", "aiReview", "agentic", "fakeFixDetector", "claudeCompliance",
  "aiHallucination", "authBypass", "bashSafety", "bundleSize",
  "cacheHeaders", "ciParamValidator", "deployContract", "deployReadiness",
  "deployScriptValidator", "duplicateCode", "envIntegrity",
  "monorepoConstraints", "nativeBundlerGuard", "rollbackHonesty",
  "serviceConsistency", "systemd", "trpcContract", "webhookPayload",
  "zodSchemaPresence",
];

module.exports = { QUICK_ANIMATION_MODULES, FULL_ANIMATION_MODULES };
