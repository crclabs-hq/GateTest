/**
 * Reliability corpus — case runner.
 *
 * Given a manifest + a scanner adapter, run the scan and produce a
 * structured `CaseResult` ready for the drift detector or report
 * renderer to consume.
 *
 * Supports two target types via injectable scanner adapters:
 *
 *   `code`  — scan a directory of source files. Production adapter
 *             invokes the CLI engine (runTier). Tests inject a stub.
 *
 *   `url`   — scan a live URL. Production adapter calls
 *             /api/web/scan (or the engine's URL path). Tests inject
 *             a stub that returns deterministic results.
 *
 * Determinism check
 * -----------------
 * When `manifest.budgets.deterministic === true`, the runner can be
 * asked to run the scan twice (via `repeatForDeterminism: true`) and
 * verify the findings match byte-for-byte. Default is single-run
 * for speed; nightly suite enables the repeat to catch ordering /
 * timing-dependent regressions.
 */

"use strict";

const { normaliseManifest, validateManifest, compareToExpected } = require("./manifest.js");

/**
 * Group raw findings by module → { errors: N, warnings: N }.
 *
 * @param {Array<{module: string, severity: string}>} findings
 * @returns {{ findingsByModule: object, totals: { errors: number, warnings: number, info: number } }}
 */
function tallyFindings(findings) {
  const findingsByModule = {};
  const totals = { errors: 0, warnings: 0, info: 0 };
  for (const f of findings || []) {
    const mod = String(f.module || "unknown");
    const sev = String(f.severity || "info").toLowerCase();
    if (!findingsByModule[mod]) findingsByModule[mod] = { errors: 0, warnings: 0, info: 0 };
    if (sev === "error") {
      findingsByModule[mod].errors += 1;
      totals.errors += 1;
    } else if (sev === "warning") {
      findingsByModule[mod].warnings += 1;
      totals.warnings += 1;
    } else {
      findingsByModule[mod].info += 1;
      totals.info += 1;
    }
  }
  return { findingsByModule, totals };
}

/**
 * Compute a deterministic signature of a findings array so the
 * determinism check can compare runs without false positives from
 * timing fields.
 */
function findingsSignature(findings) {
  const list = (findings || []).map((f) => ({
    module: f.module || "",
    severity: f.severity || "",
    file: f.file || "",
    line: f.line != null ? Number(f.line) : null,
    rule: f.rule || "",
    message: f.message || "",
  }));
  list.sort((a, b) => {
    if (a.module !== b.module) return a.module < b.module ? -1 : 1;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.line !== b.line) return (a.line || 0) - (b.line || 0);
    if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
    return a.message < b.message ? -1 : (a.message > b.message ? 1 : 0);
  });
  return JSON.stringify(list);
}

/**
 * Run a single reliability case.
 *
 * @param {object} args
 * @param {object} args.manifest                manifest object
 * @param {object} args.scanner                 adapter: scanner.scan({ manifest, target }) → { findings, peakMemoryMb? }
 * @param {string} [args.codeRoot]              path to the case dir (for target=code)
 * @param {boolean} [args.repeatForDeterminism] when true and budgets.deterministic, run scan twice and compare
 * @param {function} [args._now]                injectable Date.now for tests
 * @returns {Promise<{
 *   name: string, category: string, tier: string, target: string,
 *   findingsByModule: object, totals: { errors, warnings, info },
 *   durationMs: number, peakMemoryMb: number|null,
 *   deterministic: boolean|null,
 *   passed: boolean, issues: string[],
 *   error?: string,
 * }>}
 */
async function runCase({ manifest, scanner, codeRoot, repeatForDeterminism = false, _now }) {
  const v = validateManifest(manifest);
  if (!v.ok) {
    return {
      name: manifest && manifest.name ? manifest.name : "<invalid>",
      passed: false,
      issues: v.errors,
      error: "invalid-manifest",
    };
  }
  const m = normaliseManifest(manifest);
  if (!scanner || typeof scanner.scan !== "function") {
    return {
      name: m.name,
      passed: false,
      issues: ["scanner adapter missing scan() method"],
      error: "no-scanner",
    };
  }

  const now = _now || (() => Date.now());
  const target = m.target === "url" ? { type: "url", url: m.url } : { type: "code", codeRoot };

  let scanResult;
  const startedAt = now();
  try {
    scanResult = await scanner.scan({ manifest: m, target });
  } catch (err) {
    return {
      name: m.name,
      category: m.category,
      tier: m.tier,
      target: m.target,
      passed: false,
      issues: [`scanner.scan threw: ${err.message || String(err)}`],
      error: "scan-failed",
      durationMs: now() - startedAt,
    };
  }
  const durationMs = now() - startedAt;

  const findings = scanResult.findings || [];
  const { findingsByModule, totals } = tallyFindings(findings);

  const caseResultForCompare = {
    findingsByModule,
    totals,
    durationMs,
    peakMemoryMb: scanResult.peakMemoryMb != null ? scanResult.peakMemoryMb : null,
  };
  const issues = compareToExpected(m, caseResultForCompare);

  let deterministic = null;
  if (repeatForDeterminism && m.budgets.deterministic) {
    try {
      const repeatRes = await scanner.scan({ manifest: m, target });
      const a = findingsSignature(findings);
      const b = findingsSignature(repeatRes.findings);
      deterministic = a === b;
      if (!deterministic) issues.push("non-deterministic: two runs produced different findings");
    } catch (err) {
      issues.push(`deterministic-repeat failed: ${err.message || String(err)}`);
    }
  }

  return {
    name: m.name,
    category: m.category,
    tier: m.tier,
    target: m.target,
    url: m.url || null,
    findingsByModule,
    totals,
    durationMs,
    peakMemoryMb: scanResult.peakMemoryMb != null ? scanResult.peakMemoryMb : null,
    deterministic,
    passed: issues.length === 0,
    issues,
  };
}

/**
 * Run a whole suite of cases. Returns an aggregate report plus per-case
 * results. Continues on individual case failures — we never want one
 * bad case to nuke the whole nightly run.
 */
async function runSuite({ cases, scanner, codeRoots = {}, repeatForDeterminism = false, _now }) {
  const results = [];
  const startedAt = (_now || (() => Date.now()))();
  for (const manifest of cases) {
    const codeRoot = codeRoots[manifest && manifest.name];
    const r = await runCase({ manifest, scanner, codeRoot, repeatForDeterminism, _now });
    results.push(r);
  }
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;
  return {
    total,
    passed,
    failed,
    passRate: total === 0 ? 0 : Number((passed / total).toFixed(4)),
    durationMs: ((_now || (() => Date.now()))()) - startedAt,
    results,
  };
}

module.exports = {
  runCase,
  runSuite,
  tallyFindings,
  findingsSignature,
};
