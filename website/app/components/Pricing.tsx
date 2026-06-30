// Pricing tiers mirror the checkout backend exactly — website/app/api/checkout/route.ts TIERS.
// Source of truth for prices: that TIERS map. Keep these in sync (Bible Forbidden #17).
//   quick $29 · full $99 · scan_fix $199 · nuclear/Forensic $399 (one-time) · continuous $49/mo
export const pricingScans = [
  {
    name: "Quick Scan",
    price: "$29",
    period: "per run",
    description: "Fast security and error checking for rapid development iterations.",
    features: [
      "4 core modules — syntax, lint, secrets, code quality",
      "Scan-only (no auto-fix)",
      "CLI & Cloud Session Sync"
    ],
    cta: "Run Quick Scan",
    popular: false
  },
  {
    name: "Full Scan",
    price: "$99",
    period: "per run",
    description: "Deep repository analysis across the entire engine.",
    features: [
      "All 111 specialized engineering modules",
      "Full dependency & CVE scanning",
      "Cross-repo prior-art lookup",
      "Scan-only (auto-fix ships at Scan + Fix)"
    ],
    cta: "Deploy Full Sweep",
    popular: false
  },
  {
    name: "Scan + Fix",
    price: "$199",
    period: "per run",
    description: "Full scan plus an automated, reviewed repair pass.",
    features: [
      "Everything in Full Scan",
      "Automated Claude 4.6 auto-fix PR",
      "Second-Claude pair-review on every fix",
      "Architecture-annotator design report"
    ],
    cta: "Scan + Auto-Fix",
    popular: true
  },
  {
    name: "Forensic Scan",
    price: "$399",
    period: "per run",
    description: "Audit-grade depth — diagnosis, correlation, and board-ready reporting.",
    features: [
      "Everything in Scan + Fix",
      "Real Claude diagnosis on every finding",
      "Cross-finding attack-chain correlation",
      "Board-ready CISO + executive summary report"
    ],
    cta: "Run Forensic Scan",
    popular: false
  }
];

export const continuousPlan = {
  name: "Continuous",
  price: "$49",
  frequency: "per month",
  description: "Always-on agentic monitoring — scan every push automatically.",
  features: [
    "Unlimited deterministic scans across all 111 modules",
    "Monthly Claude AI-review allowance",
    "Continuous AI ledger spending protections",
    "Cancel anytime"
  ],
  cta: "Activate Continuous Shield"
};

export default function Pricing() {
  return (
    <div className="p-8 bg-neutral-900 text-white rounded-xl border border-neutral-800 shadow-2xl max-w-7xl mx-auto my-12">
      <h2 className="text-3xl font-extrabold mb-2 text-center text-emerald-400 tracking-tight">
        Predictable, Automation-First Pricing
      </h2>
      <p className="text-neutral-400 text-center mb-10 max-w-xl mx-auto text-sm">
        Pay per scan — no subscription required. If an issue matches a known structural
        vector, your patch deploys instantly at near-zero marginal cost.
      </p>

      {/* Free CLI callout */}
      <div className="mb-10 flex flex-col items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-6 py-5 text-center">
        <span className="text-xs font-bold uppercase tracking-wider text-emerald-400">
          Free, local, no account
        </span>
        <code className="rounded-md bg-neutral-950/80 px-4 py-2 text-sm text-emerald-300 border border-neutral-800">
          npx @gatetest/cli --suite full
        </code>
        <p className="text-xs text-neutral-400 max-w-md">
          Run all 111 modules on your own machine for free. The paid cloud tiers below add
          hosted scans, auto-fix PRs, pair-review, and forensic reporting.
        </p>
      </div>

      {/* On-Demand Scan Tiers */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6 items-stretch">
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
                Recommended
              </span>
            )}
            <div className="mb-6">
              <h3 className="text-xl font-bold text-neutral-100">{plan.name}</h3>
              <p className="text-xs text-neutral-400 mt-1 min-h-[48px]">{plan.description}</p>
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
      </div>

      {/* Continuous Subscription Plan */}
      <div className="mt-6 flex flex-col md:flex-row md:items-center md:justify-between p-6 rounded-xl border border-neutral-800 bg-neutral-950/40 hover:border-neutral-700 transition-all duration-300 gap-6">
        <div className="md:max-w-md">
          <h3 className="text-xl font-bold text-neutral-100">{continuousPlan.name}</h3>
          <p className="text-xs text-neutral-400 mt-1">{continuousPlan.description}</p>
          <ul className="space-y-2 text-sm text-neutral-300 mt-4">
            {continuousPlan.features.map((feature, i) => (
              <li key={i} className="flex items-start">
                <span className="text-emerald-500 mr-2 font-bold">✓</span>
                <span>{feature}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col items-start md:items-end gap-3">
          <div className="flex items-baseline">
            <span className="text-4xl font-black text-emerald-400">{continuousPlan.price}</span>
            <span className="text-neutral-500 text-xs ml-2">/ {continuousPlan.frequency}</span>
          </div>
          <button className="py-3 px-6 rounded-lg font-semibold text-sm bg-neutral-800 hover:bg-neutral-700 text-neutral-200 transition-all duration-200">
            {continuousPlan.cta}
          </button>
        </div>
      </div>
    </div>
  );
}
