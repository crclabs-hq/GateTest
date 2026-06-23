"use client";

import { useState } from "react";

const scanPlans = [
  {
    id: "scan_fix",
    name: "Scan + Fix",
    price: "$199",
    period: "per scan",
    badge: "Deepest review",
    description:
      "Full Scan plus a second-Claude pair-review on every fix and a codebase-shape architecture report.",
    modules: "All 110 + depth review",
    features: [
      "Everything in Full Scan",
      "Pair-review critique on every fix — second Claude scores correctness, completeness, readability, test coverage",
      "Architecture annotator — design observations on codebase shape (layering, duplication, god objects)",
      "Both reports posted as separate PR comments",
      "Iterative fix loop with N retries — Claude learns from its own failed attempts",
      "Cross-file syntax + scanner gates — broken fixes never ship",
      "Regression test for every fix — your suite gets stronger when you merge",
    ],
    cta: "Run Scan + Fix",
    highlight: false,
  },
  {
    id: "nuclear",
    name: "Forensic Scan",
    price: "$399",
    period: "per scan",
    badge: "Maximum depth",
    description:
      "The deepest scan we offer. Real Claude diagnosis, attack-chain correlation, board-ready CISO report, executive summary.",
    modules: "All 110 + forensic stack",
    features: [
      "Everything in Scan + Fix",
      "Real Claude diagnosis on every finding — no templated snippets, every fix reasoned from your specific evidence",
      "Cross-finding attack-chain correlation — textbook session-forgery / supply-chain / rotation-impossible vectors that per-finding scanners can never see",
      "CTO-readable executive summary — single document, plain language, real recommendations",
      "Board-ready CISO report (OWASP Top 10, SOC2, CIS v8, 30/60/90-day roadmap) — attached to every PR",
      "Best margin if you're shipping money or PII — the $399 hits all the high-stakes bug classes",
      "Also available via the GitHub Action: mutation testing (mutates your source against your tests) and chaos / fuzz pass (adversarial inputs against HTTP routes, CLI args, file parsers) — runs wherever your CI runs, set mutation: true / chaos: true on the action",
    ],
    cta: "Run Forensic Scan",
    highlight: false,
  },
];

// Continuous tier — LIVE per Craig's green light 2026-06-12. Stripe
// subscription checkout (mode=subscription, $49/mo, cancel anytime).
// Economics: unlimited deterministic scans cost ~nothing; AI reviews are
// metered by a monthly allowance (continuous_ai_ledger, default $10/mo)
// so a hammered subscription still holds ~70%+ margin worst-case.
const continuousPlan = {
  name: "Continuous",
  price: "$49",
  period: "/ month",
  description:
    "Scan every push. Unlimited deterministic scans, monthly AI-review allowance, cancel anytime.",
  modules: "Subscription · 110 modules on every push",
  features: [
    "Scan on every push (GitHub App or Gluecron-host)",
    "Unlimited deterministic scans — all 110 modules, never throttled",
    "Monthly Claude AI-review allowance included",
    "Trend dashboard — see your gate getting greener week-over-week",
    "Fix PRs available per-scan on top whenever you want them",
    "Cancel anytime — no lock-in",
  ],
  cta: "Start Continuous — $49/mo",
  comingSoon: false,
};


export default function Pricing() {
  const [repoUrl, setRepoUrl] = useState("");
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleCheckout(tierId: string) {
    if (!repoUrl || !(repoUrl.includes("github.com") || repoUrl.includes("gluecron.com"))) {
      setError("Please enter a valid GitHub or Gluecron repository URL above");
      const input = document.getElementById("repo-url");
      if (input) {
        input.scrollIntoView({ behavior: "smooth", block: "center" });
        input.focus();
      }
      return;
    }

    setLoading(tierId);
    setError(null);

    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: tierId, repoUrl }),
      });

      const data = await res.json();

      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      } else {
        setError(data.error || "Checkout is not available right now. Please try again shortly.");
      }
    } catch {
      setError("Could not reach checkout. Please try again shortly.");
    } finally {
      setLoading(null);
    }
  }

  return (
    <section id="pricing" className="py-24 px-6 section-accent">
      <div className="relative z-10 mx-auto max-w-5xl">
        <div className="text-center mb-6">
          <span className="text-sm font-semibold text-accent uppercase tracking-wider">
            Pricing
          </span>
          <h2 className="text-3xl sm:text-4xl font-bold mt-4 mb-4 text-foreground">
            Pay when it&apos;s done. <span className="gradient-text">Not before.</span>
          </h2>
          <p className="text-muted text-lg max-w-2xl mx-auto">
            The full 111-module scan is <strong className="text-foreground">free</strong> via the CLI.
            Cloud tiers add Claude-powered fix PRs, pair-review, forensic diagnosis, and board-ready reports.
            One-time payment per scan — no subscription, no auto-renew.
          </p>
        </div>

        {/* Trust badge */}
        <div className="flex justify-center mb-6">
          <div className="inline-flex items-center gap-2 badge-accent px-5 py-2 text-sm font-medium">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            One-time payment via Stripe &mdash; no subscription
          </div>
        </div>

        {/* Repo URL input */}
        <div className="max-w-xl mx-auto mb-12">
          <label htmlFor="repo-url" className="block text-sm font-medium text-muted mb-2 text-center">
            1. Enter your GitHub or Gluecron repo URL
          </label>
          <input
            id="repo-url"
            type="url"
            value={repoUrl}
            onChange={(e) => { setRepoUrl(e.target.value); setError(null); }}
            placeholder="https://github.com/your-org/your-repo"
            className={`w-full px-4 py-3 rounded-xl border bg-white text-foreground placeholder:text-muted/50 focus:outline-none text-sm transition-colors ${
              error ? "border-danger focus:border-danger" : "border-border-strong focus:border-accent"
            }`}
          />
          {error && <p className="text-sm text-danger mt-2 text-center">{error}</p>}
          <p className="text-xs text-muted mt-2 text-center">2. Choose a scan tier below</p>
        </div>

        {/* Free CLI callout */}
        <div className="max-w-3xl mx-auto mb-10">
          <div className="rounded-2xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/[0.05] to-transparent p-6">
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                  <span className="text-xs font-semibold text-emerald-600 uppercase tracking-wider">Free — no account needed</span>
                </div>
                <h3 className="text-lg font-bold text-foreground mb-1">Full 111-module scan, runs locally on your machine</h3>
                <p className="text-sm text-muted">Zero cost. Zero lock-in. All 111 checks, instant output, stays on your machine. Use it before every PR.</p>
              </div>
              <div className="shrink-0">
                <code className="block bg-foreground/5 border border-border-strong rounded-xl px-4 py-3 text-sm font-mono text-foreground whitespace-nowrap">
                  npx @gatetest/cli --suite full
                </code>
              </div>
            </div>
          </div>
        </div>

        {/* Scan tiers */}
        <div className="grid md:grid-cols-2 gap-6 mb-16 max-w-3xl mx-auto">
          {scanPlans.map((plan) => (
            <div
              key={plan.name}
              className={`rounded-2xl p-6 transition-all flex flex-col ${
                plan.highlight
                  ? "card-highlight"
                  : "card"
              }`}
            >
              {plan.highlight && (
                <div className="text-xs font-semibold text-accent uppercase tracking-wider mb-3">
                  {plan.badge}
                </div>
              )}

              <h3 className="text-lg font-bold text-foreground mb-1">{plan.name}</h3>
              <div className="flex items-baseline gap-1 mb-1">
                <span className="text-3xl font-bold gradient-text">{plan.price}</span>
                <span className="text-sm text-muted">{plan.period}</span>
              </div>
              <div className="text-xs text-accent font-medium mb-3">
                {plan.modules}
              </div>
              <p className="text-sm text-muted mb-5">{plan.description}</p>

              <button
                onClick={() => handleCheckout(plan.id)}
                disabled={loading === plan.id}
                className={`block w-full text-center py-3 px-5 rounded-xl font-semibold text-sm transition-all mb-2 cursor-pointer disabled:opacity-50 ${
                  plan.highlight
                    ? "btn-primary"
                    : "btn-secondary"
                }`}
              >
                {loading === plan.id ? "Redirecting..." : plan.cta}
              </button>
              <p className="text-[11px] leading-snug text-muted mb-5 text-center">
                By continuing you agree to our{" "}
                <a href="/legal/terms" className="underline hover:text-foreground">Terms</a>,{" "}
                <a href="/legal/privacy" className="underline hover:text-foreground">Privacy Policy</a>, and{" "}
                <a href="/legal/refunds" className="underline hover:text-foreground">Refund Policy</a>.
              </p>

              <ul className="space-y-2.5 mt-auto">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm">
                    <span className="text-success mt-0.5 shrink-0">&#10003;</span>
                    <span className="text-muted">{feature}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Enterprise — sales-led anchor tile. Different commercial shape
            (custom pricing, dedicated infra, SLA), positioned ABOVE the
            scan tiers' ceiling so $399 Forensic Scan stops feeling like the
            maximum. No checkout flow — mailto contact for qualification. */}
        <div className="max-w-3xl mx-auto mb-6">
          <div className="rounded-2xl border-2 border-dashed border-foreground/20 bg-gradient-to-br from-foreground/[0.03] to-transparent p-6 sm:p-8">
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs font-semibold text-foreground/70 uppercase tracking-wider">
                    Enterprise
                  </span>
                  <span className="text-[11px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-foreground/5 text-foreground/70 border border-foreground/10">
                    Custom pricing
                  </span>
                </div>
                <h3 className="text-xl font-bold text-foreground mb-1">
                  Self-hosted scanner &middot; private infra &middot; SLA
                </h3>
                <p className="text-sm text-muted">
                  Everything in Forensic Scan, run inside your network or VPC. Dedicated account manager, signed SLA, custom modules, custom suppression policies, audit log export. For regulated industries (fintech, healthcare, defence) and orgs with strict data-residency rules.
                </p>
              </div>
              <div className="w-full sm:w-auto sm:max-w-md flex-1">
                <ul className="space-y-1.5 mb-4">
                  {[
                    "On-prem or private-VPC deployment",
                    "Dedicated infra, no shared compute",
                    "Signed SLA, support response targets",
                    "Custom modules + suppression policies",
                  ].map((f) => (
                    <li key={f} className="flex items-start gap-2 text-xs text-muted">
                      <span className="text-success mt-0.5 shrink-0">&#10003;</span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <a
                  href="mailto:enterprise@gatetest.ai?subject=Enterprise%20enquiry"
                  className="btn-secondary block w-full text-center py-3 px-5 text-sm font-semibold"
                >
                  Talk to sales &rarr;
                </a>
              </div>
            </div>
          </div>
        </div>

        {/* Pen Test — coming soon. Engine is built (live SQL injection, XSS,
            path traversal, auth bypass, IDOR); customer-facing launch
            pending lawyer-drafted ToS / RoE / cyber insurance / DNS-TXT
            ownership verification flow. Listing here as "coming soon" gives
            us a teaser without taking money for a service that doesn't have
            the legal cover yet. */}
        <div className="max-w-3xl mx-auto mb-6">
          <div className="rounded-2xl border-2 border-dashed border-rose-500/30 bg-gradient-to-br from-rose-500/[0.04] to-transparent p-6 sm:p-8 opacity-90">
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs font-semibold text-rose-600 uppercase tracking-wider">
                    Active Testing
                  </span>
                  <span className="text-[11px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-700 border border-amber-500/30">
                    Coming soon
                  </span>
                </div>
                <h3 className="text-xl font-bold text-foreground mb-1">
                  Pen Test &middot; live exploit probes &middot; $999
                </h3>
                <p className="text-sm text-muted">
                  Everything in Forensic Scan, PLUS live active probing of your URL with industry-standard payload classes — SQL injection (error/boolean/timing), reflected XSS, path traversal, IDOR, auth-bypass headers, open redirect, CSRF. Signed Rules of Engagement, DNS-TXT ownership verification, full audit trail. Most of the value of a $5,000 human pen test for $999.
                </p>
              </div>
              <div className="w-full sm:w-auto sm:max-w-md flex-1">
                <ul className="space-y-1.5 mb-4 text-sm text-muted">
                  <li>· Live payload probes (non-destructive)</li>
                  <li>· DNS-TXT domain-ownership verification</li>
                  <li>· Signed Rules of Engagement</li>
                  <li>· Per-host rate limiting (don&apos;t take down your prod)</li>
                  <li>· Cryptographic audit log of every probe</li>
                </ul>
                <button
                  type="button"
                  disabled
                  className="btn-secondary block w-full text-center py-3 px-5 text-sm font-semibold opacity-60 cursor-not-allowed"
                >
                  Notify me when live
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Continuous subscription — separate card, different commercial shape */}
        <div className="max-w-3xl mx-auto mb-12">
          <div className="rounded-2xl border-2 border-accent/40 bg-gradient-to-br from-accent/[0.06] to-transparent p-6 sm:p-8">
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs font-semibold text-accent uppercase tracking-wider">
                    Subscription
                  </span>
                  {continuousPlan.comingSoon && (
                    <span className="text-[11px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-700 border border-amber-500/30">
                      Coming soon
                    </span>
                  )}
                </div>
                <h3 className="text-xl font-bold text-foreground mb-1">
                  {continuousPlan.name}
                </h3>
                <div className="flex items-baseline gap-1 mb-2">
                  <span className="text-3xl font-bold gradient-text">
                    {continuousPlan.price}
                  </span>
                  <span className="text-sm text-muted">
                    {continuousPlan.period}
                  </span>
                </div>
                <p className="text-sm text-muted">
                  {continuousPlan.description}
                </p>
              </div>
              <div className="w-full sm:w-auto sm:max-w-md flex-1">
                <ul className="space-y-1.5 mb-4">
                  {continuousPlan.features.slice(0, 6).map((f) => (
                    <li
                      key={f}
                      className="flex items-start gap-2 text-xs text-muted"
                    >
                      <span className="text-success mt-0.5 shrink-0">
                        &#10003;
                      </span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <button
                  onClick={() => handleCheckout("continuous")}
                  disabled={loading === "continuous"}
                  className="btn-secondary block w-full text-center py-3 px-5 text-sm font-semibold disabled:opacity-60"
                >
                  {loading === "continuous" ? "Redirecting…" : (
                    <>{continuousPlan.cta} &rarr;</>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom trust line */}
        <p className="text-center text-xs text-muted mt-10">
          The full 111-module deterministic scan is free via <code className="font-mono">npx @gatetest/cli</code>.
          The cloud tiers add Claude-powered auto-fix PRs, pair-review, forensic diagnosis,
          and executive reports. One-time payment per scan via Stripe; Continuous is $49/mo,
          cancel anytime. Once a scan delivers, the service is rendered &mdash; refunds at
          our discretion for non-delivery only.
        </p>
      </div>
    </section>
  );
}
