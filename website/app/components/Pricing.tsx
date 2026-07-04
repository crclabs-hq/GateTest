// Pricing tiers mirror the checkout backend exactly — website/app/api/checkout/route.ts TIERS.
// Source of truth for prices: that TIERS map. Keep these in sync (Bible Forbidden #17).
//   quick $29 · full $99 · scan_fix $199 · nuclear/Forensic $399 (one-time) · continuous $49/mo · mcp $29/mo
export const pricingScans = [
  {
    name: "Scan + Fix",
    price: "$199",
    period: "per run",
    description: "111-module deep scan with iterative auto-fix PR, pair-review agent, and architecture annotations.",
    features: [
      "111 Specialized Engineering Modules",
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
  name: "Continuous Guard",
  price: "$49",
  frequency: "per month",
  description: "Unlimited deterministic scans on every push. AI reviews metered by monthly allowance.",
  features: [
    "Unlimited Deterministic Push Scans",
    "AI Review Allowance ($10/mo default)",
    "Continuous AI Ledger Protection",
    "Real-Time Pipeline Trace Feed"
  ],
  cta: "Activate Continuous"
};

export const mcpPlan = {
  name: "MCP Integration",
  price: "$29",
  frequency: "per month",
  description: "Give Claude eyes, ears & hands. Full 120-module scans + AI fix + screenshot + production errors — all inside your AI assistant.",
  features: [
    "👁 Eyes — Screenshot any URL or localhost",
    "👂 Ears — Sentry / Datadog / Rollbar errors",
    "🤝 Hands — verify_fix proves the fix worked",
    "Full 120-module local scans (vs 4 free)",
    "AI fix + diagnose (fix_issue, explain_finding)",
    "API key delivered by email instantly"
  ],
  cta: "Get MCP Access →",
  href: "/api/checkout"
};

export default function Pricing() {
  return (
    <div className="p-8 bg-neutral-900 text-white rounded-xl border border-neutral-800 shadow-2xl max-w-7xl mx-auto my-12">
      <h2 className="text-3xl font-extrabold mb-2 text-center text-emerald-400 tracking-tight">
        Predictable, Automation-First Pricing
      </h2>
      <p className="text-neutral-400 text-center mb-4 max-w-xl mx-auto text-sm">
        Quick and Full scans are free via the open-source CLI —
        install with{' '}
        <code className="bg-neutral-800 text-emerald-300 px-1.5 py-0.5 rounded text-xs font-mono">
          npx @gatetest/cli --suite full
        </code>
        . Pay only when you want auto-fix or deeper AI analysis.
      </p>

      {/* Main Pricing Grid — 4 columns on large screens */}
      <div className="grid lg:grid-cols-4 gap-6 items-stretch mt-8">

        {/* Paid Scan Tiers */}
        {pricingScans.map((plan, idx) => (
          <div
            key={idx}
            className={`flex flex-col p-6 rounded-xl border transition-all duration-300 relative ${
              plan.popular
                ? 'border-emerald-500 bg-neutral-800/40 ring-1 ring-emerald-500/30'
                : 'border-neutral-800 bg-neutral-950/40 hover:border-neutral-700'
            }`}
          >
            {plan.popular && (
              <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-emerald-500 text-neutral-950 text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wider">
                Most Popular
              </span>
            )}
            <div className="mb-6">
              <h3 className="text-xl font-bold text-neutral-100">{plan.name}</h3>
              <p className="text-xs text-neutral-400 mt-1 min-h-[40px]">{plan.description}</p>
            </div>
            <div className="flex items-baseline mb-6">
              <span className="text-4xl font-black text-emerald-400">{plan.price}</span>
              <span className="text-neutral-500 text-xs ml-2">/ {plan.period}</span>
            </div>
            <ul className="space-y-3 text-sm text-neutral-300 mb-8 flex-grow">
              {plan.features.map((feature, i) => (
                <li key={i} className="flex items-start">
                  <span className="text-emerald-500 mr-2 font-bold">✓</span>
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
            <button className={`w-full py-3 rounded-lg font-semibold text-sm transition-all duration-200 ${
              plan.popular
                ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/20'
                : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-200'
            }`}>
              {plan.cta}
            </button>
          </div>
        ))}

        {/* MCP Subscription — blue accent */}
        <div className="flex flex-col p-6 rounded-xl border border-blue-500 bg-neutral-800/40 ring-1 ring-blue-500/30 transition-all duration-300 relative">
          <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-blue-500 text-white text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wider">
            Claude Integration
          </span>
          <div className="mb-6">
            <h3 className="text-xl font-bold text-neutral-100">{mcpPlan.name}</h3>
            <p className="text-xs text-neutral-400 mt-1 min-h-[40px]">{mcpPlan.description}</p>
          </div>
          <div className="flex items-baseline mb-6">
            <span className="text-4xl font-black text-blue-400">{mcpPlan.price}</span>
            <span className="text-neutral-500 text-xs ml-2">/ {mcpPlan.frequency}</span>
          </div>
          <ul className="space-y-3 text-sm text-neutral-300 mb-8 flex-grow">
            {mcpPlan.features.map((feature, i) => (
              <li key={i} className="flex items-start">
                <span className="text-blue-400 mr-2 font-bold">✓</span>
                <span>{feature}</span>
              </li>
            ))}
          </ul>
          <a
            href="/mcp"
            className="w-full py-3 rounded-lg font-semibold text-sm bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/20 transition-all duration-200 text-center block"
          >
            {mcpPlan.cta}
          </a>
          <p className="text-xs text-neutral-500 text-center mt-2">Cancel anytime</p>
        </div>

        {/* Continuous Subscription */}
        <div className="flex flex-col p-6 rounded-xl border border-neutral-800 bg-neutral-950/40 hover:border-neutral-700 transition-all duration-300">
          <div className="mb-6">
            <h3 className="text-xl font-bold text-neutral-100">{continuousPlan.name}</h3>
            <p className="text-xs text-neutral-400 mt-1 min-h-[40px]">{continuousPlan.description}</p>
          </div>
          <div className="flex items-baseline mb-6">
            <span className="text-4xl font-black text-emerald-400">{continuousPlan.price}</span>
            <span className="text-neutral-500 text-xs ml-2">/ {continuousPlan.frequency}</span>
          </div>
          <ul className="space-y-3 text-sm text-neutral-300 mb-8 flex-grow">
            {continuousPlan.features.map((feature, i) => (
              <li key={i} className="flex items-start">
                <span className="text-emerald-500 mr-2 font-bold">✓</span>
                <span>{feature}</span>
              </li>
            ))}
          </ul>
          <button className="w-full py-3 rounded-lg font-semibold text-sm bg-neutral-800 hover:bg-neutral-700 text-neutral-200 transition-all duration-200">
            {continuousPlan.cta}
          </button>
        </div>
      </div>
    </div>
  );
}
