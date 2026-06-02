/**
 * Multi-Agent Consensus — runs Claude and GPT-4o on the same fix prompt
 * in parallel, compares the structured outputs, and reports agreement.
 *
 * Use case (Nuclear tier opt-in): for the highest-value fixes, run BOTH
 * frontier models. When they agree, ship with high confidence. When they
 * diverge, surface the diff so the reviewer (or a third agent) decides.
 *
 * Honesty: this is opt-in and Nuclear-only because it ~2x the per-fix
 * Anthropic+OpenAI spend. Margin still holds at $399 (cap ~$30 from
 * budget-tracker; second-agent OpenAI spend bounded by `maxTokens`).
 *
 * Single chokepoint for parsing — `parseFixBlock()` strictly extracts a
 * single ```diff or ```language code block. Anything else counts as
 * "no parseable fix" so we don't pretend to a customer that two free-form
 * essays "agree".
 */

import { openAiCall, isOpenAiConfigured } from "./openai-client";

// Public surface: runConsensus + renderConsensusReport + ConsensusInput +
// ConsensusResult. Internal helpers (parseFixBlock, normaliseFix, etc.) are
// not exported — they're stable enough that test-time monkey-patching isn't
// needed and source-level tests already cover their shape.
type ConsensusAgreement = "full" | "partial" | "disagree" | "single_agent" | "no_parse";

interface AgentResult {
  agent: "claude" | "openai";
  ok: boolean;
  fix: string | null;
  rawText: string;
  rationale: string | null;
  error?: string;
  tokensIn: number;
  tokensOut: number;
}

export interface ConsensusResult {
  agreement: ConsensusAgreement;
  confidence: "high" | "medium" | "low" | "none";
  claude: AgentResult;
  openai: AgentResult;
  mergedFix: string | null;
  differences: string[];
}

export interface ConsensusInput {
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  /** Optional injection of the Claude caller — when omitted, this function
   *  is a pure two-agent orchestrator and Claude is run elsewhere. */
  claudeCall?: () => Promise<{ ok: boolean; text: string; tokensIn: number; tokensOut: number; error?: string }>;
  /** Inject for tests. Defaults to the real openAiCall. */
  openaiCall?: typeof openAiCall;
  openaiModel?: string;
}

const DEFAULT_OPENAI_MODEL = "gpt-4o";

/**
 * Strip a single ```diff / ```ts / ```python / ``` code block out of free
 * text. Returns null if the text has zero or more than one block (we DO
 * NOT silently pick the first — that's how you mis-attribute agreement).
 */
function parseFixBlock(text: string): { fix: string | null; rationale: string | null } {
  if (typeof text !== "string") return { fix: null, rationale: null };
  const fences = [...text.matchAll(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g)];
  if (fences.length === 0) return { fix: null, rationale: text.trim() || null };
  if (fences.length > 1) return { fix: null, rationale: text.trim() || null };
  const fix = fences[0][1].trim();
  // Rationale = everything outside the fence
  const before = text.slice(0, fences[0].index ?? 0).trim();
  const after = text.slice((fences[0].index ?? 0) + fences[0][0].length).trim();
  const rationale = [before, after].filter(Boolean).join("\n\n").trim() || null;
  return { fix, rationale };
}

/**
 * Token-level diff summary: returns up to 5 lines that differ between
 * the two fix blocks. Used to populate `differences` on partial agreement.
 */
function summariseDifferences(a: string, b: string, limit = 5): string[] {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const max = Math.max(aLines.length, bLines.length);
  const diffs: string[] = [];
  for (let i = 0; i < max; i++) {
    if (diffs.length >= limit) break;
    const la = aLines[i] ?? "";
    const lb = bLines[i] ?? "";
    if (la !== lb) {
      diffs.push(`line ${i + 1}: A=\`${truncate(la, 60)}\` ≠ B=\`${truncate(lb, 60)}\``);
    }
  }
  return diffs;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * Normalise a fix block for equality: trim trailing whitespace from each
 * line, drop empty leading/trailing lines, normalise CRLF.
 */
function normaliseFix(fix: string): string {
  return fix
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

function classifyAgreement(
  claude: AgentResult,
  openai: AgentResult,
  differences: string[]
): { agreement: ConsensusAgreement; confidence: ConsensusResult["confidence"] } {
  const cOk = claude.ok && claude.fix !== null;
  const oOk = openai.ok && openai.fix !== null;
  if (!cOk && !oOk) return { agreement: "no_parse", confidence: "none" };
  if (cOk && !oOk) return { agreement: "single_agent", confidence: "medium" };
  if (!cOk && oOk) return { agreement: "single_agent", confidence: "medium" };
  // Both parsed.
  const a = normaliseFix(claude.fix!);
  const b = normaliseFix(openai.fix!);
  if (a === b) return { agreement: "full", confidence: "high" };
  if (differences.length > 0 && differences.length <= 3) {
    return { agreement: "partial", confidence: "medium" };
  }
  return { agreement: "disagree", confidence: "low" };
}

export async function runConsensus(input: ConsensusInput): Promise<ConsensusResult> {
  const openaiCallFn = input.openaiCall ?? openAiCall;
  const openaiModel = input.openaiModel ?? DEFAULT_OPENAI_MODEL;

  // If the caller didn't pass a claudeCall AND OpenAI is unconfigured,
  // we still run the OpenAI side so the failure mode is visible — not a
  // silent "consensus skipped" that drops the customer back to single-agent
  // without telling them.
  const claudePromise: Promise<AgentResult> = input.claudeCall
    ? (async () => {
        try {
          const r = await input.claudeCall!();
          const { fix, rationale } = parseFixBlock(r.text);
          return {
            agent: "claude",
            ok: r.ok,
            fix,
            rawText: r.text,
            rationale,
            error: r.error,
            tokensIn: r.tokensIn,
            tokensOut: r.tokensOut,
          };
        } catch (err) {
          return {
            agent: "claude",
            ok: false,
            fix: null,
            rawText: "",
            rationale: null,
            error: err instanceof Error ? err.message : String(err),
            tokensIn: 0,
            tokensOut: 0,
          };
        }
      })()
    : Promise.resolve<AgentResult>({
        agent: "claude",
        ok: false,
        fix: null,
        rawText: "",
        rationale: null,
        error: "claudeCall not provided",
        tokensIn: 0,
        tokensOut: 0,
      });

  const openaiPromise: Promise<AgentResult> = (async () => {
    if (!isOpenAiConfigured() && input.openaiCall === undefined) {
      return {
        agent: "openai",
        ok: false,
        fix: null,
        rawText: "",
        rationale: null,
        error: "OPENAI_API_KEY not configured",
        tokensIn: 0,
        tokensOut: 0,
      };
    }
    const r = await openaiCallFn({
      model: openaiModel,
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      maxTokens: input.maxTokens,
    });
    const { fix, rationale } = parseFixBlock(r.text);
    return {
      agent: "openai",
      ok: r.ok,
      fix,
      rawText: r.text,
      rationale,
      error: r.rawError,
      tokensIn: r.usage.promptTokens,
      tokensOut: r.usage.completionTokens,
    };
  })();

  const [claude, openai] = await Promise.all([claudePromise, openaiPromise]);

  const differences =
    claude.fix && openai.fix
      ? summariseDifferences(normaliseFix(claude.fix), normaliseFix(openai.fix))
      : [];
  const { agreement, confidence } = classifyAgreement(claude, openai, differences);

  // Pick the "winning" fix:
  //   full      → either is fine, pick claude (deterministic)
  //   partial   → prefer claude (the model with more domain context in this codebase)
  //   single_agent → whichever parsed
  //   disagree / no_parse → null (force human review)
  let mergedFix: string | null = null;
  if (agreement === "full" || agreement === "partial") mergedFix = claude.fix;
  else if (agreement === "single_agent") mergedFix = claude.fix ?? openai.fix;

  return { agreement, confidence, claude, openai, mergedFix, differences };
}

export function renderConsensusReport(result: ConsensusResult): string {
  const lines: string[] = [];
  lines.push("## Multi-Agent Consensus");
  lines.push("");
  const badge = {
    full: "🟢 FULL AGREEMENT",
    partial: "🟡 PARTIAL AGREEMENT",
    disagree: "🔴 DISAGREEMENT",
    single_agent: "🟠 SINGLE AGENT",
    no_parse: "⚪ NO PARSEABLE FIX",
  }[result.agreement];
  lines.push(`**Verdict:** ${badge} · confidence \`${result.confidence}\``);
  lines.push("");
  lines.push(`- Claude: ${result.claude.ok ? "✓" : "✗"} (${result.claude.tokensIn}→${result.claude.tokensOut} tok)${result.claude.error ? ` — ${result.claude.error}` : ""}`);
  lines.push(`- OpenAI: ${result.openai.ok ? "✓" : "✗"} (${result.openai.tokensIn}→${result.openai.tokensOut} tok)${result.openai.error ? ` — ${result.openai.error}` : ""}`);
  if (result.differences.length > 0) {
    lines.push("");
    lines.push("**Divergences:**");
    for (const d of result.differences) lines.push(`- ${d}`);
  }
  if (result.agreement === "disagree" || result.agreement === "no_parse") {
    lines.push("");
    lines.push("Both fixes are included verbatim below. A human reviewer chooses.");
  }
  return lines.join("\n");
}
