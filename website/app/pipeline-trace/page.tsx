import Link from "next/link";
import PageHero from "../components/site/PageHero";
import Section from "../components/site/Section";
import { SITE_URL } from "@/app/lib/site-url";

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
 *
 * Chrome: the site header and footer come from app/layout.tsx; this page
 * renders neither. Colours are tokens; the two diagram panels are the only
 * deliberately dark surfaces (bg-panel).
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

const STEPS = [
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
];

/**
 * Stage accents. `text` reads on the light page, `panelText` on the dark
 * diagram panels; the tint and border work on both.
 */
const STAGES = [
  {
    name: "SOURCE",
    role: "git HEAD on the default branch",
    detail: "Read via GitHub API. This is the baseline every other stage compares against.",
    color: "from-blue-500/15 to-blue-500/5",
    border: "border-blue-500/30",
    text: "text-blue-700",
    panelText: "text-blue-300",
  },
  {
    name: "CI",
    role: "Latest workflow run",
    detail: "Last GitHub Actions run on default branch — SHA, conclusion, age.",
    color: "from-purple-500/15 to-purple-500/5",
    border: "border-purple-500/30",
    text: "text-purple-700",
    panelText: "text-purple-300",
  },
  {
    name: "DEPLOY",
    role: "Latest deployment registration",
    detail: "GitHub Deployments API — Vercel / Netlify / Render / Cloudflare register here.",
    color: "from-orange-500/15 to-orange-500/5",
    border: "border-orange-500/30",
    text: "text-orange-700",
    panelText: "text-orange-300",
  },
  {
    name: "LIVE",
    role: "What the live URL is serving",
    detail: "HTTP probe — embedded commit SHA, Cache-Control, Age header, response time.",
    color: "from-pink-500/15 to-pink-500/5",
    border: "border-pink-500/30",
    text: "text-pink-700",
    panelText: "text-pink-300",
  },
];

const PANEL = "rounded-2xl border border-panel-border bg-panel text-panel-foreground";
const VERDICT = "rounded-lg border border-teal-400/30 bg-teal-500/10";
const EYEBROW =
  "inline-flex items-center gap-2 px-3 py-1 rounded-full border border-border bg-[var(--surface-solid)] text-[10px] text-muted font-mono uppercase tracking-widest mb-4";

function LiveScanCounter() {
  if (process.env.NEXT_PUBLIC_LIVE_COUNTER !== "1") return null;
  return (
    <div className="text-xs text-muted font-mono">
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
    url: `${SITE_URL}/pipeline-trace`,
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
          eyebrow="Deploy-chain divergence localisation"
          title={
            <>
              <span className="gradient-text">Pipeline Trace</span>
              <br />
              <span className="text-3xl sm:text-4xl lg:text-5xl">
                finds where the deploy is stuck.
              </span>
            </>
          }
          lede="Source HEAD, latest CI, latest deploy, live URL — four probes, one verdict. A 10-rule cascade names the stage holding your update."
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
                MIT-licensed CLI · No new dependencies · Same Claude
                pipeline as Forensic Scan
              </p>
            </>
          }
        >
          {/* Hero diagram preview — a deliberately dark panel */}
          <div className={`${PANEL} p-5 sm:p-7`}>
            <div className="text-[10px] uppercase tracking-widest text-panel-muted font-mono mb-4">
              Pipeline trace verdict
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-6">
              {STAGES.map((s, i) => (
                <div
                  key={s.name}
                  className={`rounded-lg border ${s.border} p-3 bg-gradient-to-b ${s.color}`}
                >
                  <div className={`text-[10px] font-mono font-bold ${s.panelText}`}>
                    {i + 1}.{s.name}
                  </div>
                  <div className="text-panel-muted text-[10px] mt-1.5 font-mono">
                    {i < 2 ? "a3f9c12" : "8c1bea0"}
                  </div>
                </div>
              ))}
            </div>
            <div className={`${VERDICT} p-4`}>
              <div className="text-[10px] uppercase tracking-widest text-teal-300 font-mono mb-1">
                Verdict: DEPLOY · high confidence
              </div>
              <div className="text-sm font-medium leading-snug">
                Last deploy is behind CI
              </div>
              <div className="text-panel-muted text-xs mt-2 leading-relaxed">
                Rule 5 — CI succeeded on a3f9c12 (matches source HEAD),
                but the latest deploy is for an older commit 8c1bea0.
              </div>
            </div>
          </div>
        </PageHero>

        {/* === What it answers === */}
        <Section
          title="Where between the merged commit and what the user sees is the update stuck?"
          lede="Four stages, in order. Each stage compares against its predecessor. The first divergence is the answer."
        >
          <div className="grid sm:grid-cols-2 md:grid-cols-4 gap-4">
            {STAGES.map((s, i) => (
              <div
                key={s.name}
                className={`card border ${s.border} p-5 bg-gradient-to-b ${s.color}`}
              >
                <div className={`text-xs font-mono font-bold ${s.text} mb-2`}>
                  STAGE {i + 1} · {s.name}
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
        <Section id="how-it-works" alt eyebrow="How it works" title="Four probes. One verdict.">
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-12">
            {STEPS.map((step) => (
              <div key={step.n} className="card p-5">
                <div className="text-accent font-mono text-xs mb-3">{step.n}</div>
                <div className="text-foreground font-semibold text-sm mb-2">{step.t}</div>
                <p className="text-muted text-xs leading-relaxed">{step.d}</p>
              </div>
            ))}
          </div>

          {/* Visual flow — 4 stages horizontal on md+, vertical on mobile */}
          <div className={`${PANEL} p-6 sm:p-8`}>
            <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center mb-6">
              {STAGES.map((s, idx) => (
                <div key={s.name} className="flex-1 flex md:items-center gap-3">
                  <div className={`flex-1 rounded-lg border ${s.border} p-4 bg-gradient-to-b ${s.color}`}>
                    <div className={`text-[10px] font-mono font-bold ${s.panelText} mb-1`}>
                      STAGE {idx + 1}
                    </div>
                    <div className="font-semibold text-sm">{s.name}</div>
                    <div className="text-panel-muted text-xs mt-1">{s.role}</div>
                  </div>
                  {idx < STAGES.length - 1 ? (
                    <div className="text-panel-muted font-mono text-lg hidden md:block" aria-hidden="true">→</div>
                  ) : null}
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
                Cascade verdict
              </div>
              <div className="font-semibold mb-1">
                The divergence point is HERE.
              </div>
              <div className="text-panel-muted text-sm leading-relaxed">
                Stage · confidence · headline · rationale · recommended
                next action.
              </div>
            </div>
          </div>
        </Section>

        {/* === The 10-rule cascade === */}
        <Section
          eyebrow="The cascade in plain English"
          title="10 rules. No magic. Read them yourself."
          lede={
            <>
              Top-down. First match wins. Each rule maps a combination of
              stage states to one verdict. The full source is at{" "}
              <code className="text-accent text-sm">
                website/app/lib/pipeline-trace/correlator.js
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
              What pipeline trace does NOT do.
            </h2>
            <p className="mt-4 text-base sm:text-lg text-foreground-secondary leading-relaxed">
              We do not ship claims we cannot defend. Here is what pipeline
              trace cannot tell you.
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
        <Section title="When to reach for pipeline trace">
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
              Pipeline Trace is an admin tool today — available to GateTest
              subscribers via the admin dashboard. Public per-scan checkout
              for Pipeline Trace is planned for v1.45.
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
