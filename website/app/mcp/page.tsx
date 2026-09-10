import type { Metadata } from "next";
import McpCheckoutButton from "./McpCheckoutButton";
import { ALL_TOOLS, TOOL_COUNT } from "./tools-data";
import { TOTAL_MODULES } from "@/app/lib/module-count";
import { SITE_URL } from "@/app/lib/site-url";
import PageHero from "../components/site/PageHero";
import Section from "../components/site/Section";

export const metadata: Metadata = {
  title: "GateTest MCP — Free Local Server, $29/mo Hosted Endpoint",
  description:
    "The full 121-module GateTest engine inside Claude Code, Cursor, and any MCP-compatible AI — 100% free on your own machine. $29/mo adds the hosted endpoint for claude.ai web/mobile plus hosted scan history.",
  openGraph: {
    title: `GateTest MCP — The ${TOTAL_MODULES}-Module Engine in Your Editor`,
    description:
      `Give Claude eyes, ears & hands: all ${TOOL_COUNT} tools — live-page screenshots (eyes), Sentry/Datadog/Rollbar errors (ears), pass/fail fix verification (hands) — free on your machine. $29/mo for the hosted endpoint (claude.ai web/mobile) + hosted history.`,
    url: "/mcp",
  },
};

const FAQ = [
  {
    q: "What's free?",
    a: "The entire local server. Every tool — full-suite scans, screenshots, production errors, run_tests, fix_issue — runs 100% free on your own machine via npx @gatetest/mcp-server (AI tools use your own Anthropic key). The $29/mo key unlocks the HOSTED endpoint: use GateTest from claude.ai web/mobile or locked-down machines where you can't run npm, plus hosted scan history. On the hosted endpoint, check_health, list_modules, get_badge, scan_url, and scan_repo work with no key at all.",
  },
  {
    q: "How do I get my API key?",
    a: "Subscribe below. Your key (format: gtmcp_xxx) is emailed to you within seconds of checkout completing.",
  },
  {
    q: "How do I add it to Claude Code?",
    a: `Free local server (every tool): claude mcp add gatetest -- npx -y @gatetest/mcp-server\nHosted endpoint (claude.ai web/mobile): add ${SITE_URL}/api/mcp as a custom connector, with Authorization: Bearer gtmcp_xxx for the paid tools.`,
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
    a: "You choose, and you pay Anthropic directly (bring-your-own-key). AI fixes run on YOUR ANTHROPIC_API_KEY — calls go straight from your machine to Anthropic, never through our servers, and you control the spend. Pick the model per call: sonnet (Claude Sonnet 5, default — fast and cheapest), opus (Opus 5 — deeper reasoning at half Fable cost), opus-4-8 (Opus 4.8 — previous generation), or fable (Fable 5 — the most capable model Anthropic ships, ~3.3x Sonnet cost). No other QA tool lets you do this.",
  },
];

// Eyes / ears / hands keep their three voices; shades chosen for a light page.
const EYES = "text-sky-600";
const EARS = "text-emerald-600";
const HANDS = "text-violet-600";

const CODE = "rounded-lg bg-panel text-emerald-300 border border-panel-border p-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all";

const INSTALL_PATHS = [
  {
    title: "claude.ai web & mobile",
    tag: "zero install",
    tagClass: EARS,
    hint: "Settings → Connectors → Add custom connector",
    code: `URL: ${SITE_URL}/api/mcp`,
  },
  {
    title: "Claude Code CLI",
    tag: `full ${TOOL_COUNT} tools`,
    tagClass: EYES,
    hint: "Local install — unlocks scan_local, run_tests, query_db, stream_logs",
    code: "claude mcp add gatetest -- npx -y @gatetest/mcp-server",
  },
  {
    title: "Cursor / Windsurf / Cline / Zed",
    tag: "",
    tagClass: "",
    hint: "MCP settings → Add server (URL or command, both work)",
    code: `${SITE_URL}/api/mcp`,
  },
];

const VALUE_PROPS = [
  {
    icon: "👁", label: "Eyes", cls: EYES, title: "See the rendered page",
    items: [
      ["capture_screenshot", "see what the rendered page actually looks like. Works on localhost, staging, and production."],
      ["get_visual_diff", "baseline vs current comparison so Claude spots regressions before you do."],
    ],
  },
  {
    icon: "👂", label: "Ears", cls: EARS, title: "Hear what's breaking",
    items: [
      ["get_production_errors", "pull your top Sentry, Datadog, or Rollbar errors with file:line attribution so Claude fixes what prod says is broken, first."],
      ["run_live_checks", "runtime error sweep, console warnings, and API health against any URL."],
    ],
  },
  {
    icon: "🤝", label: "Hands", cls: HANDS, title: "Prove the fix worked",
    items: [
      ["verify_fix", "re-run the relevant modules on changed files. Pass/fail verdict so Claude knows the fix actually worked."],
      ["run_tests", "auto-detect and run Jest, Vitest, pytest, cargo test, or go test. Structured pass/fail per test."],
      ["stream_logs", "tail a running process or log file live for up to 60s while Claude is debugging."],
      ["query_db", "read-only SQL and NoSQL queries (Postgres, MySQL, SQLite, MongoDB, Redis) without leaving the session."],
      ["http_request", "call any API with auth headers, inspect responses, follow redirects. Closes the loop: scan → fix → test → verify → done."],
    ],
  },
];

export default function McpPage() {
  return (
    <main>
      <PageHero
        eyebrow="MCP Integration"
        title={<>Give Claude <span className={EYES}>eyes</span>, <span className={EARS}>ears</span> &amp; <span className={HANDS}>hands</span></>}
        lede={<>
          The full <span className="text-foreground font-semibold">{TOTAL_MODULES}-module scanner</span> inside your AI
          assistant — plus {TOOL_COUNT} tools that let it{" "}
          <span className={EYES}>see</span> the rendered page,{" "}
          <span className={EARS}>hear</span> what&apos;s breaking in production, and{" "}
          <span className={HANDS}>prove</span> each fix worked.{" "}
          <span className="text-foreground font-semibold">100% free on your own machine</span> — Claude Code,
          Cursor, Windsurf, any MCP agent.
        </>}
        actions={
          <>
            <McpCheckoutButton label="Get the hosted endpoint — $29/mo →" />
            <a href="#install" className="btn-secondary px-6 py-3 text-sm font-semibold rounded-xl">Install free locally</a>
          </>
        }
      >
        {/* Free install first — the local server is the product's front door */}
        <div className="rounded-xl bg-panel text-panel-foreground border border-panel-border overflow-hidden shadow-lg">
          <div className="px-4 py-3 border-b border-panel-border bg-panel-alt">
            <p className="text-emerald-400 text-xs font-mono uppercase tracking-wider">Free · every tool · your machine, your keys</p>
          </div>
          <pre className="p-5 text-emerald-300 text-sm font-mono overflow-x-auto whitespace-pre-wrap break-all">
{`claude mcp add gatetest -- npx -y @gatetest/mcp-server`}
          </pre>
        </div>

        {/* Paid: the hosted endpoint */}
        <div className="card mt-6 p-5">
          <p className="text-muted text-sm">
            Can&apos;t run npm — or want GateTest inside <span className="text-foreground font-semibold">claude.ai on web and mobile</span>?
            The hosted endpoint runs the scans on our infrastructure and keeps your scan history.
          </p>
          <div className="flex items-baseline gap-2 mt-4">
            <span className="font-display text-4xl font-bold text-accent">$29</span>
            <span className="text-muted text-sm">/ month — hosted endpoint</span>
          </div>
          <p className="text-muted text-xs mt-2">Cancel anytime · API key emailed instantly · The local server stays free forever</p>
        </div>
      </PageHero>

      {/* Install paths — every environment */}
      <Section
        id="install"
        title="Install anywhere — 30 seconds, any environment"
        lede="No terminal? No npm? No problem. The hosted endpoint reaches every Claude user."
      >
        <div className="grid md:grid-cols-2 gap-4">
          <div className="card p-5">
            <h3 className="font-semibold text-foreground mb-1">{INSTALL_PATHS[0].title} <span className={`${EARS} text-xs font-normal ml-1`}>{INSTALL_PATHS[0].tag}</span></h3>
            <p className="text-muted text-xs mb-3">{INSTALL_PATHS[0].hint}</p>
            <pre className={CODE}>{INSTALL_PATHS[0].code}</pre>
          </div>
          <div className="card p-5">
            <h3 className="font-semibold text-foreground mb-1">Claude Desktop App <span className={`${EARS} text-xs font-normal ml-1`}>one-click</span></h3>
            <p className="text-muted text-xs mb-3">Download the extension, double-click it — done</p>
            <a
              href="https://github.com/crclabs-hq/GateTest/releases/download/v1.1.3/gatetest.mcpb"
              className="btn-secondary inline-block text-sm font-semibold rounded-lg px-4 py-2 mb-3"
            >
              ⬇ Download gatetest.mcpb
            </a>
            <p className="text-muted text-xs">
              Or paste into Settings → Developer → Edit Config:{" "}
              <span className="font-mono text-foreground-secondary break-all">{`{ "mcpServers": { "gatetest": { "url": "${SITE_URL}/api/mcp" } } }`}</span>
            </p>
          </div>
          {INSTALL_PATHS.slice(1).map((p) => (
            <div key={p.title} className="card p-5">
              <h3 className="font-semibold text-foreground mb-1">{p.title}{p.tag && <span className={`${p.tagClass} text-xs font-normal ml-1`}>{p.tag}</span>}</h3>
              <p className="text-muted text-xs mb-3">{p.hint}</p>
              <pre className={CODE}>{p.code}</pre>
            </div>
          ))}
        </div>
        <p className="text-muted text-xs text-center mt-4">
          Hosted endpoint: free tools work with no key; add <span className="font-mono">Authorization: Bearer gtmcp_...</span> to unlock premium.
          Filesystem tools (scan_local, run_tests, query_db, stream_logs, http_request) need the local install.
        </p>
      </Section>

      {/* Tool table */}
      <Section
        alt
        title={`${TOOL_COUNT} tools — every one free on the local server`}
        lede={<>
          The table shows the local server (<span className="font-mono">npx @gatetest/mcp-server</span>).
          On the <span className={EYES}>hosted endpoint</span>, five tools work with no key
          (check_health, list_modules, get_badge, scan_url, scan_repo); hosted scans, AI fix/diagnose,
          and scan history need the $29/mo key.
        </>}
      >
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="section-alt border-b border-border">
                <th className="text-left px-4 py-3 text-muted font-semibold">Tool</th>
                <th className="text-left px-4 py-3 text-muted font-semibold">What it does</th>
                <th className="text-center px-4 py-3 text-muted font-semibold">Access</th>
              </tr>
            </thead>
            <tbody>
              {ALL_TOOLS.map((tool, i) => (
                <tr key={i} className={`border-b border-border ${i % 2 === 0 ? "" : "section-alt"}`}>
                  <td className="px-4 py-3 font-mono text-foreground whitespace-nowrap">{tool.name}</td>
                  <td className="px-4 py-3 text-muted">{tool.desc}</td>
                  <td className="px-4 py-3 text-center">
                    {tool.paid ? (
                      <span className={`inline-flex items-center gap-1 bg-sky-500/10 ${EYES} border border-sky-500/30 rounded-full px-2.5 py-0.5 text-xs font-semibold`}>
                        🔒 $29/mo
                      </span>
                    ) : (
                      <span className={`inline-flex items-center gap-1 bg-emerald-500/10 ${EARS} border border-emerald-500/30 rounded-full px-2.5 py-0.5 text-xs font-semibold`}>
                        FREE
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* Value props */}
      <Section>
        <div className="grid md:grid-cols-3 gap-6">
          {VALUE_PROPS.map((v) => (
            <div key={v.label} className="card p-6">
              <div className="text-3xl mb-3">{v.icon}</div>
              <div className={`text-[11px] font-bold uppercase tracking-widest ${v.cls} mb-1`}>{v.label}</div>
              <h3 className="font-display font-bold text-lg mb-2 text-foreground">{v.title}</h3>
              <p className="text-muted text-sm">
                {v.items.map(([name, desc], i) => (
                  <span key={name}>
                    {i > 0 && <><br /><br /></>}
                    <strong className="text-foreground">{name}</strong> — {desc}
                  </span>
                ))}
              </p>
            </div>
          ))}
        </div>
      </Section>

      {/* FAQ */}
      <Section alt narrow title="FAQ">
        <div className="space-y-4">
          {FAQ.map((item, i) => (
            <div key={i} className="card p-5">
              <p className="font-semibold text-foreground mb-2">{item.q}</p>
              <p className="text-muted text-sm whitespace-pre-line">{item.a}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* Bottom CTA */}
      <Section narrow>
        <div className="text-center">
          <h2 className="font-display text-3xl font-bold text-foreground mb-4">Ready?</h2>
          <p className="text-muted mb-8">
            Free on your machine: <span className="font-mono text-accent text-sm">npx -y @gatetest/mcp-server</span>.
            Want it in claude.ai web/mobile? Subscribe and your key arrives in seconds.
          </p>
          <McpCheckoutButton label="Get the hosted endpoint — $29/mo →" />
          <p className="text-muted text-xs mt-3">Cancel anytime · API key emailed instantly · Local server free forever</p>
        </div>
      </Section>
    </main>
  );
}
