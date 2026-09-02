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
 *   quick, quick_shadow   → in-memory runTier (free funnel: 4 modules, sub-second;
 *                           quick_shadow is the redacted upsell preview wired
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

export const CLI_ENGINE_TIERS: ReadonlySet<string> = new Set(["deterministic", "full", "scan_fix", "nuclear"]);

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
  return "full";
}

export function skipModulesForTier(tier: string): string[] {
  return tier === "deterministic" ? [...AI_ENGINE_MODULES] : [];
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
