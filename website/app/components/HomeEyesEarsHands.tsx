/**
 * <HomeEyesEarsHands> — the MCP tools section: what GateTest adds to an AI
 * coding agent, in plain language (Craig 2026-07-14: no metaphor-only copy).
 *
 * SCREENSHOTS        — capture_screenshot: the agent sees the rendered page
 * PRODUCTION ERRORS  — get_production_errors / run_live_checks: real errors, not guesses
 * FIX VERIFICATION   — verify_fix: a hard pass/fail re-scan proves the fix worked
 */

import { TOOL_COUNT } from "../mcp/tools-data";

const CAPABILITIES = [
  {
    id: "screenshots",
    emoji: "🖥️",
    label: "SCREENSHOTS",
    color: "text-emerald-400",
    borderColor: "border-emerald-500/30",
    bgGlow: "bg-emerald-500/5",
    problem: "AI agents write UI they never actually see.",
    solution:
      "capture_screenshot returns a real JPEG/PNG of the rendered page — nav, layout, font sizes, broken CTAs — so the AI reviews its work exactly like a developer looking at a browser tab.",
    tool: "capture_screenshot",
    code: `// See the rendered page — works with localhost too
capture_screenshot({
  url: "http://localhost:3000/pricing",
  width: 390  // mobile viewport
})
// → returns an actual image the AI can see`,
    when: "after every UI change",
  },
  {
    id: "production-errors",
    emoji: "🚨",
    label: "PRODUCTION ERRORS",
    color: "text-amber-400",
    borderColor: "border-amber-500/30",
    bgGlow: "bg-amber-500/5",
    problem: "AI agents guess what's broken instead of reading the real errors.",
    solution:
      "get_production_errors pulls your top errors from Sentry, Datadog, or Rollbar with file:line attribution. run_live_checks catches JS errors, console warnings, API timeouts, and CSP violations on any live URL — including localhost.",
    tool: "get_production_errors",
    code: `// Fix what production says is broken, first
get_production_errors({ source: "all" })
// → TypeError: cart is undefined | src/checkout.ts:44 | 412 occurrences

// Or check your local dev server right now
run_live_checks({ url: "http://localhost:3000" })
// → apiHealth: 2 broken, runtimeErrors: CSP violation on /dashboard`,
    when: "before deciding what to fix",
  },
  {
    id: "fix-verification",
    emoji: "✅",
    label: "FIX VERIFICATION",
    color: "text-blue-400",
    borderColor: "border-blue-500/30",
    bgGlow: "bg-blue-500/5",
    problem: "AI agents claim “fixed” without re-checking anything.",
    solution:
      "verify_fix picks the scan modules relevant to your changed files, re-runs them in-process, and returns a hard ✅/❌ scoped to exactly what was edited. No assumptions — proof.",
    tool: "verify_fix",
    code: `// After editing — prove it actually worked
verify_fix({
  path: "/your/project",
  files: ["src/auth/session.ts"]  // exactly what you edited
})
// ✅ FIX VERIFIED — 0 error-severity findings remain
// ❌ NOT VERIFIED — secrets: hardcoded key still at line 14`,
    when: "after every code edit",
  },
];

export default function HomeEyesEarsHands() {
  return (
    <section
      id="mcp-tools"
      className="py-24 px-6 border-t border-border bg-background"
    >
      <div className="mx-auto max-w-6xl">
        {/* Heading */}
        <div className="text-center mb-14">
          <span className="text-sm font-semibold text-accent uppercase tracking-wider">
            MCP tools for AI agents
          </span>
          <h2 className="text-3xl sm:text-4xl font-bold mt-4 mb-4 text-foreground">
            <span className="text-emerald-400">Screenshot the page.</span>{" "}
            <span className="text-amber-400">Read the real errors.</span>{" "}
            <span className="text-blue-400">Prove the fix.</span>
          </h2>
          <p className="text-muted text-lg max-w-3xl mx-auto">
            GateTest plugs into Claude Code, Cursor, Windsurf, and any
            MCP-compatible agent over one connection — {TOOL_COUNT} tools
            covering the full 120-module scan engine, live-page screenshots,
            production error feeds, test runs, and a pass/fail re-scan that
            proves a fix actually worked.
          </p>
        </div>

        {/* Three capability cards */}
        <div className="grid md:grid-cols-3 gap-6 mb-14">
          {CAPABILITIES.map((cap) => (
            <div
              key={cap.id}
              className={`rounded-2xl border ${cap.borderColor} ${cap.bgGlow} p-6 flex flex-col`}
            >
              {/* Badge */}
              <div className="flex items-center gap-2 mb-4">
                <span className="text-2xl" aria-hidden="true">
                  {cap.emoji}
                </span>
                <span
                  className={`text-xs font-bold uppercase tracking-widest ${cap.color}`}
                >
                  {cap.label}
                </span>
              </div>

              {/* Problem */}
              <p className="text-sm text-muted line-through mb-3 leading-relaxed">
                {cap.problem}
              </p>

              {/* Solution */}
              <p className="text-sm text-foreground/90 leading-relaxed mb-5">
                {cap.solution}
              </p>

              {/* Code block */}
              <div className="mt-auto">
                <pre className="rounded-xl bg-surface-solid border border-border text-xs font-mono text-foreground/80 p-4 overflow-x-auto leading-relaxed whitespace-pre">
                  {cap.code}
                </pre>
                <p className="mt-3 text-xs text-muted">
                  <span className={`font-semibold ${cap.color}`}>
                    Use {cap.when}
                  </span>
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* Install strip */}
        <div className="rounded-2xl border border-border bg-surface-solid p-8 flex flex-col sm:flex-row items-start sm:items-center gap-6">
          <div className="flex-1">
            <h3 className="text-lg font-bold text-foreground mb-1">
              Add to Claude Code in 30 seconds
            </h3>
            <p className="text-sm text-muted">
              Works with any MCP-compatible AI — Claude Code, Cursor, Windsurf,
              Continue, Cline. No account, no webhook, no infra. The engine
              runs in-process on your local filesystem.
            </p>
          </div>
          <div className="flex-shrink-0 w-full sm:w-auto">
            <pre className="rounded-xl bg-background border border-border text-xs font-mono text-foreground/90 px-5 py-3 overflow-x-auto">
              <span className="text-muted select-none">$ </span>
              claude mcp add gatetest -- npx @gatetest/cli --mcp
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
}
