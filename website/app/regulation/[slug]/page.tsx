import Link from "next/link";
import { notFound } from "next/navigation";
import {
  REGULATIONS,
  getAllRegulationSlugs,
  getRegulationBySlug,
  moduleNameToSlug,
} from "../catalog";

interface PageParams {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams(): Promise<{ slug: string }[]> {
  return getAllRegulationSlugs().map((slug) => ({ slug }));
}

const SHOW_HN_BADGE = process.env.NEXT_PUBLIC_LAUNCH_HN === "1";

export default async function RegulationPage({ params }: PageParams) {
  const { slug } = await params;
  const reg = getRegulationBySlug(slug);
  if (!reg) notFound();

  const canonical = `https://gatetest.ai/regulation/${reg.slug}`;

  // SoftwareApplication structured data
  const softwareJsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: `GateTest — ${reg.name} compliance scanner`,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Cross-platform (Node.js 20+)",
    url: canonical,
    description: `GateTest catches the technical findings auditors look for under ${reg.name} (${reg.longName}). One scan, modules including ${reg.topThreeModules.join(", ")}.`,
    offers: {
      "@type": "Offer",
      price: "99",
      priceCurrency: "USD",
      description: `Full Scan — all GateTest modules including ${reg.topThreeModules.join(", ")}`,
    },
  };

  // BreadcrumbList structured data
  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "GateTest", item: "https://gatetest.ai" },
      { "@type": "ListItem", position: 2, name: "Regulations", item: "https://gatetest.ai/regulation" },
      { "@type": "ListItem", position: 3, name: reg.name, item: canonical },
    ],
  };

  return (
    <main className="min-h-screen bg-black text-white">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareJsonLd) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }} />

      {/* Top nav */}
      <nav className="border-b border-white/[0.06] px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-teal-600 flex items-center justify-center">
              <span className="text-white font-bold text-sm font-mono">G</span>
            </div>
            <span className="text-xl font-bold tracking-tight text-white">
              Gate<span className="text-teal-400">Test</span>
            </span>
          </Link>
          <Link href="/regulation" className="text-sm text-white/50 hover:text-white transition-colors">
            All regulations &rarr;
          </Link>
        </div>
      </nav>

      <main className="px-6 py-16 max-w-4xl mx-auto">
        {/* Breadcrumb */}
        <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm text-white/40 mb-10">
          <Link href="/" className="hover:text-white/70 transition-colors">GateTest</Link>
          <span>/</span>
          <Link href="/regulation" className="hover:text-white/70 transition-colors">Regulations</Link>
          <span>/</span>
          <span className="text-white/60">{reg.name}</span>
        </nav>

        {/* Hero */}
        <div className="mb-12">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-teal-500/10 border border-teal-500/20 text-xs text-teal-300 font-medium mb-6">
            Compliance regime · {reg.jurisdiction.split("—")[0].trim()}
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold text-white leading-tight mb-4">
            <span className="gradient-text">{reg.name}</span> compliance — what GateTest actually catches
          </h1>
          <p className="text-base text-white/55 mb-6">{reg.longName}</p>
          <p className="text-lg text-white/75 leading-relaxed mb-8">{reg.whyDevsCareThisYear}</p>

          <div className="flex flex-col sm:flex-row gap-3">
            <Link
              href="/scan"
              className="inline-flex items-center justify-center px-6 py-3 rounded-xl font-semibold text-sm"
              style={{ background: "#2dd4bf", color: "#0a0a12" }}
            >
              Run a scan &rarr;
            </Link>
            <Link
              href="/modules"
              className="inline-flex items-center justify-center px-6 py-3 rounded-xl font-semibold text-sm border border-white/15 text-white/70 hover:border-white/30 hover:text-white transition-colors"
            >
              See the modules
            </Link>
          </div>
        </div>

        {/* The regime in one paragraph */}
        <section className="mb-12 rounded-xl border border-white/[0.08] p-6" style={{ background: "rgba(255,255,255,0.02)" }}>
          <h2 className="text-sm uppercase tracking-wider text-white/40 font-semibold mb-3">The regime</h2>
          <p className="text-white/75 leading-relaxed mb-3">
            <strong className="text-white">{reg.longName}</strong> — {reg.jurisdiction}. Effective since {reg.effectiveSince}.
          </p>
          <p className="text-white/70 leading-relaxed mb-3">
            <strong className="text-amber-200/90">Maximum penalty:</strong> {reg.fineRange}
          </p>
          <p className="text-sm text-white/50">
            Authoritative source:{" "}
            <a
              href={reg.authoritativeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-teal-300 hover:text-teal-200 underline underline-offset-2"
            >
              {reg.authoritativeUrl}
            </a>
          </p>
        </section>

        {/* Top 3 modules */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold text-white mb-2">The 3 modules that do the heaviest lifting for {reg.name}</h2>
          <p className="text-white/55 mb-6">Linked to each module&apos;s page for the full finding list.</p>
          <div className="grid sm:grid-cols-3 gap-3">
            {reg.topThreeModules.map((mod) => (
              <Link
                key={mod}
                href={`/modules/${moduleNameToSlug(mod)}`}
                className="block rounded-xl border border-white/[0.08] p-5 hover:border-teal-500/30 transition-colors"
                style={{ background: "rgba(255,255,255,0.02)" }}
              >
                <div className="text-xs uppercase tracking-wider text-teal-300/70 mb-2">GateTest module</div>
                <div className="text-white font-mono font-semibold mb-1">{mod}</div>
                <div className="text-white/55 text-sm">View full coverage &rarr;</div>
              </Link>
            ))}
          </div>
        </section>

        {/* Catchable technical findings */}
        <section className="mb-12 rounded-xl border border-teal-500/20 p-6" style={{ background: "rgba(20,184,166,0.05)" }}>
          <h2 className="text-2xl font-bold text-white mb-2">Technical findings GateTest catches for {reg.name}</h2>
          <p className="text-white/60 mb-6 text-sm">
            Each item ties a specific code-level pattern to a clause or principle of {reg.name}. These are the findings auditors sample.
          </p>
          <ul className="space-y-3">
            {reg.catchableTechnicalFindings.map((finding) => (
              <li key={finding} className="flex gap-3 text-white/80 leading-relaxed">
                <span className="text-teal-400 mt-1 select-none" aria-hidden="true">&#10003;</span>
                <span>{finding}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* Out of scope */}
        <section className="mb-12 rounded-xl border border-amber-500/20 p-6" style={{ background: "rgba(245,158,11,0.05)" }}>
          <h2 className="text-2xl font-bold text-white mb-2">Out of scope — what you still need humans for</h2>
          <p className="text-white/60 mb-6 text-sm">
            GateTest is a code scanner. {reg.name} compliance is a programme, not a tool. These items will never be answerable from source code alone.
          </p>
          <ul className="space-y-2">
            {reg.outOfScopeForGateTest.map((item) => (
              <li key={item} className="flex gap-3 text-white/75 leading-relaxed">
                <span className="text-amber-300/70 mt-1 select-none" aria-hidden="true">&minus;</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* Countries chips */}
        {reg.countriesAffected.length > 0 && (
          <section className="mb-12">
            <h2 className="text-2xl font-bold text-white mb-2">Where this regime applies</h2>
            <p className="text-white/55 mb-6 text-sm">Country-specific guides:</p>
            <div className="flex flex-wrap gap-2">
              {reg.countriesAffected.map((country) => (
                <Link
                  key={country}
                  href={`/for/${country}`}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-white/15 text-sm text-white/80 hover:border-teal-500/40 hover:text-white transition-colors"
                  style={{ background: "rgba(255,255,255,0.02)" }}
                >
                  <span className="text-teal-300/70" aria-hidden="true">&rarr;</span>
                  <span className="capitalize">{country.replace(/-/g, " ")}</span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* How GateTest fits */}
        <section className="mb-12 rounded-xl border border-white/[0.08] p-6" style={{ background: "rgba(255,255,255,0.02)" }}>
          <h2 className="text-2xl font-bold text-white mb-4">How GateTest fits a compliance programme</h2>
          <p className="text-white/75 leading-relaxed">
            GateTest is a code-quality and security scanner. It belongs in your CI pipeline, not in your auditor&apos;s office. We catch the technical findings auditors look for &mdash; secrets, missing rotation, weak TLS, PII in logs, dangerous dependencies &mdash; so the audit becomes a paperwork exercise instead of an emergency.
          </p>
        </section>

        {/* Pricing strip */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold text-white mb-6">Pricing</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { name: "Quick", price: "$29", blurb: "4 essential modules" },
              { name: "Full", price: "$99", blurb: "All modules — scan only" },
              { name: "Scan + Fix", price: "$199", blurb: "Full scan + AI auto-fix PR" },
              { name: "Forensic", price: "$399", blurb: "Everything + correlation + report" },
            ].map((tier) => (
              <div
                key={tier.name}
                className="rounded-xl border border-white/[0.08] p-5"
                style={{ background: "rgba(255,255,255,0.02)" }}
              >
                <div className="text-xs uppercase tracking-wider text-white/40 mb-2">{tier.name}</div>
                <div className="text-2xl font-bold text-white mb-1">{tier.price}</div>
                <div className="text-white/55 text-sm">{tier.blurb}</div>
              </div>
            ))}
          </div>
        </section>

        {/* Trust strip */}
        <section className="mb-12">
          <h2 className="text-sm uppercase tracking-wider text-white/40 font-semibold mb-4">Trust</h2>
          <div className="flex flex-wrap gap-3">
            <span
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-white/[0.08] text-sm text-white/70"
              style={{ background: "rgba(255,255,255,0.02)" }}
            >
              <span className="text-teal-300/80" aria-hidden="true">&#9679;</span>
              CLI is MIT-licensed
            </span>
            <span
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-white/[0.08] text-sm text-white/70"
              style={{ background: "rgba(255,255,255,0.02)" }}
            >
              <span className="text-teal-300/80" aria-hidden="true">&#9679;</span>
              Available on GitHub Marketplace soon
            </span>
            {SHOW_HN_BADGE && (
              <span
                className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-orange-500/30 text-sm text-orange-200"
                style={{ background: "rgba(245,158,11,0.06)" }}
              >
                <span aria-hidden="true">&#9679;</span>
                As featured on Hacker News &amp; Product Hunt
              </span>
            )}
          </div>
        </section>

        {/* CTA footer */}
        <section className="mb-12 rounded-2xl border border-teal-500/20 p-10 text-center" style={{ background: "rgba(20,184,166,0.05)" }}>
          <h2 className="text-3xl font-bold text-white mb-3">Try a $29 Quick scan on your repo</h2>
          <p className="text-white/60 mb-6 max-w-xl mx-auto">
            See the {reg.name}-relevant findings on your own code in under 15 seconds. Free preview. Pay only if you ship the report.
          </p>
          <Link
            href="/scan"
            className="inline-flex items-center justify-center px-6 py-3 rounded-xl font-semibold text-sm"
            style={{ background: "#2dd4bf", color: "#0a0a12" }}
          >
            Start a scan &rarr;
          </Link>
        </section>

        {/* Related regulations */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold text-white mb-6">Other regulations</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {REGULATIONS.filter((r) => r.slug !== reg.slug)
              .slice(0, 5)
              .map((r) => (
                <Link
                  key={r.slug}
                  href={`/regulation/${r.slug}`}
                  className="block rounded-xl border border-white/[0.08] p-4 hover:border-teal-500/30 transition-colors"
                  style={{ background: "rgba(255,255,255,0.02)" }}
                >
                  <div className="text-white font-semibold mb-1">{r.name}</div>
                  <div className="text-white/55 text-sm">{r.longName.slice(0, 80)}{r.longName.length > 80 ? "…" : ""}</div>
                </Link>
              ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-white/[0.06] px-6 py-8">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-white/30">
          <span>GateTest &copy; 2026</span>
          <div className="flex gap-6">
            <Link href="/regulation" className="hover:text-white/60 transition-colors">Regulations</Link>
            <Link href="/modules" className="hover:text-white/60 transition-colors">Modules</Link>
            <Link href="/#pricing" className="hover:text-white/60 transition-colors">Pricing</Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
