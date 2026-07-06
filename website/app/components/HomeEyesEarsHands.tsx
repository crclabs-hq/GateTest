/**
 * <HomeEyesEarsHands> — the three capabilities missing from every AI coding agent.
 *
 * EYES   — capture_screenshot: Claude can SEE the rendered page
 * EARS   — get_production_errors / run_live_checks: Claude can HEAR what's breaking
 * HANDS  — verify_fix: Claude can PROVE the fix worked
 *
 * Market angle: people are leaving Claude because it writes UI blind, never
 * hears the app fail, and claims "fixed" without proof. GateTest MCP closes
 * all three gaps over a single stdio connection.
 */

// Illustrative host used in the marketing MCP code snippets below. Extracted
// to a single constant so the example dev-server URLs live in one place; the
// rendered snippet text is byte-for-byte identical to a literal string.
const LOCAL_EXAMPLE = "localhost:3000";

const CAPABILITIES = [
  {
    id: "eyes",
    emoji: "👁",
    label: "EYES",
    color: "text-emerald-400",
    borderColor: "border-emerald-500/30",
    bgGlow: "bg-emerald-500/5",
    problem: "Claude writes UI blind — it can't see what it built.",
    solution: "capture_screenshot returns a real JPEG/PNG image. Claude looks at the rendered page — nav, layout, font sizes, broken CTAs — exactly like a developer reviewing a browser tab.",
    tool: "capture_screenshot",
    code: `// See the rendered page — works with localhost too
capture_screenshot({
  url: "http://${LOCAL_EXAMPLE}/pricing",
  width: 390  // mobile viewport
})
// → returns an actual image block Claude can see`,
    when: "after every UI change",
  },
  {
    id: "ears",
    emoji: "👂",
    label: "EARS",
    color: "text-amber-400",
    borderColor: "border-amber-500/30",
    bgGlow: "bg-amber-500/5",
    problem: "Claude guesses what's broken — it can't hear the running app.",
    solution: "get_production_errors pulls file:line from Sentry/Datadog/Rollbar. run_live_checks hears JS errors, console warnings, API timeouts, and CSP violations against any live URL including localhost.",
    tool: "get_production_errors",
    code: `// Fix what production says is broken, first
get_production_errors({ source: "all" })
// → TypeError: cart is undefined | src/checkout.ts:44 | 412 occurrences

// Or check your local dev server right now
run_live_checks({ url: "http://${LOCAL_EXAMPLE}" })
// → apiHealth: 2 broken, runtimeErrors: CSP violation on /dashboard`,
    when: "before deciding what to fix",
  },
  {
    id: "hands",
    emoji: "🤝",
    label: "HANDS",
    color: "text-blue-400",
    borderColor: "border-blue-500/30",
    bgGlow: "bg-blue-500/5",
    problem: "Claude claims 'fixed' without proof — no re-run, no gate.",
    solution: "verify_fix selects the modules relevant to your changed files, re-runs them in-process, and returns a hard ✅/❌ scoped to exactly what you edited. No assumptions.",
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
      id="eyes-ears-hands"
      className="py-24 px-6 border-t border-border bg-background"
    >
      <div className="mx-auto max-w-6xl">
        {/* Heading */}
        <div className="text-center mb-14">
          <span className="text-sm font-semibold text-accent uppercase tracking-wider">
            MCP tools for AI agents
          </span>
          <h2 className="text-3xl sm:text-4xl font-bold mt-4 mb-4 text-foreground">
            Give Claude{" "}
            <span className="text-emerald-400">Eyes</span>
            {", "}
            <span className="text-amber-400">Ears</span>
            {" & "}
            <span className="text-blue-400">Hands</span>
          </h2>
          <p className="text-muted text-lg max-w-3xl mx-auto">
            AI coding agents write UI blind, never hear the app fail, and claim
            &ldquo;fixed&rdquo; without proof. GateTest MCP closes all three
            gaps — 18 tools, one stdio connection, works in Claude Code, Cursor,
            Windsurf, and any MCP-compatible agent.
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
