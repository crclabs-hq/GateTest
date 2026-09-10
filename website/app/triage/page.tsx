import Link from "next/link";
import PageHero from "../components/site/PageHero";
import Section from "../components/site/Section";
import { SITE_URL, SUPPORT_EMAIL } from "@/app/lib/site-url";

/**
 * Public marketing page for the Triage workflow.
 *
 * This page explains the SOURCE / SERVER / BROWSER triage to potential
 * customers. It mirrors the contract in `website/app/lib/triage/correlator.js`
 * (9 verdict rules) and the admin UI at `/admin/triage` so the copy here
 * matches what we actually ship.
 *
 * Honesty rules per CLAUDE.md Forbidden #1 + Bible Boss Rule:
 * - The source layer is the website Quick tier (api/admin/triage/route.ts
 *   calls /api/scan/run with tier "quick") — say so, never "all modules".
 * - Triage is an operator-console tool (admin cookie), not a self-serve
 *   purchase — the $29 Offer in the JSON-LD is the Quick scan.
 * - Claims here must be defensible against the source files.
 * - "Available on GitHub Marketplace soon" is allowed because the listing
 *   is in flight (Known Issue #29) — the wording does NOT claim it's live.
 * - HN / Product Hunt badges are gated behind NEXT_PUBLIC_LAUNCH_HN so we
 *   don't claim what hasn't shipped.
 *
 * Chrome: the site header and footer come from app/layout.tsx; this page
 * renders neither. Colours are tokens; the two diagram panels are the only
 * deliberately dark surfaces (bg-panel).
 */

const CASCADE_RULES = [
  {
    n: 1,
    label: "All three scans failed",
    condition: "Source, server, and browser scans all errored before producing signal",
    verdict: "UNKNOWN (low confidence)",
  },
  {
    n: 2,
    label: "Server unreachable + browser cannot paint",
    condition: "Server returns 5xx or DNS-fails AND browser sees navigation / network failures",
    verdict: "SERVER (high confidence)",
  },
  {
    n: 3,
    label: "Browser runtime errors, source clean, server healthy",
    condition: "Browser shows uncaught errors / hydration mismatches, but source HEAD is clean",
    verdict: "BUILD (medium confidence) — deploy / bundle mismatch",
  },
  {
    n: 4,
    label: "Browser runtime + matching source family",
    condition: "Browser errors line up with errorSwallow / nPlusOne / asyncIteration / raceCondition / resourceLeak findings in source",
    verdict: "SOURCE (high confidence)",
  },
  {
    n: 5,
    label: "Server security / header / TLS findings only",
    condition: "Server is reachable but flags CSP, HSTS, X-Frame, TLS, or cookie hardening errors",
    verdict: "SERVER (medium confidence)",
  },
  {
    n: 6,
    label: "Source has errors, server + browser healthy",
    condition: "Static scan flags errors but neither runtime layer is symptomatic yet",
    verdict: "SOURCE (medium confidence) — latent",
  },
  {
    n: 7,
    label: "Browser scan unavailable, one other layer dominates",
    condition: "Browser endpoint failed but source or server has ≥3x the issue load of the other",
    verdict: "SOURCE or SERVER (medium confidence) — dominant layer",
  },
  {
    n: 8,
    label: "Two or more layers each noisy",
    condition: "Two or three layers each have ≥3 errors or ≥1 failed module",
    verdict: "MIXED (medium confidence) — operator must triage each layer",
  },
  {
    n: 9,
    label: "Fallback",
    condition: "No correlator rule matched the observed pattern",
    verdict: "UNKNOWN (low confidence)",
  },
];

const LIMITATIONS = [
  {
    title: "Heuristic, not provable",
    body:
      "The verdict reflects signal alignment across the three layers, not a mathematical proof. Confidence (high / medium / low) is reported on every verdict — treat low-confidence verdicts as a starting point for human review, not a final answer.",
  },
  {
    title: "Source layer = standard Quick scan",
    body:
      "The source layer reuses GateTest's Quick tier — same modules, same depth. We do not re-run a deeper scan for triage; the value is the cross-layer cascade, not a heavier source pass.",
  },
  {
    title: "Browser layer needs the page to load",
    body:
      "The headless browser scan requires the live URL to render. If your origin is hard-down (rule 2 territory) the browser layer can only confirm 'cannot paint' — it cannot reach inside an unreachable origin.",
  },
  {
    title: "We do not see inside your private network",
    body:
      "Server and browser probes go through the public internet. If the bug only reproduces inside your VPC or behind a corporate proxy, the triage cannot reach it. Use the CLI in your environment for that case.",
  },
];

const USE_CASES = [
  {
    title: "A customer reports a bug, you don't know which layer owns it",
    body:
      "Frontend dev says it's an API bug. Backend dev says it's a frontend bug. Triage runs all three layers in parallel and points at the one that actually owns the failure.",
  },
  {
    title: "Static scan flagged something — does it show up live?",
    body:
      "A Quick scan emitted 20 errors. Are any of them actually breaking the production site right now, or are they latent? Rule 4 (source matches browser runtime) vs Rule 6 (latent only) is the answer.",
  },
  {
    title: "Pre-release smoke test",
    body:
      "Before a launch announcement: confirm source is clean, server is responding with the right headers, and the browser doesn't see runtime errors. One workflow, one verdict.",
  },
];

const STEPS = [
  {
    n: "01",
    t: "Scans run in parallel",
    d: "/api/scan/run (source), /api/scan/server (server), /api/web/scan (browser) — fired together.",
  },
  {
    n: "02",
    t: "Each layer normalised",
    d: "summariseLayer() collapses module-specific shapes into a common {ok, totalIssues, failedModules, topFindings} struct.",
  },
  {
    n: "03",
    t: "9-rule cascade",
    d: "Pure-logic correlator walks the rules top-down; first matching rule wins. No model in this step — fully deterministic.",
  },
  {
    n: "04",
    t: "Localised verdict",
    d: "Returns {layer, confidence, headline, rationale, recommendedNext} — one of SOURCE / SERVER / BROWSER / BUILD / MIXED / UNKNOWN.",
  },
];

/**
 * Layer accents. `text` reads on the light page, `panelText` on the dark
 * diagram panels; the tint and border work on both.
 */
const STAGE_ICONS = [
  {
    name: "SOURCE",
    role: "Static analysis of the repo",
    detail: "Quick-tier static scan — syntax, lint, secrets, code quality — from the same engine as a repo scan. Looks at the code on disk.",
    color: "from-blue-500/15 to-blue-500/5",
    border: "border-blue-500/30",
    text: "text-blue-700",
    panelText: "text-blue-300",
  },
  {
    name: "SERVER",
    role: "Live probe of the origin",
    detail: "Headers, TLS, status codes, CORS, security posture, response times.",
    color: "from-red-500/15 to-red-500/5",
    border: "border-red-500/30",
    text: "text-red-700",
    panelText: "text-red-300",
  },
  {
    name: "BROWSER",
    role: "Headless render of the URL",
    detail: "Uncaught errors, hydration mismatches, console output, network failures.",
    color: "from-amber-500/15 to-amber-500/5",
    border: "border-amber-500/30",
    text: "text-amber-700",
    panelText: "text-amber-300",
  },
];

const PANEL = "rounded-2xl border border-panel-border bg-panel text-panel-foreground";
const VERDICT = "rounded-lg border border-teal-400/30 bg-teal-500/10";
const EYEBROW =
  "inline-flex items-center gap-2 px-3 py-1 rounded-full border border-border bg-[var(--surface-solid)] text-[10px] text-muted font-mono uppercase tracking-widest mb-4";

function LiveScanCounter() {
  // Placeholder — reads from /api/scan/stats if it eventually exists.
  // For now this renders a static, defensible string and hides cleanly
  // if the endpoint isn't wired (we never claim a number we cannot prove).
  if (process.env.NEXT_PUBLIC_LIVE_COUNTER !== "1") return null;
  return (
    <div className="text-xs text-muted font-mono">
      Live scan counter — wiring in flight
    </div>
  );
}

export default function TriagePage() {
  const showLaunchBadges = process.env.NEXT_PUBLIC_LAUNCH_HN === "1";

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "GateTest Triage",
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Web, Linux, macOS",
    description:
      "GateTest Triage runs source, server, and browser scans in parallel and applies a 9-rule cascade to localise the bug to one layer.",
    offers: {
      "@type": "Offer",
      name: "Quick Scan",
      description: "Triage itself runs from the operator console; the $29 Quick scan is the self-serve entry point.",
      price: "29",
      priceCurrency: "USD",
      url: `${SITE_URL}/scan`,
    },
    url: `${SITE_URL}/triage`,
    publisher: {
      "@type": "Organization",
      name: "GateTest",
      url: SITE_URL,
    },
  };

  return (
    <div className="bg-background">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <main>
        {/* === Hero === */}
        <PageHero
          eyebrow="Cross-layer bug localisation"
          title={
            <>
              <span className="gradient-text">Triage</span>
              <br />
              <span className="text-3xl sm:text-4xl lg:text-5xl">
                finds where the bug lives.
              </span>
            </>
          }
          lede="Three scans in parallel — source, server, browser — fed to a 9-rule cascade that localises the failure to ONE layer. Built for the moments when nobody knows whose problem it is."
          actions={
            <>
              <Link
                href="/scan"
                className="btn-cta inline-flex items-center justify-center px-6 py-3 text-sm"
              >
                Run a scan — from $29
              </Link>
              <a
                href="#how-it-works"
                className="btn-secondary inline-flex items-center justify-center px-6 py-3 text-sm"
              >
                See it in action
              </a>
              <p className="basis-full mt-3 text-xs text-muted leading-relaxed">
                MIT-licensed CLI · Deterministic 9-rule cascade — no model
                call in the verdict
              </p>
            </>
          }
        >
          {/* Hero diagram preview — 3 layers feeding one verdict, on a
              deliberately dark panel */}
          <div className={`${PANEL} p-5 sm:p-7`}>
            <div className="text-[10px] uppercase tracking-widest text-panel-muted font-mono mb-4">
              Triage verdict
            </div>
            <div className="grid grid-cols-3 gap-2 sm:gap-3 mb-6">
              {STAGE_ICONS.map((s) => (
                <div
                  key={s.name}
                  className={`rounded-lg border ${s.border} p-3 bg-gradient-to-b ${s.color}`}
                >
                  <div className={`text-[10px] font-mono font-bold ${s.panelText}`}>{s.name}</div>
                  <div className="text-panel-muted text-[10px] mt-1.5 leading-snug">
                    scan ok
                  </div>
                </div>
              ))}
            </div>
            <div className={`${VERDICT} p-4`}>
              <div className="text-[10px] uppercase tracking-widest text-teal-300 font-mono mb-1">
                Verdict: SOURCE · high confidence
              </div>
              <div className="text-sm font-medium leading-snug">
                Browser runtime errors trace back to source-level bugs
              </div>
              <div className="text-panel-muted text-xs mt-2 leading-relaxed">
                Rule 4 — the runtime failures observed in the browser
                correspond to error-handling or async-iteration findings
                flagged statically.
              </div>
            </div>
          </div>
        </PageHero>

        {/* === What it answers === */}
        <Section
          title="Where between the source, server, and browser is the bug?"
          lede="One question, one workflow. Three layers scan in parallel; the correlator collapses the combined signal into a single localised verdict so the right team picks up the right work."
        >
          <div className="grid sm:grid-cols-3 gap-5">
            {STAGE_ICONS.map((s) => (
              <div
                key={s.name}
                className={`card border ${s.border} p-6 bg-gradient-to-b ${s.color}`}
              >
                <div className={`text-xs font-mono font-bold ${s.text} mb-2`}>
                  {s.name}
                </div>
                <div className="text-foreground font-semibold text-sm mb-2">
                  {s.role}
                </div>
                <p className="text-muted text-xs leading-relaxed">
                  {s.detail}
                </p>
              </div>
            ))}
          </div>
        </Section>

        {/* === How it works === */}
        <Section id="how-it-works" alt eyebrow="How it works" title="Four steps. One verdict.">
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-12">
            {STEPS.map((step) => (
              <div key={step.n} className="card p-5">
                <div className="text-accent font-mono text-xs mb-3">{step.n}</div>
                <div className="text-foreground font-semibold text-sm mb-2">{step.t}</div>
                <p className="text-muted text-xs leading-relaxed">{step.d}</p>
              </div>
            ))}
          </div>

          {/* Visual flow */}
          <div className={`${PANEL} p-6 sm:p-8`}>
            <div className="grid sm:grid-cols-3 gap-4 mb-6">
              {STAGE_ICONS.map((s, idx) => (
                <div key={s.name} className="relative">
                  <div className={`rounded-lg border ${s.border} p-4 bg-gradient-to-b ${s.color}`}>
                    <div className={`text-[10px] font-mono font-bold ${s.panelText} mb-2`}>
                      STAGE {idx + 1} · {s.name}
                    </div>
                    <div className="text-panel-muted text-xs">{s.role}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-center mb-4">
              <svg width="32" height="32" viewBox="0 0 32 32" className="text-teal-400" aria-hidden="true">
                <path d="M16 4 L16 24 M10 18 L16 24 L22 18" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div className={`${VERDICT} p-5`}>
              <div className="text-[10px] uppercase tracking-widest text-teal-300 font-mono mb-2">
                Correlator verdict
              </div>
              <div className="font-semibold mb-1">
                The bug lives HERE.
              </div>
              <div className="text-panel-muted text-sm leading-relaxed">
                Headline · confidence · rationale · recommended next step.
              </div>
            </div>
          </div>
        </Section>

        {/* === The 9-rule cascade === */}
        <Section
          eyebrow="The cascade in plain English"
          title="9 rules. No magic. Read them yourself."
          lede={
            <>
              Top-down. First match wins. Each rule maps a specific
              combination of layer signals to a verdict. The full source is
              at{" "}
              <code className="text-accent text-sm">
                website/app/lib/triage/correlator.js
              </code>
              .
            </>
          }
        >
          <ol className="space-y-3">
            {CASCADE_RULES.map((rule) => (
              <li key={rule.n} className="card p-5">
                <div className="flex items-start gap-4">
                  <div className="shrink-0 w-8 h-8 rounded-full bg-accent/10 border border-accent/30 text-accent font-mono text-xs font-bold flex items-center justify-center">
                    {rule.n}
                  </div>
                  <div className="flex-1">
                    <div className="text-foreground font-semibold text-sm mb-1.5">
                      {rule.label}
                    </div>
                    <div className="text-muted text-xs leading-relaxed mb-2">
                      If <span className="text-foreground-secondary">{rule.condition}</span>
                    </div>
                    <div className="inline-flex items-center gap-1.5 text-[11px] font-mono">
                      <span className="text-muted">→</span>
                      <span className="text-accent">{rule.verdict}</span>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </Section>

        {/* === Honest limitations === */}
        <Section alt>
          <div className="max-w-2xl mb-10 sm:mb-14">
            <div className={`${EYEBROW} border-amber-500/30 text-amber-700`}>
              Honest limitations
            </div>
            <h2 className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-foreground [text-wrap:balance]">
              What triage does NOT do.
            </h2>
            <p className="mt-4 text-base sm:text-lg text-foreground-secondary leading-relaxed">
              We do not ship claims we cannot defend. Here is what triage
              cannot tell you, in plain language.
            </p>
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            {LIMITATIONS.map((l) => (
              <div key={l.title} className="card p-5">
                <div className="text-foreground font-semibold text-sm mb-2">
                  {l.title}
                </div>
                <p className="text-muted text-xs leading-relaxed">{l.body}</p>
              </div>
            ))}
          </div>
        </Section>

        {/* === When to use it === */}
        <Section title="When to reach for triage">
          <div className="grid sm:grid-cols-3 gap-4">
            {USE_CASES.map((u, i) => (
              <div key={u.title} className="card p-5">
                <div className="text-accent font-mono text-xs mb-3">
                  Case {i + 1}
                </div>
                <div className="text-foreground font-semibold text-sm mb-3 leading-snug">
                  {u.title}
                </div>
                <p className="text-muted text-xs leading-relaxed">{u.body}</p>
              </div>
            ))}
          </div>
        </Section>

        {/* === Pricing line + trust strip + final CTA === */}
        <Section alt>
          <div className="mx-auto max-w-3xl text-center">
            <p className="text-foreground-secondary text-sm leading-relaxed">
              Triage is an operator-console tool today — GateTest staff run
              it from the admin console; it is not yet a self-serve purchase.
              E-mail {SUPPORT_EMAIL} if you want it run against your site.
              The scan button below runs a standard repo scan.
            </p>
          </div>

          <div className="mt-10 flex flex-wrap items-center justify-center gap-4 sm:gap-6">
            <div className="rounded-lg border border-border bg-[var(--surface-solid)] px-4 py-2 text-xs text-muted">
              Available on GitHub Marketplace soon
            </div>
            <a
              href="https://github.com/crclabs-hq/gatetest"
              className="rounded-lg border border-border bg-[var(--surface-solid)] px-4 py-2 text-xs text-muted hover:text-foreground hover:border-accent/50 transition-colors"
            >
              CLI is MIT-licensed — github.com/crclabs-hq/gatetest
            </a>
            {showLaunchBadges ? (
              <div className="rounded-lg border border-border bg-[var(--surface-solid)] px-4 py-2 text-xs text-muted">
                Launching on Hacker News
              </div>
            ) : null}
            <LiveScanCounter />
          </div>

          <div className="mx-auto max-w-3xl mt-14">
            <div className={`${PANEL} p-8 sm:p-10 text-center`}>
              <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight mb-3">
                Try it on your own repo.
              </h2>
              <p className="text-panel-muted mb-7 leading-relaxed">
                $29 Quick scan. No signup needed before checkout. No card
                stored after the scan completes.
              </p>
              <Link
                href="/scan"
                className="inline-flex items-center justify-center px-8 py-3.5 rounded-xl font-semibold bg-accent-light text-panel hover:bg-teal-300 transition-colors"
              >
                Run a scan
              </Link>
            </div>
          </div>
        </Section>
      </main>
    </div>
  );
}
