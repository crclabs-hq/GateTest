/**
 * <HomeThreeDoors> — three ways in, instead of one.
 *
 * ── Why this exists (Craig, 2026-08-06) ─────────────────────────────────────
 * The homepage told exactly one story: your CI goes red, we open a PR with the
 * fix. That story is good, but it requires a repository, a CI pipeline, a
 * GitHub App install, and the visitor to be a developer. Four gates before
 * anyone sees value.
 *
 * Meanwhile the engine already contains whole categories nobody was told about:
 * live website auditing (no repo needed at all), ten dedicated WordPress
 * modules, and a free local MCP server that puts the full scanner inside Claude
 * Code / Cursor. Those pages existed and were reachable only by scrolling.
 *
 * So this is not new capability — it is the capability we already ship,
 * addressed to the three people who actually arrive here.
 *
 * ── Honesty rules baked in ──────────────────────────────────────────────────
 * - The module count is imported from TOTAL_MODULES, never typed. Craig's sync
 *   rule + tests/module-count-sync.test.js.
 * - **No penetration-testing claims.** The live-probe modules exist in the
 *   engine, but Craig ruled 2026-07-14 that pentest says "coming soon" with a
 *   notify form — see <PentestComingSoon>. Door 2 markets only what runs
 *   today: runtime errors, CSP, mixed content, headers, WordPress exposure.
 * - Door 3 says "free" because the local stdio MCP genuinely is: GATED_TOOLS
 *   in bin/gatetest-mcp.mjs is empty, and it runs on the user's own machine
 *   and keys. The $29/mo tier sells the HOSTED endpoint, which is a different
 *   thing and is not claimed here.
 */

import Link from "next/link";
import { TOTAL_MODULES } from "@/app/lib/module-count";
import { TOOL_COUNT } from "@/app/mcp/tools-data";

type Door = {
  id: string;
  eyebrow: string;
  title: string;
  blurb: string;
  points: string[];
  cta: { label: string; href: string };
  secondary?: { label: string; href: string };
  /** Removes a barrier the visitor expects to hit. */
  noBarrier: string;
  accent: string;
  glow: string;
  icon: React.ReactNode;
};

const DOORS: Door[] = [
  {
    id: "repo",
    eyebrow: "For developers",
    title: "I have a repository",
    blurb: `Every push runs the gate. When CI goes red, GateTest opens a pull request with the fix already written, tested, and reviewed by a second AI.`,
    points: [
      `All ${TOTAL_MODULES} modules in a single gate`,
      "Auto-fix PR with a regression test attached",
      "Commit status + PR comment on every push",
    ],
    cta: { label: "Install the GitHub App", href: "/github/setup" },
    secondary: { label: "See how the fix flow works", href: "/how-it-works" },
    noBarrier: "Free quick gate on install — no card",
    accent: "text-teal-400",
    glow: "from-teal-500/20",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <path d="M6 3v12" strokeLinecap="round" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="6" cy="6" r="3" />
        <path d="M18 9a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0 0v3a4 4 0 0 1-4 4H9" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: "site",
    eyebrow: "For site owners",
    title: "I have a website",
    blurb:
      "Paste a URL. GateTest loads the real page in a real browser and reports what is actually broken for your visitors — no repository, no git, no install.",
    points: [
      "Live JavaScript errors and hydration mismatches",
      "Missing security headers, mixed content, CSP violations",
      "WordPress: version exposure, XML-RPC, exposed admin",
    ],
    cta: { label: "Scan my website", href: "/web" },
    secondary: { label: "WordPress health check", href: "/wp" },
    noBarrier: "No repo, no code access, no signup to preview",
    accent: "text-violet-400",
    glow: "from-violet-500/20",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9S14.5 18.3 12 21c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z" />
      </svg>
    ),
  },
  {
    id: "agent",
    eyebrow: "For AI-assisted teams",
    title: "I use an AI coding agent",
    blurb: `The full ${TOTAL_MODULES}-module scanner runs inside Claude Code, Cursor, or any MCP client — so your agent can find the bug, fix it, and prove the fix worked without leaving the editor.`,
    points: [
      "Runs on your machine, on your own API keys",
      `${TOOL_COUNT} tools: scan, explain, fix, run tests, verify`,
      "Catches fake fixes — the symptom silenced, not solved",
    ],
    cta: { label: "Connect your agent", href: "/mcp" },
    secondary: { label: "Try the playground", href: "/playground" },
    noBarrier: "100% free on your own machine",
    accent: "text-amber-400",
    glow: "from-amber-500/20",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <rect x="4" y="7" width="16" height="12" rx="3" />
        <path d="M12 7V4M9 13h.01M15 13h.01" strokeLinecap="round" />
      </svg>
    ),
  },
];

export default function HomeThreeDoors() {
  return (
    <section
      id="start"
      aria-labelledby="three-doors-heading"
      className="py-24 px-6 border-t border-border bg-background"
    >
      <div className="mx-auto max-w-6xl">
        <div className="max-w-2xl mb-14">
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-foreground/[0.03] px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-muted mb-5">
            Start here
          </span>
          <h2
            id="three-doors-heading"
            className="text-3xl sm:text-4xl font-bold text-foreground mb-4 tracking-tight"
          >
            One engine. Three ways in.
          </h2>
          <p className="text-muted text-lg leading-relaxed">
            The same {TOTAL_MODULES}-module engine backs all three — you just
            point it at whatever you actually have.
          </p>
        </div>

        <ul className="grid gap-6 md:grid-cols-3 list-none p-0 m-0">
          {DOORS.map((door) => (
            <li key={door.id} className="group relative flex">
              {/* Accent wash — decorative only. */}
              <div
                aria-hidden="true"
                className={`pointer-events-none absolute inset-0 rounded-2xl bg-gradient-to-b ${door.glow} to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300`}
              />
              <div className="relative flex flex-col w-full rounded-2xl border border-border bg-foreground/[0.02] p-7 transition-colors duration-200 group-hover:border-foreground/20">
                <div className={`w-10 h-10 mb-5 ${door.accent}`}>{door.icon}</div>

                <span className="text-[11px] font-bold uppercase tracking-wider text-muted mb-2">
                  {door.eyebrow}
                </span>
                <h3 className="text-xl font-bold text-foreground mb-3">{door.title}</h3>
                <p className="text-sm text-muted leading-relaxed mb-5">{door.blurb}</p>

                <ul className="space-y-2.5 mb-6 list-none p-0 m-0">
                  {door.points.map((point) => (
                    <li key={point} className="flex items-start gap-2.5 text-sm text-foreground/85">
                      <svg
                        className={`w-4 h-4 mt-0.5 shrink-0 ${door.accent}`}
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <path
                          fillRule="evenodd"
                          d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0l-3.5-3.5a1 1 0 1 1 1.4-1.4l2.8 2.8 6.8-6.8a1 1 0 0 1 1.4 0z"
                          clipRule="evenodd"
                        />
                      </svg>
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>

                {/* Pushes the CTA block to the card bottom so all three align. */}
                <div className="mt-auto">
                  <p className="text-xs text-muted/80 mb-4">{door.noBarrier}</p>
                  <Link
                    href={door.cta.href}
                    className="inline-flex w-full items-center justify-center rounded-xl border border-foreground/15 bg-foreground/[0.06] px-5 py-3 text-sm font-semibold text-foreground transition-colors hover:bg-foreground/10 hover:border-foreground/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-400"
                  >
                    {door.cta.label}
                  </Link>
                  {door.secondary && (
                    <Link
                      href={door.secondary.href}
                      className="mt-3 inline-flex w-full items-center justify-center text-xs text-muted hover:text-foreground transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-400"
                    >
                      {door.secondary.label} →
                    </Link>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
