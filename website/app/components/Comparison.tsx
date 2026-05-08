const rows: { label: string; gatetest: string; sonar: boolean; snyk: boolean; copilot: boolean; semgrep: boolean }[] = [
  { label: "SSRF / URL injection", gatetest: "error", sonar: false, snyk: false, copilot: false, semgrep: false },
  { label: "Cross-finding attack chains", gatetest: "error", sonar: false, snyk: false, copilot: false, semgrep: false },
  { label: "Money float precision (parseFloat)", gatetest: "error", sonar: false, snyk: false, copilot: false, semgrep: false },
  { label: "PII flow to logs (GDPR)", gatetest: "error", sonar: false, snyk: false, copilot: false, semgrep: false },
  { label: "Circular imports (TDZ)", gatetest: "error", sonar: false, snyk: false, copilot: false, semgrep: false },
  { label: "N+1 query in ORM loops", gatetest: "error", sonar: false, snyk: false, copilot: false, semgrep: false },
  { label: "Async-iteration footguns", gatetest: "error", sonar: false, snyk: false, copilot: false, semgrep: false },
  { label: "Race conditions (TOCTOU)", gatetest: "error", sonar: false, snyk: false, copilot: false, semgrep: false },
  { label: "ReDoS catastrophic backtracking", gatetest: "error", sonar: true, snyk: false, copilot: false, semgrep: false },
  { label: "Supply chain / CVEs", gatetest: "error", sonar: false, snyk: true, copilot: false, semgrep: false },
  { label: "Secret rotation (90d age)", gatetest: "error", sonar: false, snyk: false, copilot: false, semgrep: false },
  { label: "TLS cert bypass", gatetest: "error", sonar: true, snyk: false, copilot: false, semgrep: true },
  { label: "Stale feature flags", gatetest: "warning", sonar: false, snyk: false, copilot: false, semgrep: false },
  { label: "Mutation testing (tests test tests)", gatetest: "unique", sonar: false, snyk: false, copilot: false, semgrep: false },
  { label: "Auto-fix PR with Claude", gatetest: "unique", sonar: false, snyk: false, copilot: true, semgrep: false },
  { label: "Iterative fix loop (retry on fail)", gatetest: "unique", sonar: false, snyk: false, copilot: false, semgrep: false },
  { label: "Fake-fix detector", gatetest: "unique", sonar: false, snyk: false, copilot: false, semgrep: false },
  { label: "Pay only when PR delivered", gatetest: "unique", sonar: false, snyk: false, copilot: false, semgrep: false },
];

const Icon = ({ yes }: { yes: boolean }) =>
  yes ? (
    <span className="text-emerald-600 text-sm font-bold">&#10003;</span>
  ) : (
    <span className="text-gray-300 text-xs">&mdash;</span>
  );

const severityBadge = (s: string) => {
  if (s === "error") return <span className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-600 border border-red-200 font-mono">error</span>;
  if (s === "warning") return <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-600 border border-amber-200 font-mono">warning</span>;
  return <span className="text-xs px-2 py-0.5 rounded bg-violet-100 text-violet-600 border border-violet-200 font-mono">only us</span>;
};

export default function Comparison() {
  return (
    <section id="comparison" className="py-24 px-6 border-t border-border/30 bg-gray-50">
      <div className="mx-auto max-w-6xl">
        <div className="text-center mb-14">
          <span className="inline-block px-3 py-1 rounded-full bg-gray-100 border border-gray-200 text-gray-500 text-xs font-semibold uppercase tracking-widest mb-4">
            Competitive Reality
          </span>
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-gray-900 mb-4">
            They flag the easy stuff.
            <br />
            <span className="hero-accent-text">We find the bugs that actually hurt.</span>
          </h2>
          <p className="text-gray-500 text-lg max-w-2xl mx-auto">
            GateTest finds entire categories of bugs no competitor on the market today detects.
            Not incremental improvement &mdash; a different product category.
          </p>
        </div>

        {/* Table */}
        <div className="rounded-xl border border-gray-200 overflow-hidden bg-white">
          {/* Header */}
          <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr] bg-gray-50 border-b border-gray-200">
            <div className="px-4 py-3 text-xs text-gray-400 font-semibold uppercase tracking-wider">Check</div>
            <div className="px-3 py-3 text-xs text-emerald-600 font-bold text-center">GateTest</div>
            <div className="px-3 py-3 text-xs text-gray-400 font-semibold text-center">SonarQube</div>
            <div className="px-3 py-3 text-xs text-gray-400 font-semibold text-center">Snyk</div>
            <div className="px-3 py-3 text-xs text-gray-400 font-semibold text-center">Copilot</div>
            <div className="px-3 py-3 text-xs text-gray-400 font-semibold text-center">Semgrep</div>
          </div>

          {/* Rows */}
          {rows.map((row, i) => (
            <div
              key={row.label}
              className={`grid grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr] border-b border-gray-100 hover:bg-gray-50 transition-colors ${
                i % 2 === 0 ? "bg-white" : "bg-gray-50/50"
              }`}
            >
              <div className="px-4 py-3 text-sm text-gray-700 flex items-center gap-2">
                {row.label}
                {row.gatetest === "unique" && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-100 text-violet-600 border border-violet-200">only us</span>
                )}
              </div>
              <div className="px-3 py-3 flex items-center justify-center">{severityBadge(row.gatetest)}</div>
              <div className="px-3 py-3 flex items-center justify-center"><Icon yes={row.sonar} /></div>
              <div className="px-3 py-3 flex items-center justify-center"><Icon yes={row.snyk} /></div>
              <div className="px-3 py-3 flex items-center justify-center"><Icon yes={row.copilot} /></div>
              <div className="px-3 py-3 flex items-center justify-center"><Icon yes={row.semgrep} /></div>
            </div>
          ))}
        </div>

        <p className="text-center text-gray-400 text-xs mt-4">
          Based on published documentation. Last verified May 2026. GateTest covers 90 modules total &mdash; this table shows 18.
        </p>

        {/* Bottom stats */}
        <div className="grid grid-cols-3 gap-4 mt-10">
          {[
            { value: "12", label: "Bug categories only GateTest finds", sub: "No competitor has equivalents" },
            { value: "90", label: "Scan modules", sub: "SonarQube: ~10. Snyk: ~4. Copilot: ~3." },
            { value: "$0", label: "Dollars if we fail", sub: "Every competitor charges whether bugs are found or not" },
          ].map((s) => (
            <div key={s.label} className="text-center p-6 rounded-xl bg-white border border-gray-200">
              <div className="text-4xl font-bold text-gray-900 mb-1">{s.value}</div>
              <div className="text-sm text-gray-600 font-medium">{s.label}</div>
              <div className="text-xs text-gray-400 mt-1">{s.sub}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
