import type { Metadata } from "next";
import Link from "next/link";
import { getModulesByCategory, getTotalModuleCount } from "../components/howitworks/module-slugs";

export const metadata: Metadata = {
  title: `${getTotalModuleCount()} GateTest modules — one config, every QA check in 2026`,
  description: `Browse all ${getTotalModuleCount()} modules in the GateTest scan suite — security, IaC, accessibility, performance, AI-app safety, code quality, and more. One config, AI auto-fix PR included.`,
  alternates: { canonical: "https://gatetest.ai/modules" },
  openGraph: {
    title: `${getTotalModuleCount()} GateTest modules — one config replaces 12 tools`,
    description: `Every QA check GateTest runs. Browse by category — security, IaC, accessibility, performance, code quality, more.`,
    url: "https://gatetest.ai/modules",
    siteName: "GateTest",
    type: "website",
  },
};

function prettify(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

export default function ModulesIndexPage() {
  const categories = getModulesByCategory();
  const total = getTotalModuleCount();

  // CollectionPage structured data — surfaces all module pages to search engines
  const collectionJsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: `GateTest modules — ${total} checks in one config`,
    url: "https://gatetest.ai/modules",
    hasPart: categories.flatMap((cat) =>
      cat.modules.map((mod) => ({
        "@type": "WebPage",
        url: `https://gatetest.ai/modules/${mod.slug}`,
        name: prettify(mod.name),
        description: mod.description,
      }))
    ),
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
          <Link href="/#pricing" className="text-sm text-white/70 hover:text-white transition-colors">
            Pricing &rarr;
          </Link>
        </div>
      </nav>

      <main className="px-6 py-16 max-w-6xl mx-auto">
        <nav className="flex items-center gap-2 text-sm text-white/40 mb-10">
          <Link href="/" className="hover:text-white/70 transition-colors">GateTest</Link>
          <span>/</span>
          <span className="text-white/60">Modules</span>
        </nav>

        <div className="mb-16 max-w-3xl">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-teal-500/10 border border-teal-500/20 text-xs text-teal-400 font-medium mb-6">
            All {total} modules
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold text-white leading-tight mb-6">
            One scan. {total} modules. Every QA check unified.
          </h1>
          <p className="text-lg text-white/65 leading-relaxed">
            GateTest runs {total} distinct checks against your codebase — security, infrastructure, accessibility, performance, code quality, AI-app safety, and more. Each module is the GateTest equivalent of a separate tool: Snyk, SonarQube, Semgrep, ESLint, hadolint, kube-score, axe, Lighthouse, and 20 more. One config, one bill.
          </p>
          <p className="text-sm text-white/45 leading-relaxed mt-4">
            Click any module to see what it catches, example findings, pricing tiers it&apos;s included on, and how the AI auto-fix loop handles it.
          </p>
        </div>

        <div className="space-y-16">
          {categories.map((cat) => (
            <section key={cat.id} id={cat.id}>
              <div className="mb-6">
                <div className="flex items-center gap-3 mb-2">
                  <h2 className="text-2xl sm:text-3xl font-bold text-white">{cat.title}</h2>
                  {cat.comingSoon && (
                    <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full border border-amber-400/30 bg-amber-400/10 text-amber-300 font-mono">
                      Coming soon
                    </span>
                  )}
                </div>
                <p className="text-white/55 leading-relaxed max-w-3xl">{cat.blurb}</p>
                {cat.comingSoon && (
                  <p className="text-xs text-amber-300/70 mt-2">{cat.comingSoon.reason}</p>
                )}
                <p className="text-xs text-white/30 mt-2">{cat.modules.length} module{cat.modules.length === 1 ? "" : "s"} in this category</p>
              </div>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {cat.modules.map((mod) => (
                  <Link
                    key={mod.slug}
                    href={`/modules/${mod.slug}`}
                    className="block rounded-xl border border-white/[0.08] p-5 hover:border-teal-500/30 transition-colors"
                    style={{ background: "rgba(255,255,255,0.02)" }}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <div className="text-white font-semibold">{prettify(mod.name)}</div>
                      {cat.comingSoon && (
                        <span className="text-[9px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded-full border border-amber-400/30 bg-amber-400/10 text-amber-300 font-mono">
                          Soon
                        </span>
                      )}
                    </div>
                    <div className="text-xs font-mono text-teal-300/70 mb-2">{mod.name}</div>
                    <div className="text-white/60 text-sm leading-snug">{mod.description.slice(0, 130)}{mod.description.length > 130 ? "…" : ""}</div>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>

        <section className="mt-20 rounded-2xl border border-teal-500/20 p-10 text-center" style={{ background: "rgba(20,184,166,0.05)" }}>
          <h2 className="text-3xl font-bold text-white mb-4">
            {total} checks. One scan. From $29.
          </h2>
          <p className="text-white/60 mb-8 max-w-xl mx-auto">
            Per-scan pricing. No subscription. AI auto-fix PR on the Scan + Fix and Forensic Scan tiers.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              href="/#pricing"
              className="inline-flex items-center justify-center px-6 py-3 rounded-xl font-semibold text-sm"
              style={{ background: "#2dd4bf", color: "#0a0a12" }}
            >
              See pricing &rarr;
            </Link>
            <Link
              href="/compare/snyk"
              className="inline-flex items-center justify-center px-6 py-3 rounded-xl font-semibold text-sm border border-white/15 text-white/70 hover:border-white/30 hover:text-white transition-colors"
            >
              Compare to Snyk
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/[0.06] px-6 py-8">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-white/30">
          <span>GateTest &copy; 2026</span>
          <div className="flex gap-6">
            <Link href="/" className="hover:text-white/60 transition-colors">Home</Link>
            <Link href="/#pricing" className="hover:text-white/60 transition-colors">Pricing</Link>
            <Link href="/legal/terms" className="hover:text-white/60 transition-colors">Terms</Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
