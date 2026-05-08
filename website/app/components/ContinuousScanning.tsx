const pushEvents = [
  {
    time: "2 sec ago",
    repo: "acme/payments-api",
    branch: "main",
    modules: 90,
    findings: 3,
    status: "BLOCKED",
    statusColor: "text-red-400",
    detail: "moneyFloat + ssrf chain — CRITICAL",
  },
  {
    time: "14 min ago",
    repo: "acme/frontend",
    branch: "feat/checkout",
    modules: 90,
    findings: 0,
    status: "PASSED",
    statusColor: "text-emerald-400",
    detail: "All 90 modules clean",
  },
  {
    time: "1 hr ago",
    repo: "acme/admin",
    branch: "main",
    modules: 90,
    findings: 7,
    status: "BLOCKED",
    statusColor: "text-amber-400",
    detail: "piiFlow + tlsSecurity + importCycle",
  },
  {
    time: "3 hr ago",
    repo: "acme/payments-api",
    branch: "fix/auth",
    modules: 90,
    findings: 0,
    status: "PASSED",
    statusColor: "text-emerald-400",
    detail: "All 90 modules clean",
  },
];

const tiers = [
  {
    name: "Quick Continuous",
    price: "$49",
    scans: "Quick Scan (4 modules)",
    detail: "Security + secrets + deps + syntax on every push",
  },
  {
    name: "Full Continuous",
    price: "$149",
    scans: "Full Scan (90 modules)",
    detail: "Complete 90-module audit on every push",
    highlight: true,
  },
  {
    name: "Nuclear Continuous",
    price: "$299",
    scans: "Nuclear Scan (90 + mutation + chaos)",
    detail: "Full suite + mutation testing + Claude attack-chain analysis",
  },
];

export default function ContinuousScanning() {
  return (
    <section className="py-24 px-6 border-t border-border/30 bg-white relative overflow-hidden">
      <div className="absolute top-0 right-0 w-[400px] h-[400px] bg-gradient-to-l from-teal-500/4 to-transparent rounded-full blur-[100px] pointer-events-none" />

      <div className="relative z-10 mx-auto max-w-6xl">
        <div className="grid lg:grid-cols-2 gap-16 items-center">
          {/* Left: live feed */}
          <div>
            <span className="inline-block px-3 py-1 rounded-full bg-gray-100 border border-gray-200 text-gray-500 text-xs font-semibold uppercase tracking-widest mb-4">
              Scan on every push
            </span>
            <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4">
              GateTest runs the moment
              <br />
              <span className="hero-accent-text">code touches your repo.</span>
            </h2>
            <p className="text-gray-500 text-lg leading-relaxed mb-8">
              Subscribe and every push triggers a full 90-module scan. Bad code never reaches
              main. Your posture improves with every deploy. The brain gets smarter over time.
            </p>

            {/* Live feed — intentionally dark terminal style */}
            <div className="rounded-xl border border-gray-700 overflow-hidden bg-gray-900">
              <div className="px-4 py-3 flex items-center gap-2 border-b border-gray-700">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
                </span>
                <span className="text-xs text-white/40 font-mono">Live scan feed</span>
              </div>
              <div className="divide-y divide-gray-700/60">
                {pushEvents.map((evt, i) => (
                  <div key={i} className="px-4 py-3 flex items-center gap-3">
                    <div className="shrink-0 text-right">
                      <div className="text-xs text-white/25 font-mono">{evt.time}</div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-white/70 font-mono truncate">{evt.repo}</span>
                        <span className="text-xs text-white/30 font-mono">/{evt.branch}</span>
                      </div>
                      <div className="text-xs text-white/30 mt-0.5">{evt.detail}</div>
                    </div>
                    <div className={`text-xs font-bold font-mono shrink-0 ${evt.statusColor}`}>
                      {evt.status}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right: pricing */}
          <div>
            <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
              Continuous plans &mdash; month-to-month
            </h3>
            <div className="space-y-3">
              {tiers.map((tier) => (
                <div
                  key={tier.name}
                  className={`relative rounded-xl border p-5 transition-colors ${
                    tier.highlight
                      ? "border-teal-500/40 bg-teal-50"
                      : "border-gray-200 bg-white hover:border-gray-300"
                  }`}
                >
                  {tier.highlight && (
                    <div className="absolute top-3 right-3 px-2 py-0.5 rounded text-[10px] font-semibold bg-teal-100 text-teal-700 border border-teal-200">
                      Most popular
                    </div>
                  )}
                  <div className="flex items-start gap-4">
                    <div>
                      <span className="text-2xl font-bold text-gray-900">{tier.price}</span>
                      <span className="text-gray-400 text-sm">/mo</span>
                    </div>
                    <div className="flex-1">
                      <div className="text-sm font-semibold text-gray-900">{tier.name}</div>
                      <div className="text-xs text-gray-400 mt-0.5">{tier.scans}</div>
                      <div className="text-xs text-gray-400 mt-1">{tier.detail}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <a
              href="#pricing"
              className="block mt-5 text-center px-6 py-3 rounded-xl border border-gray-200 text-gray-600 text-sm font-semibold hover:text-gray-900 hover:border-gray-400 transition-colors"
            >
              View all pricing &rarr;
            </a>

            <p className="text-gray-400 text-xs mt-4 text-center">
              Cancel anytime. No minimum commits. Scans are unlimited within the plan tier.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
