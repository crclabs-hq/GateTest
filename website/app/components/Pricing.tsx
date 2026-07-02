"use client";

import { useState } from "react";
import Link from "next/link";

// ── Tier definitions — must stay in sync with /api/checkout/route.ts TIERS ──

const TIERS = [
  {
    key: "quick",
    name: "Quick Scan",
    price: "$29",
    period: "one-time",
    badge: null as string | null,
    tagline: "4 modules. Instant result.",
    description:
      "Syntax, linting, secrets, code quality. The fast sanity check before you ship.",
    features: [
      "4 core modules",
      "Syntax & linting validation",
      "Secret detection",
      "Code quality checks",
      "~10 second scan",
      "Full findings report",
    ],
    notIncluded: ["Auto-fix PR", "AI code review", "Full security deep-scan"],
    cta: "Run Quick Scan",
    highlight: false,
    accentClass: "border-border hover:border-accent/40",
    badgeClass: "",
  },
  {
    key: "full",
    name: "Full Scan",
    price: "$99",
    period: "one-time",
    badge: "Most Popular",
    tagline: "All 102 modules. Complete picture.",
    description:
      "Security, supply chain, auth, CI hardening, AI code review, and 95+ more checks.",
    features: [
      "All 102 modules",
      "Security & supply-chain audit",
      "AI code review (Claude)",
      "Auth flaw & session security",
      "CI/CD hardening checks",
      "SQL migration safety",
      "Kubernetes & Terraform scan",
      "~60 second scan",
      "Full findings report",
    ],
    notIncluded: ["Auto-fix PR", "Pair-review critique"],
    cta: "Run Full Scan",
    highlight: true,
    accentClass: "border-accent ring-1 ring-accent/30",
    badgeClass: "bg-accent text-white",
  },
  {
    key: "scan_fix",
    name: "Scan + Fix",
    price: "$199",
    period: "one-time",
    badge: null as string | null,
    tagline: "Finds it. Fixes it. Opens the PR.",
    description:
      "Everything in Full, plus Claude rewrites the code, adds regression tests, and opens a PR.",
    features: [
      "Everything in Full Scan",
      "Iterative Claude fix loop",
      "Auto-fix PR with regression tests",
      "Bidirectional test certification",
      "Pair-review critique on every fix",
      "Architecture annotator report",
      "Fix-attempt log in PR",
    ],
    notIncluded: ["Per-finding diagnosis", "Attack-chain correlation", "CISO report"],
    cta: "Scan + Fix My Repo",
    highlight: false,
    accentClass: "border-border hover:border-accent/40",
    badgeClass: "",
  },
  {
    key: "nuclear",
    name: "Nuclear",
    price: "$399",
    period: "one-time",
    badge: "Maximum Depth",
    tagline: "CTO-ready. CISO-ready. Board-ready.",
    description:
      "Real Claude diagnosis on every finding. Attack-chain correlation. Executive summary. CISO report.",
    features: [
      "Everything in Scan + Fix",
      "Claude diagnosis per finding",
      "Cross-finding attack-chain correlation",
      "Executive summary (CTO-readable)",
      "CISO report (OWASP / SOC2 / CIS v8)",
      "Mutation testing via GitHub Action",
      "Chaos / fuzz pass via GitHub Action",
    ],
    notIncluded: [],
    cta: "Go Nuclear",
    highlight: false,
    accentClass: "border-border hover:border-accent/40",
    badgeClass: "bg-foreground text-background",
  },
];

// ── Checkout logic ────────────────────────────────────────────────────────────

async function startCheckout(tier: string, repoUrl: string): Promise<string | null> {
  try {
    const res = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier, repoUrl }),
    });
    const data = await res.json();
    if (data.checkoutUrl) return data.checkoutUrl;
    return null;
  } catch {
    return null;
  }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function CheckMark() {
  return (
    <svg className="w-4 h-4 text-accent shrink-0 mt-0.5" viewBox="0 0 16 16" fill="currentColor">
      <path d="M6.5 11.5L3 8l1-1 2.5 2.5 6-6 1 1z" />
    </svg>
  );
}

function CrossMark() {
  return (
    <svg className="w-4 h-4 text-muted/50 shrink-0 mt-0.5" viewBox="0 0 16 16" fill="currentColor">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function RepoInput({
  tierKey,
  cta,
  onClose,
}: {
  tierKey: string;
  cta: string;
  onClose: () => void;
}) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) { setError("Enter a GitHub repository URL"); return; }
    if (!trimmed.includes("github.com")) { setError("Must be a github.com URL"); return; }
    setLoading(true);
    setError("");
    const checkoutUrl = await startCheckout(tierKey, trimmed);
    if (checkoutUrl) {
      window.location.href = checkoutUrl;
    } else {
      setError("Checkout unavailable — check Stripe is configured");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 space-y-3">
      <div>
        <label className="block text-xs text-muted mb-1.5 font-medium">
          GitHub repository URL
        </label>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/org/repo"
          className="w-full px-3 py-2.5 rounded-lg border border-border bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent placeholder:text-muted/50"
          autoFocus
        />
        {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
      </div>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={loading}
          className="flex-1 py-2.5 px-4 rounded-lg bg-accent hover:bg-accent-light text-white text-sm font-semibold transition-colors disabled:opacity-60"
        >
          {loading ? "Opening Stripe…" : `Pay & ${cta}`}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-2.5 rounded-lg border border-border text-muted hover:text-foreground text-sm transition-colors"
        >
          ✕
        </button>
      </div>
      <p className="text-[11px] text-muted/70 text-center">
        Stripe-secured · one-time payment · no subscription
      </p>
    </form>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Pricing() {
  const [activeInput, setActiveInput] = useState<string | null>(null);

  function toggleInput(key: string) {
    setActiveInput((prev) => (prev === key ? null : key));
  }

  return (
    <section id="pricing" className="py-24 px-6 border-t border-border/30">
      <div className="mx-auto max-w-6xl">

        {/* Header */}
        <div className="text-center mb-14">
          <h2 className="text-3xl sm:text-4xl font-bold mb-4">
            One-time payment. <span className="text-accent">No subscription.</span>
          </h2>
          <p className="text-muted max-w-xl mx-auto">
            Pay once per scan. We find bugs, open fix PRs, and deliver a full
            report. If the scan fails, contact us — we re-run or credit.
          </p>
        </div>

        {/* 4-tier grid */}
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5 items-stretch">
          {TIERS.map((tier) => (
            <div
              key={tier.key}
              className={`relative flex flex-col rounded-2xl border bg-surface-solid p-6 transition-all duration-200 ${tier.accentClass}`}
            >
              {/* Badge */}
              {tier.badge && (
                <span
                  className={`absolute -top-3 left-1/2 -translate-x-1/2 text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wider ${tier.badgeClass}`}
                >
                  {tier.badge}
                </span>
              )}

              {/* Name + price */}
              <div className="mb-5">
                <h3 className="text-base font-bold text-foreground">{tier.name}</h3>
                <p className="text-xs text-muted mt-0.5 min-h-[32px]">{tier.tagline}</p>
                <div className="flex items-baseline mt-4 gap-1">
                  <span className="text-4xl font-black text-foreground">{tier.price}</span>
                  <span className="text-muted text-xs">/ {tier.period}</span>
                </div>
              </div>

              {/* Description */}
              <p className="text-xs text-muted mb-5 leading-relaxed min-h-[48px]">
                {tier.description}
              </p>

              {/* Features */}
              <ul className="space-y-2 text-sm text-foreground-secondary mb-4 flex-grow">
                {tier.features.map((f) => (
                  <li key={f} className="flex items-start gap-2">
                    <CheckMark />
                    <span>{f}</span>
                  </li>
                ))}
                {tier.notIncluded.map((f) => (
                  <li key={f} className="flex items-start gap-2 opacity-40">
                    <CrossMark />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>

              {/* CTA or inline form */}
              {activeInput === tier.key ? (
                <RepoInput
                  tierKey={tier.key}
                  cta={tier.cta}
                  onClose={() => setActiveInput(null)}
                />
              ) : (
                <button
                  onClick={() => toggleInput(tier.key)}
                  className={`mt-auto w-full py-3 px-4 rounded-xl text-sm font-semibold transition-all duration-200 ${
                    tier.highlight
                      ? "bg-accent hover:bg-accent-light text-white shadow-sm"
                      : "border border-border hover:border-accent/50 hover:text-accent text-foreground"
                  }`}
                >
                  {tier.cta}
                </button>
              )}
            </div>
          ))}
        </div>

        {/* Continuous subscription callout */}
        <div className="mt-8 rounded-2xl border border-border bg-background-alt px-8 py-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-base font-bold text-foreground">Continuous Guard</span>
              <span className="text-xs font-semibold bg-accent/10 text-accent px-2 py-0.5 rounded-full">$49 / month</span>
            </div>
            <p className="text-sm text-muted max-w-lg">
              Scan every push automatically via GitHub App. Commit statuses, PR
              comments, and a gate that blocks broken code before it merges.
              Unlimited scans. Cancel any time.
            </p>
          </div>
          <Link
            href="/github/setup"
            className="shrink-0 px-6 py-3 rounded-xl border border-border hover:border-accent/50 hover:text-accent text-sm font-semibold text-foreground transition-all duration-200 whitespace-nowrap"
          >
            Install GitHub App →
          </Link>
        </div>

        {/* Honesty footnote */}
        <p className="text-center text-xs text-muted/60 mt-8">
          All repo scans require a public GitHub repository URL.
          Mutation testing and chaos/fuzz pass run via the GitHub Action on
          Nuclear tier — they need a CI runner, not a serverless function.{" "}
          <a href="#faq" className="underline underline-offset-2 hover:text-muted">
            FAQ ↓
          </a>
        </p>
      </div>
    </section>
  );
}
