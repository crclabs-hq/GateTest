import Link from "next/link";
import Navbar from "../components/Navbar";
import Footer from "../components/Footer";

/**
 * Public marketing page for the Pipeline Trace workflow.
 *
 * Mirrors the contract in `website/app/lib/pipeline-trace/correlator.js`
 * (10 cascade rules) and the admin UI at `/admin/pipeline-trace`.
 *
 * Honesty rules per CLAUDE.md Forbidden #1:
 * - "Reads GitHub APIs" is literally true — see correlator.js / route.
 * - Module count = 91 (CLAUDE.md v1.43.0).
 * - No claims about "tracking N teams" — we have no proof.
 */

const CASCADE_RULES = [
  {
    n: 1,
    label: "No source signal",
    condition: "Source stage failed to return a usable commit SHA",
    verdict: "UNKNOWN (low) — trace blocked at stage 1",
  },
  {
    n: 2,
    label: "CI hasn't built HEAD yet",
    condition: "Source HEAD is at SHA X, but the latest CI run was against an older SHA",
    verdict: "CI (high) — ci-not-built",
  },
  {
    n: 3,
    label: "CI failed on HEAD",
    condition: "CI ran on HEAD and its conclusion is failure / cancelled / timed_out / action_required",
    verdict: "CI (high) — ci-failed",
  },
  {
    n: 4,
    label: "CI still running on HEAD",
    condition: "CI is in_progress / queued / waiting on the latest commit",
    verdict: "CI (medium) — ci-not-built",
  },
  {
    n: 5,
    label: "Deploy is behind CI",
    condition: "CI succeeded on HEAD, but the latest registered deploy is for an older commit",
    verdict: "DEPLOY (high) — deploy-behind",
  },
  {
    n: 6,
    label: "Deploy failed on HEAD",
    condition: "Deploy registered for HEAD but its state is error / failure / inactive",
    verdict: "DEPLOY (high) — deploy-failed",
  },
  {
    n: 7,
    label: "Live is serving an older deploy",
    condition: "Live URL embeds an older SHA than the latest successful deploy",
    verdict: "LIVE (high) — live-stale",
  },
  {
    n: 8,
    label: "Edge cache stale",
    condition: "Live SHA matches deploy, but the cached response Age header is above 30 minutes",
    verdict: "EDGE (medium) — edge-cache",
  },
  {
    n: 9,
    label: "All four in sync",
    condition: "Source HEAD, CI, deploy, and live all share the same commit SHA",
    verdict: "SYNCED (high) — application-level issue if updates still missing",
  },
  {
    n: 10,
    label: "Fallback",
    condition: "No rule matched — at least one stage's signal is incomplete or contradictory",
    verdict: "UNKNOWN (low)",
  },
];

const LIMITATIONS = [
  {
    title: "Reads GitHub APIs",
    body:
      "Pipeline trace reads the GitHub REST API for the source, CI, and deploy stages. Your repo must be public or your GitHub token must have repo + actions:read scope. We do not run code in your CI; we read its conclusion.",
  },
  {
    title: "Sees deploy registrations, not build logs",
    body:
      "The deploy stage reads the GitHub Deployments API — Vercel, Netlify, Render, and anything else that registers there is visible. We see the conclusion / state of a deploy, not the contents of the build log. If your host doesn't register deployments, the deploy stage will be empty.",
  },
  {
    title: "Live stage probes via HTTP",
    body:
      "We fetch the live URL and look at the response — headers, Age, embedded commit hash if your build inlines one. We cannot see inside service-worker caches, browser localStorage, or anything else that lives below the network layer.",
  },
  {
    title: "Deterministic, not predictive",
    body:
      "The cascade reports the state right now. It does not predict when a stuck stage will unstick itself, and it does not retry on your behalf. Re-run after taking the recommended action to confirm the trace moves on.",
  },
];

const USE_CASES = [
  {
    title: "I pushed a fix 4 hours ago and it's not live",
    body:
      "Run pipeline trace. The cascade tells you whether CI hasn't built it, the deploy is behind, the live URL is serving an older deploy, or the edge cache is stale — in seconds.",
  },
  {
    title: "An AI assistant searched the code and found nothing",
    body:
      "Because the bug isn't in the code — it's in the pipeline. The current commit is fine; the deployed bundle is from yesterday. Pipeline trace catches the cases that code-only tools can't.",
  },
  {
    title: "Customer says 'still broken' but it works locally",
    body:
      "Either your local matches HEAD and the deploy chain is stuck, or the deploy is fine and the customer's edge node is cached. The cascade tells you which.",
  },
];

const STAGES = [
  {
    name: "SOURCE",
    role: "git HEAD on the default branch",
    detail: "Read via GitHub API. This is the baseline every other stage compares against.",
    color: "from-blue-500/20 to-blue-500/5",
    border: "border-blue-400/30",
    text: "text-blue-300",
  },
  {
    name: "CI",
    role: "Latest workflow run",
    detail: "Last GitHub Actions run on default branch — SHA, conclusion, age.",
    color: "from-purple-500/20 to-purple-500/5",
    border: "border-purple-400/30",
    text: "text-purple-300",
  },
  {
    name: "DEPLOY",
    role: "Latest deployment registration",
    detail: "GitHub Deployments API — Vercel / Netlify / Render / Cloudflare register here.",
    color: "from-orange-500/20 to-orange-500/5",
    border: "border-orange-400/30",
    text: "text-orange-300",
  },
  {
    name: "LIVE",
    role: "What the live URL is serving",
    detail: "HTTP probe — embedded commit SHA, Cache-Control, Age header, response time.",
    color: "from-pink-500/20 to-pink-500/5",
    border: "border-pink-400/30",
    text: "text-pink-300",
  },
];

function LiveScanCounter() {
  if (process.env.NEXT_PUBLIC_LIVE_COUNTER !== "1") return null;
  return (
    <div className="text-xs text-white/40 font-mono">
      Live scan counter — wiring in flight
    </div>
  );
}

export default function PipelineTracePage() {
  const showLaunchBadges = process.env.NEXT_PUBLIC_LAUNCH_HN === "1";

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "GateTest Pipeline Trace",
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Web, Linux, macOS",
    description:
      "GateTest Pipeline Trace checks source HEAD, latest CI, latest deploy, and the live URL — then localises divergence to one stage via a 10-rule cascade.",
    offers: {
      "@type": "Offer",
      price: "29",
      priceCurrency: "USD",
    },
    url: "https://gatetest.ai/pipeline-trace",
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
                  Deploy-chain divergence localisation
                </div>
                <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold text-white leading-[1.05] mb-6">
                  <span className="gradient-text">Pipeline Trace</span>
                  <br />
                  <span className="text-white/85 text-3xl sm:text-4xl md:text-5xl">
                    finds where the deploy is stuck.
                  </span>
                </h1>
                <p className="text-lg text-white/65 leading-relaxed max-w-xl">
                  Source HEAD, latest CI, latest deploy, live URL — four
                  probes, one verdict. A 10-rule cascade names the stage
                  holding your update.
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

              {/* Hero diagram preview */}
              <div className="rounded-2xl border border-white/10 p-5 sm:p-7" style={{ background: "rgba(255,255,255,0.02)" }}>
                <div className="text-[10px] uppercase tracking-widest text-white/40 font-mono mb-4">
                  Pipeline trace verdict
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-6">
                  {STAGES.map((s, i) => (
                    <div
                      key={s.name}
                      className={`rounded-lg border ${s.border} p-3 bg-gradient-to-b ${s.color}`}
                    >
                      <div className={`text-[10px] font-mono font-bold ${s.text}`}>
                        {i + 1}.{s.name}
                      </div>
                      <div className="text-white/45 text-[10px] mt-1.5 font-mono">
                        {i < 2 ? "a3f9c12" : "8c1bea0"}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="rounded-lg border border-teal-400/30 bg-teal-500/10 p-4">
                  <div className="text-[10px] uppercase tracking-widest text-teal-300 font-mono mb-1">
                    Verdict: DEPLOY · high confidence
                  </div>
                  <div className="text-white/80 text-sm font-medium leading-snug">
                    Last deploy is behind CI
                  </div>
                  <div className="text-white/45 text-xs mt-2 leading-relaxed">
                    Rule 5 — CI succeeded on a3f9c12 (matches source HEAD),
                    but the latest deploy is for an older commit 8c1bea0.
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
              Where between the merged commit and what the user sees is the
              update stuck?
            </h2>
            <p className="text-white/55 max-w-3xl leading-relaxed mb-12">
              Four stages, in order. Each stage compares against its
              predecessor. The first divergence is the answer.
            </p>
            <div className="grid sm:grid-cols-2 md:grid-cols-4 gap-4">
              {STAGES.map((s, i) => (
                <div
                  key={s.name}
                  className={`rounded-xl border ${s.border} p-5 bg-gradient-to-b ${s.color}`}
                >
                  <div className={`text-xs font-mono font-bold ${s.text} mb-2`}>
                    STAGE {i + 1} · {s.name}
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
              Four probes. One verdict.
            </h2>

            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-12">
              {[
                {
                  n: "01",
                  t: "Fetch four signals",
                  d: "Source HEAD, latest GitHub Actions run, latest deployment registration, and a probe of the live URL.",
                },
                {
                  n: "02",
                  t: "Normalise each stage",
                  d: "safeStage() reduces each to {ok, sha, shortSha, timestamp, ageMinutes, conclusion, state, details}.",
                },
                {
                  n: "03",
                  t: "10-rule cascade",
                  d: "Pure-logic correlator walks the rules top-down; first matching rule wins. Deterministic — no model call.",
                },
                {
                  n: "04",
                  t: "Localised verdict",
                  d: "Returns {layer, confidence, headline, rationale, recommendedNext, divergencePoint} plus per-stage status.",
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

            {/* Visual flow — 4 stages horizontal on md+, vertical on mobile */}
            <div className="rounded-2xl border border-white/[0.08] p-6 sm:p-8" style={{ background: "rgba(255,255,255,0.02)" }}>
              <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center mb-6">
                {STAGES.map((s, idx) => (
                  <div key={s.name} className="flex-1 flex md:items-center gap-3">
                    <div className={`flex-1 rounded-lg border ${s.border} p-4 bg-gradient-to-b ${s.color}`}>
                      <div className={`text-[10px] font-mono font-bold ${s.text} mb-1`}>
                        STAGE {idx + 1}
                      </div>
                      <div className="text-white font-semibold text-sm">{s.name}</div>
                      <div className="text-white/45 text-xs mt-1">{s.role}</div>
                    </div>
                    {idx < STAGES.length - 1 ? (
                      <div className="text-white/30 font-mono text-lg hidden md:block">→</div>
                    ) : null}
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
                  Cascade verdict
                </div>
                <div className="text-white font-semibold mb-1">
                  The divergence point is HERE.
                </div>
                <div className="text-white/55 text-sm leading-relaxed">
                  Stage · confidence · headline · rationale · recommended
                  next action.
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* === The 10-rule cascade === */}
        <section className="px-6 py-16 sm:py-20 border-t border-white/[0.06]">
          <div className="mx-auto max-w-6xl">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-[10px] text-white/60 font-mono uppercase tracking-widest mb-4">
              The cascade in plain English
            </div>
            <h2 className="text-2xl sm:text-3xl font-bold text-white mb-4">
              10 rules. No magic. Read them yourself.
            </h2>
            <p className="text-white/55 max-w-3xl leading-relaxed mb-10">
              Top-down. First match wins. Each rule maps a combination of
              stage states to one verdict. The full source is at{" "}
              <code className="text-teal-300 text-sm">
                website/app/lib/pipeline-trace/correlator.js
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
              What pipeline trace does NOT do.
            </h2>
            <p className="text-white/55 max-w-3xl leading-relaxed mb-10">
              We do not ship claims we cannot defend. Here is what pipeline
              trace cannot tell you.
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
              When to reach for pipeline trace
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
              Pipeline Trace is an admin tool today — available to GateTest
              subscribers via the admin dashboard. Public per-scan checkout
              for Pipeline Trace is planned for v1.45.
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
