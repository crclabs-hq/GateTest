"use client";

// Pricing tiers mirror the checkout backend exactly — website/app/api/checkout/route.ts TIERS.
// Source of truth for prices: that TIERS map. Keep these in sync (Bible Forbidden #17).
//   quick $29 · full $99 · scan_fix $199 · nuclear/Forensic $399 (one-time) · continuous $49/mo · mcp $29/mo
import { useState } from "react";

export const pricingScans = [
  {
    name: "Quick Scan",
    price: "$29",
    period: "per run",
    description: "4-module rapid scan: syntax errors, lint violations, exposed secrets, and code quality. Results in seconds.",
    features: [
      "Syntax Error Detection",
      "Lint Violation Scanner",
      "Secret & API Key Exposure",
      "Code Quality Baseline",
      "JSON / SARIF / JUnit output via the CLI & GitHub Action",
      "Scan-only (no auto-fix)"
    ],
    cta: "Run Quick Scan",
    popular: false,
    tier: "quick"
  },
  {
    name: "Full Scan",
    price: "$99",
    period: "per run",
    description: "The full engine suite — 88 modules: security, supply chain, auth hardening, CI security, AI safety, and more. (Mutation + chaos ship via the GitHub Action.)",
    features: [
      "Full 88-Module Engine Suite",
      "Security & Auth Hardening",
      "Supply Chain & Dependency Audit",
      "CI/CD & Container Security",
      "AI Safety & Prompt Protection",
      "Scan-only (no auto-fix)"
    ],
    cta: "Run Full Scan",
    popular: false,
    tier: "full"
  },
  {
    name: "Scan + Fix",
    price: "$199",
    period: "per run",
    description: "Full-suite deep scan with iterative auto-fix PR, pair-review agent, and architecture annotations.",
    features: [
      "Full 88-Module Engine Suite",
      "Iterative Fix Loop (up to 3 retries per finding)",
      "Cross-Fix Syntax + Scanner Gate",
      "Regression Test Generated per Fix",
      "Pair-Review Agent (4-axis critique)",
      "Architecture Annotator Report",
      "Automated PR with Before/After Table"
    ],
    cta: "Run Scan + Fix",
    popular: true,
    tier: "scan_fix"
  },
  {
    name: "Forensic Scan",
    price: "$399",
    period: "per run",
    description: "Everything in Scan+Fix plus Claude-driven per-finding diagnosis, attack-chain correlation, and executive summary.",
    features: [
      "Everything in Scan + Fix",
      "Per-Finding Claude Diagnosis",
      "Cross-Finding Correlation (attack chains)",
      "Executive Summary (CTO-ready)",
      "Board-Ready CISO Report",
      "Mutation Testing via GitHub Action",
      "Chaos/Fuzz Pass via GitHub Action"
    ],
    cta: "Run Forensic Scan",
    popular: false,
    tier: "nuclear"
  }
];

export const continuousPlan = {
  name: "Continuous",
  price: "$49",
  frequency: "per month",
  description: "Every repo in your org — one flat price, no seats, no per-repo billing. Unlimited deterministic scans on every push; AI reviews metered by a shared monthly allowance.",
  features: [
    "All Repos In Your Org — One Flat Price",
    "Unlimited Deterministic Push Scans",
    "AI Review Allowance ($10/mo, shared org-wide)",
    "Continuous AI Ledger Protection",
    "Real-Time Pipeline Trace Feed"
  ],
  cta: "Activate Continuous",
  tier: "continuous"
};

export const mcpPlan = {
  name: "MCP Integration",
  price: "$29",
  frequency: "per month",
  description: "Give Claude eyes, ears & hands: the GateTest engine inside Claude Code, Cursor, or any MCP agent — see the page, read production errors, and prove every fix worked.",
  features: [
    "Eyes — screenshot any URL or localhost",
    "Ears — pull Sentry / Datadog / Rollbar errors",
    "Hands — verify_fix proves the fix worked",
    "Full-suite local scans — 88 modules (vs the free 41-module quick suite)",
    "AI fix + diagnose (fix_issue, explain_finding)",
    "API key delivered by email instantly"
  ],
  cta: "Get MCP Access",
  tier: "mcp"
};

// ---------------------------------------------------------------------------
// Checkout: POST /api/checkout { tier, repoUrl } → { checkoutUrl } → redirect.
// Scan + continuous tiers need a repo URL; MCP is key-based (no repo).
// Returns an error string, or redirects (and never resolves) on success.
// ---------------------------------------------------------------------------
async function startCheckout(tier: string, repoUrl?: string): Promise<string> {
  try {
    const res = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(repoUrl ? { tier, repoUrl } : { tier }),
    });
    const data = (await res.json()) as { checkoutUrl?: string; error?: string };
    if (data.checkoutUrl) {
      window.location.href = data.checkoutUrl;
      return ""; // redirecting
    }
    return data.error || "Could not start checkout. Please try again.";
  } catch {
    return "Network error. Please try again.";
  }
}

function TierCard({
  name,
  price,
  period,
  description,
  features,
  cta,
  tier,
  popular = false,
  badge,
  needsRepo,
}: {
  name: string;
  price: string;
  period: string;
  description: string;
  features: string[];
  cta: string;
  tier: string;
  popular?: boolean;
  badge?: string;
  needsRepo: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setError(null);
    // MCP → straight to key checkout. No repo needed.
    if (!needsRepo) {
      setBusy(true);
      const err = await startCheckout(tier);
      if (err) { setError(err); setBusy(false); }
      return;
    }
    // Scan/continuous → reveal the repo input first, then check out.
    if (!expanded) { setExpanded(true); return; }
    const url = repo.trim();
    if (!(url.includes("github.com") || url.includes("gluecron.com"))) {
      setError("Enter a public GitHub or Gluecron repo URL.");
      return;
    }
    setBusy(true);
    const err = await startCheckout(tier, url);
    if (err) { setError(err); setBusy(false); }
  }

  return (
    <div
      className={`flex flex-col p-6 rounded-2xl border bg-[var(--surface-solid)] transition-all duration-300 relative ${
        popular
          ? "border-[var(--accent)] shadow-lg shadow-[var(--accent)]/10 ring-1 ring-[var(--accent)]/20"
          : "border-[var(--border)] hover:border-[var(--border-strong)] hover:shadow-md"
      }`}
    >
      {(popular || badge) && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-[var(--accent)] text-white text-[11px] font-bold px-3 py-1 rounded-full uppercase tracking-wider whitespace-nowrap">
          {badge || "Most Popular"}
        </span>
      )}
      <div className="mb-5">
        <h3 className="text-lg font-bold text-[var(--foreground)]">{name}</h3>
        <p className="text-xs text-[var(--muted)] mt-1.5 min-h-[48px] leading-relaxed">{description}</p>
      </div>
      <div className="flex items-baseline mb-5">
        <span className="text-4xl font-black text-[var(--accent)] tracking-tight">{price}</span>
        <span className="text-[var(--muted)] text-xs ml-2">/ {period}</span>
      </div>
      <ul className="space-y-2.5 text-sm text-[var(--foreground-secondary)] mb-6 flex-grow">
        {features.map((feature, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="text-[var(--accent)] mt-0.5 flex-shrink-0" aria-hidden>✓</span>
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      {expanded && needsRepo && (
        <input
          type="url"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          placeholder="https://github.com/owner/repo"
          aria-label="Repository URL"
          className="w-full mb-2 px-3 py-2.5 rounded-lg border border-[var(--border-strong)] text-sm bg-white text-[var(--foreground)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/40 focus:border-[var(--accent)]"
        />
      )}
      {error && <p className="text-[var(--danger)] text-xs mb-2">{error}</p>}

      <button
        onClick={go}
        disabled={busy}
        className={`w-full py-3 rounded-xl font-semibold text-sm transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed ${
          popular
            ? "bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white shadow-md shadow-[var(--accent)]/20"
            : "bg-[var(--background-alt)] hover:bg-[var(--border)] text-[var(--foreground)] border border-[var(--border)]"
        }`}
      >
        {busy ? "Starting…" : expanded && needsRepo ? "Continue to checkout" : cta}
      </button>
    </div>
  );
}

export default function Pricing() {
  return (
    <section id="pricing" className="max-w-7xl mx-auto my-16 px-4">
      <h2 className="text-3xl md:text-4xl font-black mb-2 text-center text-[var(--foreground)] tracking-tight">
        Pay only when it fixes something
      </h2>
      <p className="text-[var(--muted)] text-center mb-10 max-w-2xl mx-auto text-sm leading-relaxed">
        The engine is free and open-source if you run it yourself —{" "}
        <code className="bg-[var(--background-alt)] text-[var(--accent)] px-1.5 py-0.5 rounded text-xs font-mono border border-[var(--border)]">
          npx @gatetest/cli --suite full
        </code>
        . Quick and Full below run the same scan on our infra: zero setup, a shareable hosted report, nothing to install. Pay per run for auto-fix and deeper AI analysis, or subscribe for continuous protection.
      </p>

      {/* One-time scan tiers */}
      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-5 items-stretch">
        {pricingScans.map((plan) => (
          <TierCard key={plan.tier} {...plan} needsRepo />
        ))}
      </div>

      {/* Subscriptions */}
      <p className="text-center text-xs uppercase tracking-wider text-[var(--muted)] mt-12 mb-5 font-semibold">
        Subscriptions
      </p>
      <div className="grid md:grid-cols-2 gap-5 items-stretch max-w-3xl mx-auto">
        <TierCard
          {...mcpPlan}
          period={mcpPlan.frequency}
          badge="Claude Integration"
          needsRepo={false}
        />
        <TierCard
          {...continuousPlan}
          period={continuousPlan.frequency}
          needsRepo
        />
      </div>

      {/* Enterprise — contact-based, no fixed price (Craig 2026-07-23).
          Deliberately NOT a Stripe tier: enterprise terms (scan volume,
          AI-review budget, invoicing, support) are negotiated per deal. */}
      <div className="mx-auto max-w-5xl mt-8">
        <div className="rounded-2xl border border-border bg-surface-solid p-6 sm:p-8 flex flex-col sm:flex-row items-start sm:items-center gap-6">
          <div className="flex-1">
            <h3 className="text-xl font-bold mb-1">Enterprise</h3>
            <p className="text-muted text-sm leading-relaxed">
              Running GateTest across a large organisation? We&apos;ll shape a plan
              around you: custom scan volume, a raised AI-review budget,
              priority support, and invoicing on your terms.
            </p>
          </div>
          <a
            href="mailto:hello@gatetest.ai?subject=GateTest%20Enterprise"
            className="shrink-0 inline-flex items-center justify-center px-6 py-3 rounded-xl border border-border font-semibold text-sm hover:border-accent hover:text-accent transition-colors"
          >
            Talk to us
          </a>
        </div>
      </div>
    </section>
  );
}
