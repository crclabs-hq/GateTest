import type { Metadata } from "next";
import McpCheckoutButton from "./McpCheckoutButton";
import { ALL_TOOLS, TOOL_COUNT } from "./tools-data";

export const metadata: Metadata = {
  title: "GateTest MCP — The 120-Module Engine in Your Editor | $29/mo",
  description:
    "The full 120-module GateTest engine inside Claude Code, Cursor, and any MCP-compatible AI. Scan, screenshot live pages, pull production errors, run tests, query your DB — and prove fixes worked.",
  openGraph: {
    title: "GateTest MCP — The 120-Module Engine in Your Editor",
    description:
      `Give Claude eyes, ears & hands: all 120 scan modules plus live-page screenshots (eyes), Sentry/Datadog/Rollbar errors (ears), and a pass/fail re-scan that proves each fix (hands). ${TOOL_COUNT} tools. $29/mo.`,
    url: "https://gatetest.ai/mcp",
  },
};

const FAQ = [
  {
    q: "What's free without a key?",
    a: "check_health, list_modules, get_badge, scan_url, and scan_local with the quick suite (41 modules — syntax, lint, secrets, codeQuality, and more, runs in seconds). Everything else requires a key.",
  },
  {
    q: "How do I get my API key?",
    a: "Subscribe below. Your key (format: gtmcp_xxx) is emailed to you within seconds of checkout completing.",
  },
  {
    q: "How do I add it to Claude Code?",
    a: "Run: claude mcp add gatetest -e GATETEST_API_KEY=gtmcp_xxx -- npx -y @gatetest/mcp-server\nOr set GATETEST_API_KEY in your MCP server config environment.",
  },
  {
    q: "Does the key expire?",
    a: "Your key is valid as long as your subscription is active. Cancel anytime — the key stops working at the end of your billing period.",
  },
  {
    q: "Can I use it with Cursor, Windsurf, or other MCP clients?",
    a: "Yes. GateTest MCP follows the MCP spec — any client that supports stdio transport works. Set GATETEST_API_KEY in the environment for that server.",
  },
  {
    q: "Which AI model runs my fixes — and who pays for it?",
    a: "You choose, and you pay Anthropic directly (bring-your-own-key). AI fixes run on YOUR ANTHROPIC_API_KEY — calls go straight from your machine to Anthropic, never through our servers, and you control the spend. Pick the model per call: sonnet (Claude Sonnet 5, default — fast and cheapest), opus (Opus 4.8 — deeper reasoning), or fable (Fable 5 — the most capable model Anthropic ships, ~3.3x Sonnet cost). No other QA tool lets you do this.",
  },
];

export default function McpPage() {
  return (
    <main className="min-h-screen bg-neutral-950 text-white">
      {/* Hero */}
      <section className="relative max-w-5xl mx-auto px-6 pt-24 pb-16 text-center">
        <div className="inline-flex items-center gap-2 bg-blue-500/10 border border-blue-500/30 rounded-full px-4 py-1.5 text-blue-400 text-xs font-semibold tracking-wider mb-6 uppercase">
          MCP Integration
        </div>
        <h1 className="text-5xl font-black tracking-tight mb-4 leading-tight">
          Give Claude{" "}
          <span className="text-blue-400">eyes</span>,{" "}
          <span className="text-emerald-400">ears</span>{" "}
          &amp;{" "}
          <span className="text-violet-400">hands</span>
        </h1>
        <p className="text-neutral-400 text-lg max-w-2xl mx-auto mb-8">
          The full <span className="text-white font-semibold">120-module scanner</span> inside your AI
          assistant — plus {TOOL_COUNT} tools that let it{" "}
          <span className="text-blue-400">see</span> the rendered page,{" "}
          <span className="text-emerald-400">hear</span> what&apos;s breaking in production, and{" "}
          <span className="text-violet-400">prove</span> each fix worked. Claude Code, Cursor,
          Windsurf, any MCP agent.
        </p>

        {/* Price + CTA */}
        <div className="flex flex-col items-center gap-4">
          <div className="flex items-baseline gap-2">
            <span className="text-5xl font-black text-blue-400">$29</span>
            <span className="text-neutral-500 text-sm">/ month</span>
          </div>
          <McpCheckoutButton label="Subscribe — $29/mo →" />
          <p className="text-neutral-500 text-xs">Cancel anytime · API key emailed instantly</p>
        </div>

        {/* Install snippet */}
        <div className="mt-10 bg-neutral-900 border border-neutral-800 rounded-xl p-4 text-left max-w-2xl mx-auto">
          <p className="text-neutral-500 text-xs mb-2 font-mono uppercase tracking-wider">After subscribing</p>
          <pre className="text-emerald-300 text-sm font-mono overflow-x-auto whitespace-pre-wrap break-all">
{`claude mcp add gatetest \\
  -e GATETEST_API_KEY=gtmcp_xxx \\
  -- npx -y @gatetest/mcp-server`}
          </pre>
        </div>
      </section>

      {/* Install paths — every environment */}
      <section className="max-w-5xl mx-auto px-6 py-12">
        <h2 className="text-2xl font-bold mb-2 text-center">Install anywhere — 30 seconds, any environment</h2>
        <p className="text-neutral-500 text-sm text-center mb-8">
          No terminal? No npm? No problem. The hosted endpoint reaches every Claude user.
        </p>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
            <h3 className="font-semibold text-neutral-200 mb-1">claude.ai web &amp; mobile <span className="text-emerald-400 text-xs font-normal ml-1">zero install</span></h3>
            <p className="text-neutral-500 text-xs mb-3">Settings → Connectors → Add custom connector</p>
            <pre className="text-emerald-300 text-xs font-mono bg-neutral-950 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all">
{`URL: https://gatetest.ai/api/mcp`}
            </pre>
          </div>
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
            <h3 className="font-semibold text-neutral-200 mb-1">Claude Desktop App <span className="text-emerald-400 text-xs font-normal ml-1">one-click</span></h3>
            <p className="text-neutral-500 text-xs mb-3">Download the extension, double-click it — done</p>
            <a
              href="https://github.com/crclabs-hq/GateTest/releases/download/v1.1.3/gatetest.mcpb"
              className="inline-block bg-emerald-500/10 border border-emerald-500/40 hover:bg-emerald-500/20 text-emerald-300 text-sm font-semibold rounded-lg px-4 py-2 mb-3 transition-colors"
            >
              ⬇ Download gatetest.mcpb
            </a>
            <p className="text-neutral-600 text-xs">
              Or paste into Settings → Developer → Edit Config:{" "}
              <span className="font-mono text-neutral-500 break-all">{`{ "mcpServers": { "gatetest": { "url": "https://gatetest.ai/api/mcp" } } }`}</span>
            </p>
          </div>
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
            <h3 className="font-semibold text-neutral-200 mb-1">Claude Code CLI <span className="text-blue-400 text-xs font-normal ml-1">full {TOOL_COUNT} tools</span></h3>
            <p className="text-neutral-500 text-xs mb-3">Local install — unlocks scan_local, run_tests, query_db, stream_logs</p>
            <pre className="text-emerald-300 text-xs font-mono bg-neutral-950 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all">
{`claude mcp add gatetest -- npx -y @gatetest/mcp-server`}
            </pre>
          </div>
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
            <h3 className="font-semibold text-neutral-200 mb-1">Cursor / Windsurf / Cline / Zed</h3>
            <p className="text-neutral-500 text-xs mb-3">MCP settings → Add server (URL or command, both work)</p>
            <pre className="text-emerald-300 text-xs font-mono bg-neutral-950 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all">
{`https://gatetest.ai/api/mcp`}
            </pre>
          </div>
        </div>
        <p className="text-neutral-600 text-xs text-center mt-4">
          Hosted endpoint: free tools work with no key; add <span className="font-mono">Authorization: Bearer gtmcp_...</span> to unlock premium.
          Filesystem tools (scan_local, run_tests, query_db, stream_logs, http_request) need the local install.
        </p>
      </section>

      {/* Tool table */}
      <section className="max-w-5xl mx-auto px-6 py-12">
        <h2 className="text-2xl font-bold mb-6 text-center">{TOOL_COUNT} tools — what&apos;s free vs paid</h2>
        <div className="rounded-xl border border-neutral-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-neutral-900 border-b border-neutral-800">
                <th className="text-left px-4 py-3 text-neutral-400 font-semibold">Tool</th>
                <th className="text-left px-4 py-3 text-neutral-400 font-semibold">What it does</th>
                <th className="text-center px-4 py-3 text-neutral-400 font-semibold">Access</th>
              </tr>
            </thead>
            <tbody>
              {ALL_TOOLS.map((tool, i) => (
                <tr
                  key={i}
                  className={`border-b border-neutral-800/50 ${i % 2 === 0 ? "bg-neutral-950" : "bg-neutral-900/30"}`}
                >
                  <td className="px-4 py-3 font-mono text-neutral-200 whitespace-nowrap">{tool.name}</td>
                  <td className="px-4 py-3 text-neutral-400">{tool.desc}</td>
                  <td className="px-4 py-3 text-center">
                    {tool.paid ? (
                      <span className="inline-flex items-center gap-1 bg-blue-500/10 text-blue-400 border border-blue-500/30 rounded-full px-2.5 py-0.5 text-xs font-semibold">
                        🔒 $29/mo
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 rounded-full px-2.5 py-0.5 text-xs font-semibold">
                        FREE
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Value props */}
      <section className="max-w-5xl mx-auto px-6 py-12">
        <div className="grid md:grid-cols-3 gap-6">
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6">
            <div className="text-3xl mb-3">👁</div>
            <div className="text-[11px] font-bold uppercase tracking-widest text-blue-400 mb-1">Eyes</div>
            <h3 className="font-bold text-lg mb-2 text-white">See the rendered page</h3>
            <p className="text-neutral-400 text-sm">
              <strong className="text-neutral-200">capture_screenshot</strong> — see what the rendered page actually looks like. Works on localhost, staging, and production.
              <br /><br />
              <strong className="text-neutral-200">get_visual_diff</strong> — baseline vs current comparison so Claude spots regressions before you do.
            </p>
          </div>
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6">
            <div className="text-3xl mb-3">👂</div>
            <div className="text-[11px] font-bold uppercase tracking-widest text-emerald-400 mb-1">Ears</div>
            <h3 className="font-bold text-lg mb-2 text-white">Hear what&apos;s breaking</h3>
            <p className="text-neutral-400 text-sm">
              <strong className="text-neutral-200">get_production_errors</strong> — pull your top Sentry, Datadog, or Rollbar errors with file:line attribution so Claude fixes what prod says is broken, first.
              <br /><br />
              <strong className="text-neutral-200">run_live_checks</strong> — runtime error sweep, console warnings, and API health against any URL.
            </p>
          </div>
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6">
            <div className="text-3xl mb-3">🤝</div>
            <div className="text-[11px] font-bold uppercase tracking-widest text-violet-400 mb-1">Hands</div>
            <h3 className="font-bold text-lg mb-2 text-white">Prove the fix worked</h3>
            <p className="text-neutral-400 text-sm">
              <strong className="text-neutral-200">verify_fix</strong> — re-run the relevant modules on changed files. Pass/fail verdict so Claude knows the fix actually worked.
              <br /><br />
              <strong className="text-neutral-200">run_tests</strong> — auto-detect and run Jest, Vitest, pytest, cargo test, or go test. Structured pass/fail per test.
              <br /><br />
              <strong className="text-neutral-200">stream_logs</strong> — tail a running process or log file live for up to 60s while Claude is debugging.
              <br /><br />
              <strong className="text-neutral-200">query_db</strong> — read-only SQL and NoSQL queries (Postgres, MySQL, SQLite, MongoDB, Redis) without leaving the session.
              <br /><br />
              <strong className="text-neutral-200">http_request</strong> — call any API with auth headers, inspect responses, follow redirects. Closes the loop: scan → fix → test → verify → done.
            </p>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="max-w-3xl mx-auto px-6 py-12">
        <h2 className="text-2xl font-bold mb-8 text-center">FAQ</h2>
        <div className="space-y-4">
          {FAQ.map((item, i) => (
            <div key={i} className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
              <p className="font-semibold text-neutral-100 mb-2">{item.q}</p>
              <p className="text-neutral-400 text-sm whitespace-pre-line">{item.a}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Bottom CTA */}
      <section className="max-w-xl mx-auto px-6 py-16 text-center">
        <h2 className="text-3xl font-bold mb-4">Ready?</h2>
        <p className="text-neutral-400 mb-8">Subscribe and your key arrives in seconds.</p>
        <McpCheckoutButton label="Subscribe — $29/mo →" />
        <p className="text-neutral-500 text-xs mt-3">Cancel anytime · API key emailed instantly · Works with Claude Code, Cursor, Windsurf, Cline</p>
      </section>
    </main>
  );
}
