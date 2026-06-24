export const pricingScans = [
  {
    name: "Quick Scan",
    price: "$29",
    period: "per run",
    description: "Fast security and error checking for rapid development iterations.",
    features: [
      "90+ Specialized Engineering Modules",
      "Syntax & Linting Validations",
      "CLI & Cloud Session Sync"
    ],
    cta: "Run Quick Scan",
    popular: false
  },
  {
    name: "Full Deep Scan",
    price: "$99",
    period: "per run",
    description: "Deep repository analysis and complete architectural audit.",
    features: [
      "90+ Specialized Engineering Modules",
      "Full Dependency & CVE Scanning",
      "Cross-Repo Prior Art Lookup",
      "Automated Claude 4.6 Repair Pass"
    ],
    cta: "Deploy Full Sweep",
    popular: true
  }
];

export const continuousPlan = {
  name: "Continuous Guard Shield",
  price: "$299",
  frequency: "per month",
  description: "Always-on agentic monitoring and automated background testing.",
  features: [
    "Unlimited Automated Pre-Commit Sweeps",
    "Continuous AI Ledger Spending Protections",
    "Real-Time Pipeline Trace Feed Integration",
    "Automated Rollbacks if AI Fixes Violate Compilation Barriers"
  ],
  cta: "Activate Continuous Shield"
};

export default function Pricing() {
  return (
    <div className="p-8 bg-neutral-900 text-white rounded-xl border border-neutral-800 shadow-2xl max-w-6xl mx-auto my-12">
      <h2 className="text-3xl font-extrabold mb-2 text-center text-emerald-400 tracking-tight">
        Predictable, Automation-First Pricing
      </h2>
      <p className="text-neutral-400 text-center mb-12 max-w-xl mx-auto text-sm">
        Leverage our global telemetry network. If an issue matches a known structural vector,
        your patch deploys instantly at near-zero marginal cost.
      </p>

      {/* Main Pricing Grid */}
      <div className="grid lg:grid-cols-3 gap-8 items-stretch">

        {/* On-Demand Scans */}
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
              <p className="text-xs text-neutral-400 mt-1 min-h-[32px]">{plan.description}</p>
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

        {/* Continuous Subscription Plan */}
        <div className="flex flex-col p-6 rounded-xl border border-neutral-800 bg-neutral-950/40 hover:border-neutral-700 transition-all duration-300 lg:col-span-1">
          <div className="mb-6">
            <h3 className="text-xl font-bold text-neutral-100">{continuousPlan.name}</h3>
            <p className="text-xs text-neutral-400 mt-1 min-h-[32px]">{continuousPlan.description}</p>
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
