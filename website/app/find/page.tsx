import type { Metadata } from "next";
import Link from "next/link";
import { CWE_TOP_25 } from "./cwe-catalog";

export const metadata: Metadata = {
  title: "CWE Top 25 — what GateTest catches and how to fix it",
  description: "Browse the 2023 MITRE CWE Top 25 most dangerous software weaknesses. See which GateTest modules catch each class, with examples and fix recommendations.",
  alternates: { canonical: "https://gatetest.ai/find" },
  openGraph: {
    title: "CWE Top 25 — what GateTest catches and how to fix it",
    description: "Browse all 25 most dangerous software weaknesses. See which GateTest modules catch each class.",
    url: "https://gatetest.ai/find",
    siteName: "GateTest",
    type: "website",
  },
};

export default function CweIndexPage() {
  const collectionJsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "CWE Top 25 — GateTest coverage",
    url: "https://gatetest.ai/find",
    hasPart: CWE_TOP_25.map((cwe) => ({
      "@type": "WebPage",
      url: `https://gatetest.ai/find/${cwe.slug}`,
      name: `CWE-${cwe.id} ${cwe.name}`,
      description: cwe.shortDesc,
    })),
  };

  const coveredCount = CWE_TOP_25.filter((c) => c.modules.length > 0).length;

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
        <nav className="flex items-center gap-2 text-sm text-white/40 mb-10">
          <Link href="/" className="hover:text-white/70 transition-colors">GateTest</Link>
          <span>/</span>
          <span className="text-white/60">Find (CWE)</span>
        </nav>

        <div className="mb-16 max-w-3xl">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300 font-medium mb-6">
            MITRE 2023 CWE Top 25
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold text-white leading-tight mb-6">
            The 25 most dangerous bug classes. {coveredCount} of them caught by GateTest.
          </h1>
          <p className="text-lg text-white/65 leading-relaxed">
            MITRE&apos;s annual CWE Top 25 ranks the most dangerous software weaknesses by prevalence and severity. We show which classes GateTest catches today, which we don&apos;t, and the fix shape for each.
          </p>
          <p className="text-sm text-white/45 leading-relaxed mt-4">
            Honest scoring — we cover the web-stack and infrastructure-as-code classes. The C/C++ memory-safety classes (out-of-bounds writes, use-after-free, NULL deref) we don&apos;t scan today. Each page says so.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {CWE_TOP_25.map((cwe) => {
            const covered = cwe.modules.length > 0;
            return (
              <Link
                key={cwe.slug}
                href={`/find/${cwe.slug}`}
                className="block rounded-xl border border-white/[0.08] p-5 hover:border-teal-500/30 transition-colors"
                style={{ background: "rgba(255,255,255,0.02)" }}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="text-xs font-mono text-teal-300/70">CWE-{cwe.id}</div>
                  <div className={`text-xs font-semibold px-2 py-0.5 rounded-full ${covered ? "bg-teal-500/10 text-teal-300" : "bg-amber-500/10 text-amber-300"}`}>
                    {covered ? "Caught" : "Not covered"}
                  </div>
                </div>
                <div className="text-white font-semibold mb-1">{cwe.name}</div>
                <div className="text-white/55 text-sm leading-snug">{cwe.shortDesc.slice(0, 120)}{cwe.shortDesc.length > 120 ? "…" : ""}</div>
                <div className="text-[10px] text-white/30 mt-2 uppercase tracking-wider">#{cwe.rank} in Top 25</div>
              </Link>
            );
          })}
        </div>

        <section className="mt-20 rounded-2xl border border-teal-500/20 p-10 text-center" style={{ background: "rgba(20,184,166,0.05)" }}>
          <h2 className="text-3xl font-bold text-white mb-4">
            Scan for {coveredCount} CWE classes in one run.
          </h2>
          <p className="text-white/60 mb-8 max-w-xl mx-auto">
            120 modules. Per-scan pricing. AI auto-fix PR on Scan + Fix and Forensic Scan tiers.
          </p>
          <Link
            href="/#pricing"
            className="inline-flex items-center justify-center px-6 py-3 rounded-xl font-semibold text-sm"
            style={{ background: "#2dd4bf", color: "#0a0a12" }}
          >
            See pricing &rarr;
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
