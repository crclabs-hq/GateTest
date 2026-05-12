"use client";

import { useState } from "react";

const scanPlans = [
  {
    id: "quick",
    name: "Quick Scan",
    price: "$29",
    period: "per scan",
    description:
      "Essential checks. Syntax, linting, secrets, and code quality.",
    modules: "4 modules",
    features: [
      "Syntax & compilation validation",
      "Linting checks",
      "Secret & credential detection",
      "Code quality analysis",
      "Detailed report with file & line numbers",
      "AI auto-fix PR included",
      "Pay only when scan completes",
    ],
    cta: "Run Quick Scan",
    highlight: false,
  },
  {
    id: "full",
    name: "Full Scan",
    price: "$99",
    period: "per scan",
    badge: "Most Popular",
    description:
      "Every module. Security, accessibility, SEO, AI code review, and more.",
    modules: "All 90 modules",

    features: [
      "Everything in Quick Scan",
      "Security (OWASP, XSS, SQLi, SSRF, ReDoS, TLS, cookies)",
      "Accessibility (WCAG 2.2 AAA)",
      "Supply chain — typosquats + license compliance",
      "IaC security — Dockerfile, K8s, Terraform",
      "CI/CD hardening — unpinned actions, permissions",
      "Auth flaws — JWT, bcrypt, cookies",
      "Migration safety — dangerous SQL patterns",
      "Flaky test detector",
      "AI code review by Claude",
      "AI auto-fix PR — Claude opens a PR with the fixes",
    ],
    cta: "Run Full Scan",
    highlight: true,
  },
  {
    id: "scan_fix",
    name: "Scan + Fix",
    price: "$199",
    period: "per scan",
    badge: "Deepest review",
    description:
      "Full Scan plus a second-Claude pair-review on every fix and a codebase-shape architecture report.",
    modules: "All 90 + depth review",
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
    name: "Nuclear",
    price: "$399",
    period: "per scan",
    badge: "Maximum depth",
    description:
      "The deepest scan we offer. Real Claude diagnosis, attack-chain correlation, mutation testing, chaos pass, executive summary.",
    modules: "All 90 + nuclear stack",
    features: [
      "Everything in Scan + Fix",
      "Real Claude diagnosis on every finding — no templated snippets, every fix reasoned from your specific evidence",
      "Cross-finding attack-chain correlation — textbook session-forgery / supply-chain / rotation-impossible vectors that per-finding scanners can never see",
      "Mutation testing — we mutate your source under your tests, prove your tests actually catch bugs",
      "Chaos / fuzz pass — adversarial inputs against HTTP routes, CLI args, file parsers; report what crashes",
      "CTO-readable executive summary — single document, plain language, real recommendations",
      "Best margin if you're shipping money or PII — the $399 hits all the high-stakes bug classes",
    ],
    cta: "Run Nuclear",
    highlight: false,
  },
];

const comingSoon = [
  "Live browser testing — real browser-powered page testing",
  "Visual regression — screenshot comparison between deploys",
  "Continuous monitoring — scan on every push, $49/month",
];

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
            We hold your card, run the scan, deliver the report, and Claude opens the fix PR.
            If we can&apos;t complete it, you pay nothing.
          </p>
        </div>

        {/* Trust badge */}
        <div className="flex justify-center mb-6">
          <div className="inline-flex items-center gap-2 badge-accent px-5 py-2 text-sm font-medium">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            Card hold only &mdash; charged after successful scan delivery
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

        {/* Scan tiers */}
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 mb-16 max-w-7xl mx-auto">
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
                className={`block w-full text-center py-3 px-5 rounded-xl font-semibold text-sm transition-all mb-6 cursor-pointer disabled:opacity-50 ${
                  plan.highlight
                    ? "btn-primary"
                    : "btn-secondary"
                }`}
              >
                {loading === plan.id ? "Redirecting..." : plan.cta}
              </button>

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

        {/* Coming Soon */}
        <div className="max-w-2xl mx-auto text-center">
          <h3 className="text-lg font-bold text-foreground mb-4">Coming Soon</h3>
          <div className="grid sm:grid-cols-2 gap-3">
            {comingSoon.map((item) => (
              <div key={item} className="flex items-start gap-2 text-left p-3 rounded-xl border border-dashed border-border bg-white">
                <span className="text-xs font-medium text-muted bg-surface-dark border border-border rounded-full px-2 py-0.5 shrink-0 mt-0.5">Soon</span>
                <span className="text-sm text-muted">{item}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Bottom trust line */}
        <p className="text-center text-xs text-muted mt-10">
          All scans include a detailed report and an AI fix PR. Payments processed securely via Stripe.
          Card hold released immediately if scan cannot complete.
        </p>
      </div>
    </section>
  );
}
