import type { Metadata } from "next";
import Link from "next/link";
import { REGULATIONS } from "./catalog";

export const metadata: Metadata = {
  title: "Compliance regulations — what GateTest catches for GDPR, HIPAA, SOC 2, CCPA, PCI DSS, ISO 27001",
  description:
    "Browse the technical findings GateTest catches under the world's major compliance regimes. One scan covers code-level evidence auditors sample.",
  alternates: { canonical: "https://gatetest.ai/regulation" },
  openGraph: {
    title: "Compliance regulations — what GateTest catches",
    description:
      "Technical findings GateTest catches under GDPR, HIPAA, SOC 2, CCPA, PCI DSS, and ISO 27001.",
    url: "https://gatetest.ai/regulation",
    siteName: "GateTest",
    type: "website",
  },
};

export default function RegulationIndexPage() {
  const collectionJsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Compliance regulations — GateTest coverage",
    url: "https://gatetest.ai/regulation",
    hasPart: REGULATIONS.map((r) => ({
      "@type": "WebPage",
      url: `https://gatetest.ai/regulation/${r.slug}`,
      name: `${r.name} — ${r.longName}`,
      description: r.whyDevsCareThisYear,
    })),
  };

  return (
    <main className="min-h-screen bg-black text-white">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(collectionJsonLd) }} />

      <nav className="border-b border-white/[0.06] px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-teal-600 flex items-center justify-center">
              <span className="text-white font-bold text-sm font-mono">G</span>
            </div>
            <span className="text-xl font-bold tracking-tight text-white">
              Gate<span className="text-teal-400">Test</span>
            </span>
          </Link>
          <Link href="/modules" className="text-sm text-white/70 hover:text-white transition-colors">
            All modules &rarr;
          </Link>
        </div>
      </nav>

      <main className="px-6 py-16 max-w-6xl mx-auto">
        <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm text-white/40 mb-10">
          <Link href="/" className="hover:text-white/70 transition-colors">GateTest</Link>
          <span>/</span>
          <span className="text-white/60">Regulations</span>
        </nav>

        <div className="mb-16 max-w-3xl">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-teal-500/10 border border-teal-500/20 text-xs text-teal-300 font-medium mb-6">
            {REGULATIONS.length} compliance regimes
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold text-white leading-tight mb-6">
            What GateTest catches, by{" "}
            <span className="gradient-text">regulation</span>.
          </h1>
          <p className="text-lg text-white/65 leading-relaxed">
            Compliance is a programme, not a tool. But every major regime has a list of code-level findings auditors sample &mdash; secrets in source, missing TLS, PII in logs, unrotated credentials, vulnerable dependencies. GateTest catches those before the auditor sees them.
          </p>
          <p className="text-sm text-white/45 leading-relaxed mt-4">
            Every page below ties specific GateTest findings to specific clauses of the regulation. We also publish what GateTest does NOT cover &mdash; physical security, contracts, training &mdash; because compliance honesty matters.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {REGULATIONS.map((reg) => (
            <Link
              key={reg.slug}
              href={`/regulation/${reg.slug}`}
              className="block rounded-xl border border-white/[0.08] p-5 hover:border-teal-500/30 transition-colors"
              style={{ background: "rgba(255,255,255,0.02)" }}
            >
              <div className="flex items-center justify-between mb-3">
                <div className="text-white font-bold text-lg">{reg.name}</div>
                <div className="text-[10px] text-teal-300/70 uppercase tracking-wider">{reg.effectiveSince}</div>
              </div>
              <div className="text-white/70 text-sm font-medium mb-2">{reg.longName}</div>
              <div className="text-white/50 text-xs mb-3">{reg.jurisdiction.split("—")[0].trim()}</div>
              <div className="text-white/60 text-sm leading-snug">
                {reg.whyDevsCareThisYear.slice(0, 140)}{reg.whyDevsCareThisYear.length > 140 ? "…" : ""}
              </div>
            </Link>
          ))}
        </div>

        <section className="mt-20 rounded-2xl border border-teal-500/20 p-10 text-center" style={{ background: "rgba(20,184,166,0.05)" }}>
          <h2 className="text-3xl font-bold text-white mb-4">
            One scan, every regime&apos;s technical findings.
          </h2>
          <p className="text-white/60 mb-8 max-w-xl mx-auto">
            Per-scan pricing. AI auto-fix PR on Scan + Fix and Forensic tiers.
          </p>
          <Link
            href="/scan"
            className="inline-flex items-center justify-center px-6 py-3 rounded-xl font-semibold text-sm"
            style={{ background: "#2dd4bf", color: "#0a0a12" }}
          >
            Run a scan &rarr;
          </Link>
        </section>
      </main>

      <footer className="border-t border-white/[0.06] px-6 py-8">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-white/30">
          <span>GateTest &copy; 2026</span>
          <div className="flex gap-6">
            <Link href="/" className="hover:text-white/60 transition-colors">Home</Link>
            <Link href="/modules" className="hover:text-white/60 transition-colors">Modules</Link>
            <Link href="/#pricing" className="hover:text-white/60 transition-colors">Pricing</Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
