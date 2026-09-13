/**
 * Engine dispatch — ONE place that decides which engine runs for a tier.
 *
 * Before 2026-08-18 only /api/scan/run bridged to the real 121-module CLI
 * engine (via cli-engine-runner.js). scan-executor.runScan — the path behind
 * the worker tick (every GitHub App / Gluecron push, every Continuous
 * subscriber), the Stripe webhook (every paid one-time scan bought through
 * checkout) and /api/v1/scan — ran the 23-module in-memory `runTier` on a
 * 50-file sample. The Marketplace listing promised "121 modules on every
 * push"; the worker ran four. This module closes that gap by construction:
 * every hosted scan path calls `runEngineForTier`, so there is no second
 * place for the decision to drift.
 *
 * Tiers → engine:
 *   quick                 → CLI engine, `quick` suite — the free preview and the
 *                           $29 Quick Scan. Until 2026-09-13 this was the
 *                           in-memory runTier, which judged expressjs/express's
 *                           config-only `.npmrc` a committed credential (a
 *                           blocking error) while the CLI passed the same repo
 *                           with 0 blocking findings. The first repo a prospect
 *                           tries must be judged by the engine the /precision
 *                           page measures, not by a second scanner.
 *   quick_shadow          → in-memory runTier (the redacted upsell preview wired
 *                           to runTier's MODULES map)
 *   deterministic         → CLI engine, `full` suite, Anthropic-calling modules
 *                           skipped (every-push scans: unlimited, zero AI spend)
 *   full, scan_fix        → CLI engine, `full` suite
 *   nuclear               → CLI engine, `nuclear` suite
 *
 * `GATETEST_DISABLE_CLI_ENGINE=1` forces runTier everywhere (emergency lever);
 * a CLI crash or empty materialisation also falls back to runTier so the
 * customer gets honest partial coverage rather than nothing.
 */

import { runTier, type RepoFile, type ModuleResultEnvelope } from "./scan-modules";
import { TIERS } from "./checkout-tiers";

/** Registry names of every scan module that spends Anthropic budget. Kept
 *  here (not hand-listed per caller) so the deterministic tier cannot leak
 *  AI spend when a new AI module is added — extend THIS list. */
export const AI_ENGINE_MODULES: readonly string[] = [
  "aiReview",
  "agentic",
  "architectureDrift",
  "fakeFixDetector",
  "intentVerification",
  "regressionPredictor",
];

export const CLI_ENGINE_TIERS: ReadonlySet<string> = new Set(["quick", "deterministic", "full", "scan_fix", "nuclear"]);

export interface EngineDispatchInput {
  tier: string;
  owner: string;
  repo: string;
  files: string[];
  fileContents: RepoFile[];
  token?: string;
  deadlineMs?: number;
}

export interface RankedFinding {
  id: string;
  module: string;
  rule: string;
  severity: "error" | "warning" | "info";
  confidence: number;
  blocking: boolean;
  file: string | null;
  line: number | null;
  message: string;
  suggestion: string | null;
  class: string | null;
  duplicateOf: string | null;
}

export interface FindingSummary {
  total: number;
  blocking: number;
  softErrors: number;
  warnings: number;
  info: number;
  duplicatesCollapsed: number;
  hiddenLowConfidence: number;
}

export interface EngineDispatchResult {
  modules: ModuleResultEnvelope[];
  totalIssues: number;
  engineUsed: "cli" | "runTier";
  engineMeta?: Record<string, unknown>;
  /** ranked + deduped (CLI engine only; the in-memory runTier has no registry) */
  findings?: RankedFinding[];
  findingSummary?: FindingSummary | null;
}

interface CliEngineRunner {
  runFullEngine: (opts: {
    fileContents: RepoFile[];
    suite: string;
    deadlineMs?: number;
    skipModules?: string[];
  }) => Promise<{
    modules: ModuleResultEnvelope[];
    totalIssues: number;
    duration: number;
    engine: string;
    engineMeta?: Record<string, unknown>;
    findings?: RankedFinding[];
    findingSummary?: FindingSummary | null;
  }>;
}

export function engineSuiteForTier(tier: string): string {
  // "scan_fix" is a pricing tier with no matching engine suite — getSuite()
  // silently falls back to the smaller "standard" suite for unknown names,
  // which once gave a $199 customer a SHALLOWER scan than a $99 one.
  if (tier === "nuclear") return "nuclear";
  if (tier === "quick") return "quick";
  return "full";
}

/**
 * The modules a tier is SOLD as, from the checkout tier table (one
 * definition, imported): "syntax, lint, secrets, codeQuality" for Quick.
 * `null` for tiers sold as "all-applicable" — the suite decides.
 */
export function tierModuleAllowList(tier: string): string[] | null {
  const spec = TIERS[tier]?.modules;
  if (!spec || spec.startsWith("all-")) return null;
  return spec.split(",").map((s) => s.trim()).filter(Boolean);
}

/** The engine's own suite table (src/core/config.js), or null off-engine. */
function engineSuite(name: string): string[] | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loadSuites } = require("./module-suites") as { loadSuites: () => Record<string, string[]> | null };
    const suites = loadSuites();
    return suites && Array.isArray(suites[name]) ? suites[name] : null;
  } catch {
    return null;
  }
}

export function skipModulesForTier(tier: string): string[] {
  if (tier === "quick") {
    // The engine's quick suite is wider than the four modules the $29 tier
    // is sold as. What a tier includes is a pricing decision (Boss Rule #3),
    // so the engine runs exactly the advertised modules: everything else in
    // the suite is skipped. Widen TIERS.quick.modules and this follows.
    const allow = tierModuleAllowList("quick");
    const suite = engineSuite("quick");
    if (!allow || !suite) return [];
    const keep = new Set(allow);
    return suite.filter((m) => !keep.has(m));
  }
  return tier === "deterministic" ? [...AI_ENGINE_MODULES] : [];
}

/**
 * The modules the HOSTED engine will actually run for a tier: the suite,
 * minus the tier's skip list, minus the modules the host refuses to execute
 * (cli-engine-runner.js HOSTED_UNSAFE_MODULES). Rendered by the preview
 * page and GET /api/scan/preview so the copy cannot drift from the run.
 * `null` when the engine is not on disk.
 */
export function hostedModulesForTier(tier: string): string[] | null {
  const suite = engineSuite(engineSuiteForTier(tier));
  if (!suite) return null;
  let unsafe: Set<string>;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { HOSTED_UNSAFE_MODULES } = require("./cli-engine-runner") as { HOSTED_UNSAFE_MODULES: string[] };
    unsafe = new Set(HOSTED_UNSAFE_MODULES);
  } catch {
    unsafe = new Set();
  }
  const skip = new Set(skipModulesForTier(tier));
  return suite.filter((m) => !skip.has(m) && !unsafe.has(m));
}

export async function runEngineForTier(input: EngineDispatchInput): Promise<EngineDispatchResult> {
  const { tier, owner, repo, files, fileContents, token, deadlineMs } = input;
  const cliEnabled = process.env.GATETEST_DISABLE_CLI_ENGINE !== "1" && CLI_ENGINE_TIERS.has(tier);

  if (cliEnabled) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { runFullEngine } = require("./cli-engine-runner") as CliEngineRunner;
      const cliResult = await runFullEngine({
        fileContents,
        suite: engineSuiteForTier(tier),
        deadlineMs,
        skipModules: skipModulesForTier(tier),
      });
      if (cliResult.modules.length > 0) {
        return {
          modules: cliResult.modules,
          totalIssues: cliResult.totalIssues,
          engineUsed: "cli",
          engineMeta: cliResult.engineMeta,
          findings: cliResult.findings || [],
          findingSummary: cliResult.findingSummary || null,
        };
      }
      // eslint-disable-next-line no-console
      console.warn(`[engine-dispatch] CLI engine returned 0 modules for ${owner}/${repo} (${tier}) — falling back to runTier`, cliResult.engineMeta || {});
    } catch (err) { // error-ok — deliberate degradation: a CLI-engine crash falls back to the in-memory runTier below so the customer gets honest partial coverage, never nothing
      // eslint-disable-next-line no-console
      console.error(`[engine-dispatch] CLI engine crashed for ${owner}/${repo} (${tier}), falling back to runTier:`, err instanceof Error ? err.message : String(err));
    }
  }

  const fallback = await runTier(tier, { owner, repo, files, fileContents, token, deadlineMs });
  return { modules: fallback.modules, totalIssues: fallback.totalIssues, engineUsed: "runTier" };
}
