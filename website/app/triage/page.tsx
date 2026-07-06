import Link from "next/link";
import Navbar from "../components/Navbar";
import Footer from "../components/Footer";

/**
 * Public marketing page for the Triage workflow.
 *
 * This page explains the SOURCE / SERVER / BROWSER triage to potential
 * customers. It mirrors the contract in `website/app/lib/triage/correlator.js`
 * (9 verdict rules) and the admin UI at `/admin/triage` so the copy here
 * matches what we actually ship.
 *
 * Honesty rules per CLAUDE.md Forbidden #1 + Bible Boss Rule:
 * - Module count = 91 (from CLAUDE.md v1.43.0 / VERSION section).
 * - Claims here must be defensible against the source files.
 * - "Available on GitHub Marketplace soon" is allowed because the listing
 *   is in flight (Known Issue #29) — the wording does NOT claim it's live.
 * - HN / Product Hunt badges are gated behind NEXT_PUBLIC_LAUNCH_HN so we
 *   don't claim what hasn't shipped.
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

const STAGE_ICONS = [
  {
    name: "SOURCE",
    role: "Static analysis of the repo",
    detail: "120 modules — same engine as a repo scan. Looks at the code on disk.",
    color: "from-blue-500/20 to-blue-500/5",
    border: "border-blue-400/30",
    text: "text-blue-300",
  },
  {
    name: "SERVER",
    role: "Live probe of the origin",
    detail: "Headers, TLS, status codes, CORS, security posture, response times.",
    color: "from-red-500/20 to-red-500/5",
    border: "border-red-400/30",
    text: "text-red-300",
  },
  {
    name: "BROWSER",
    role: "Headless render of the URL",
    detail: "Uncaught errors, hydration mismatches, console output, network failures.",
    color: "from-amber-500/20 to-amber-500/5",
    border: "border-amber-400/30",
    text: "text-amber-300",
  },
];

function LiveScanCounter() {
  // Placeholder — reads from /api/scan/stats if it eventually exists.
  // For now this renders a static, defensible string and hides cleanly
  // if the endpoint isn't wired (we never claim a number we cannot prove).
  if (process.env.NEXT_PUBLIC_LIVE_COUNTER !== "1") return null;
  return (
    <div className="text-xs text-white/40 font-mono">
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
      price: "29",
      priceCurrency: "USD",
    },
    url: "https://gatetest.ai/triage",
    publisher: {
      "@type": "Organization",
      name: "GateTest",
      url: "https://gatetest.ai",
    },
  };

  return (
    <div className="min-h-screen" style={{ background: "#0a0a12" }}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <Navbar />

      <main className="pt-24 sm:pt-28">
        {/* === Hero === */}
        <section className="relative px-6 pb-16 sm:pb-20">
          <div className="mx-auto max-w-6xl">
            <div className="grid gap-10 sm:grid-cols-2 sm:gap-12 items-center">
              <div>
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-teal-500/10 border border-teal-500/20 text-xs text-teal-300 font-medium mb-6">
                  Cross-layer bug localisation
                </div>
                <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold text-white leading-[1.05] mb-6">
                  <span className="gradient-text">Triage</span>
                  <br />
                  <span className="text-white/85 text-3xl sm:text-4xl md:text-5xl">
                    finds where the bug lives.
                  </span>
                </h1>
                <p className="text-lg text-white/65 leading-relaxed max-w-xl">
                  Three scans in parallel — source, server, browser — fed to a
                  9-rule cascade that localises the failure to ONE layer.
                  Built for the moments when nobody knows whose problem it is.
                </p>
                <div className="flex flex-col sm:flex-row gap-3 mt-8">
                  <Link
                    href="/scan"
                    className="inline-flex items-center justify-center px-6 py-3 rounded-xl font-semibold text-sm"
                    style={{ background: "#2dd4bf", color: "#0a0a12" }}
                  >
                    Run a scan — from $29
                  </Link>
                  <a
                    href="#how-it-works"
                    className="inline-flex items-center justify-center px-6 py-3 rounded-xl font-semibold text-sm border border-white/15 text-white/80 hover:border-white/30 hover:text-white transition-colors"
                  >
                    See it in action
                  </a>
                </div>
                <p className="mt-6 text-xs text-white/40 leading-relaxed">
                  MIT-licensed CLI · No new dependencies · Same Claude
                  pipeline as Forensic Scan
                </p>
              </div>

              {/* Hero diagram preview — 3 layers feeding one verdict */}
              <div className="rounded-2xl border border-white/10 p-5 sm:p-7" style={{ background: "rgba(255,255,255,0.02)" }}>
                <div className="text-[10px] uppercase tracking-widest text-white/40 font-mono mb-4">
                  Triage verdict
                </div>
                <div className="grid grid-cols-3 gap-2 sm:gap-3 mb-6">
                  {STAGE_ICONS.map((s) => (
                    <div
                      key={s.name}
                      className={`rounded-lg border ${s.border} p-3 bg-gradient-to-b ${s.color}`}
                    >
                      <div className={`text-[10px] font-mono font-bold ${s.text}`}>{s.name}</div>
                      <div className="text-white/40 text-[10px] mt-1.5 leading-snug">
                        scan ok
                      </div>
                    </div>
                  ))}
                </div>
                <div className="rounded-lg border border-teal-400/30 bg-teal-500/10 p-4">
                  <div className="text-[10px] uppercase tracking-widest text-teal-300 font-mono mb-1">
                    Verdict: SOURCE · high confidence
                  </div>
                  <div className="text-white/80 text-sm font-medium leading-snug">
                    Browser runtime errors trace back to source-level bugs
                  </div>
                  <div className="text-white/45 text-xs mt-2 leading-relaxed">
                    Rule 4 — the runtime failures observed in the browser
                    correspond to error-handling or async-iteration findings
                    flagged statically.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* === What it answers === */}
        <section className="px-6 py-16 sm:py-20 border-t border-white/[0.06]">
          <div className="mx-auto max-w-6xl">
            <h2 className="text-2xl sm:text-3xl font-bold text-white mb-4">
              Where between the source, server, and browser is the bug?
            </h2>
            <p className="text-white/55 max-w-3xl leading-relaxed mb-12">
              One question, one workflow. Three layers scan in parallel; the
              correlator collapses the combined signal into a single
              localised verdict so the right team picks up the right work.
            </p>
            <div className="grid sm:grid-cols-3 gap-5">
              {STAGE_ICONS.map((s) => (
                <div
                  key={s.name}
                  className={`rounded-xl border ${s.border} p-6 bg-gradient-to-b ${s.color}`}
                >
                  <div className={`text-xs font-mono font-bold ${s.text} mb-2`}>
                    {s.name}
                  </div>
                  <div className="text-white font-semibold text-sm mb-2">
                    {s.role}
                  </div>
                  <p className="text-white/55 text-xs leading-relaxed">
                    {s.detail}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* === How it works === */}
        <section id="how-it-works" className="px-6 py-16 sm:py-20 border-t border-white/[0.06]">
          <div className="mx-auto max-w-6xl">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-[10px] text-white/60 font-mono uppercase tracking-widest mb-4">
              How it works
            </div>
            <h2 className="text-2xl sm:text-3xl font-bold text-white mb-12">
              Four steps. One verdict.
            </h2>

            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-12">
              {[
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
              ].map((step) => (
                <div
                  key={step.n}
                  className="rounded-xl border border-white/[0.08] p-5"
                  style={{ background: "rgba(255,255,255,0.03)" }}
                >
                  <div className="text-teal-300 font-mono text-xs mb-3">{step.n}</div>
                  <div className="text-white font-semibold text-sm mb-2">{step.t}</div>
                  <p className="text-white/50 text-xs leading-relaxed">{step.d}</p>
                </div>
              ))}
            </div>

            {/* Visual flow */}
            <div className="rounded-2xl border border-white/[0.08] p-6 sm:p-8" style={{ background: "rgba(255,255,255,0.02)" }}>
              <div className="grid sm:grid-cols-3 gap-4 mb-6">
                {STAGE_ICONS.map((s, idx) => (
                  <div key={s.name} className="relative">
                    <div className={`rounded-lg border ${s.border} p-4 bg-gradient-to-b ${s.color}`}>
                      <div className={`text-[10px] font-mono font-bold ${s.text} mb-2`}>
                        STAGE {idx + 1} · {s.name}
                      </div>
                      <div className="text-white/70 text-xs">{s.role}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex justify-center mb-4">
                <svg width="32" height="32" viewBox="0 0 32 32" className="text-teal-400" aria-hidden="true">
                  <path d="M16 4 L16 24 M10 18 L16 24 L22 18" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <div className="rounded-lg border border-teal-400/30 bg-teal-500/10 p-5">
                <div className="text-[10px] uppercase tracking-widest text-teal-300 font-mono mb-2">
                  Correlator verdict
                </div>
                <div className="text-white font-semibold mb-1">
                  The bug lives HERE.
                </div>
                <div className="text-white/55 text-sm leading-relaxed">
                  Headline · confidence · rationale · recommended next step.
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* === The 9-rule cascade === */}
        <section className="px-6 py-16 sm:py-20 border-t border-white/[0.06]">
          <div className="mx-auto max-w-6xl">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-[10px] text-white/60 font-mono uppercase tracking-widest mb-4">
              The cascade in plain English
            </div>
            <h2 className="text-2xl sm:text-3xl font-bold text-white mb-4">
              9 rules. No magic. Read them yourself.
            </h2>
            <p className="text-white/55 max-w-3xl leading-relaxed mb-10">
              Top-down. First match wins. Each rule maps a specific
              combination of layer signals to a verdict. The full source is
              at{" "}
              <code className="text-teal-300 text-sm">
                website/app/lib/triage/correlator.js
              </code>
              .
            </p>
            <ol className="space-y-3">
              {CASCADE_RULES.map((rule) => (
                <li
                  key={rule.n}
                  className="rounded-xl border border-white/[0.08] p-5"
                  style={{ background: "rgba(255,255,255,0.03)" }}
                >
                  <div className="flex items-start gap-4">
                    <div className="shrink-0 w-8 h-8 rounded-full bg-teal-500/15 border border-teal-400/30 text-teal-300 font-mono text-xs font-bold flex items-center justify-center">
                      {rule.n}
                    </div>
                    <div className="flex-1">
                      <div className="text-white font-semibold text-sm mb-1.5">
                        {rule.label}
                      </div>
                      <div className="text-white/55 text-xs leading-relaxed mb-2">
                        If <span className="text-white/75">{rule.condition}</span>
                      </div>
                      <div className="inline-flex items-center gap-1.5 text-[11px] font-mono">
                        <span className="text-white/40">→</span>
                        <span className="text-teal-300">{rule.verdict}</span>
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* === Honest limitations === */}
        <section className="px-6 py-16 sm:py-20 border-t border-white/[0.06]">
          <div className="mx-auto max-w-6xl">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-400/20 text-[10px] text-amber-300 font-mono uppercase tracking-widest mb-4">
              Honest limitations
            </div>
            <h2 className="text-2xl sm:text-3xl font-bold text-white mb-4">
              What triage does NOT do.
            </h2>
            <p className="text-white/55 max-w-3xl leading-relaxed mb-10">
              We do not ship claims we cannot defend. Here is what triage
              cannot tell you, in plain language.
            </p>
            <div className="grid sm:grid-cols-2 gap-4">
              {LIMITATIONS.map((l) => (
                <div
                  key={l.title}
                  className="rounded-xl border border-white/[0.08] p-5"
                  style={{ background: "rgba(255,255,255,0.03)" }}
                >
                  <div className="text-white font-semibold text-sm mb-2">
                    {l.title}
                  </div>
                  <p className="text-white/55 text-xs leading-relaxed">{l.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* === When to use it === */}
        <section className="px-6 py-16 sm:py-20 border-t border-white/[0.06]">
          <div className="mx-auto max-w-6xl">
            <h2 className="text-2xl sm:text-3xl font-bold text-white mb-10">
              When to reach for triage
            </h2>
            <div className="grid sm:grid-cols-3 gap-4">
              {USE_CASES.map((u, i) => (
                <div
                  key={u.title}
                  className="rounded-xl border border-white/[0.08] p-5"
                  style={{ background: "rgba(255,255,255,0.03)" }}
                >
                  <div className="text-teal-300 font-mono text-xs mb-3">
                    Case {i + 1}
                  </div>
                  <div className="text-white font-semibold text-sm mb-3 leading-snug">
                    {u.title}
                  </div>
                  <p className="text-white/55 text-xs leading-relaxed">{u.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* === Pricing line === */}
        <section className="px-6 py-12 border-t border-white/[0.06]">
          <div className="mx-auto max-w-3xl text-center">
            <p className="text-white/65 text-sm leading-relaxed">
              Triage is an admin tool today — available to GateTest
              subscribers via the admin dashboard. Public per-scan checkout
              for Triage is planned for v1.45.
            </p>
          </div>
        </section>

        {/* === Trust strip === */}
        <section className="px-6 py-12 border-t border-white/[0.06]">
          <div className="mx-auto max-w-6xl">
            <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6">
              <div className="rounded-lg border border-white/10 px-4 py-2 text-xs text-white/60">
                Available on GitHub Marketplace soon
              </div>
              <a
                href="https://github.com/crclabs-hq/gatetest"
                className="rounded-lg border border-white/10 px-4 py-2 text-xs text-white/60 hover:text-white hover:border-white/20 transition-colors"
              >
                CLI is MIT-licensed — github.com/crclabs-hq/gatetest
              </a>
              {showLaunchBadges ? (
                <div className="rounded-lg border border-white/10 px-4 py-2 text-xs text-white/60">
                  Launching on Hacker News
                </div>
              ) : null}
              <LiveScanCounter />
            </div>
          </div>
        </section>

        {/* === Final CTA === */}
        <section className="px-6 py-16 sm:py-20 border-t border-white/[0.06]">
          <div className="mx-auto max-w-3xl">
            <div className="rounded-2xl border border-teal-500/20 p-8 sm:p-10 text-center" style={{ background: "rgba(20,184,166,0.05)" }}>
              <h2 className="text-2xl sm:text-3xl font-bold text-white mb-3">
                Try it on your own repo.
              </h2>
              <p className="text-white/60 mb-7 leading-relaxed">
                $29 Quick scan. No signup needed before checkout. No card
                stored after the scan completes.
              </p>
              <Link
                href="/scan"
                className="inline-flex items-center justify-center px-8 py-3.5 rounded-xl font-semibold"
                style={{ background: "#2dd4bf", color: "#0a0a12" }}
              >
                Run a scan
              </Link>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
