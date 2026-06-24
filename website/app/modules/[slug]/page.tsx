import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getAllModuleSlugs,
  getModuleBySlug,
  getRelatedModules,
  getTotalModuleCount,
  type ResolvedModule,
} from "../../components/howitworks/module-slugs";

interface PageParams {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams(): Promise<{ slug: string }[]> {
  return getAllModuleSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { slug } = await params;
  const mod = getModuleBySlug(slug);
  if (!mod) {
    return { title: "Module not found — GateTest" };
  }
  const title = `${prettify(mod.name)} — GateTest module that catches it before you ship`;
  const description = `${mod.description} Runs as part of the GateTest scan suite — one config, ${getTotalModuleCount()} modules, AI auto-fix PR included.`;
  const canonical = `https://gatetest.ai/modules/${mod.slug}`;
  return {
    title,
    description,
    keywords: buildKeywords(mod),
    alternates: { canonical },
    openGraph: {
      title,
      description,
      url: canonical,
      siteName: "GateTest",
      type: "article",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

function prettify(name: string): string {
  // Convert camelCase to spaced Title Case for headings
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

function buildKeywords(mod: { name: string }): string[] {
  const pretty = prettify(mod.name).toLowerCase();
  return [
    `${pretty} detection`,
    `${pretty} scanner`,
    `${pretty} bug`,
    `how to detect ${pretty}`,
    `how to fix ${pretty}`,
    `${pretty} static analysis`,
    `gatetest ${mod.name}`,
  ];
}

export default async function ModulePage({ params }: PageParams) {
  const { slug } = await params;
  const mod: ResolvedModule | null = getModuleBySlug(slug);
  if (!mod) notFound();

  const related = getRelatedModules(slug, 6);
  const pretty = prettify(mod.name);
  const totalModules = getTotalModuleCount();

  // FAQPage structured data — 4 questions per module
  const faqs = [
    {
      q: `What does the ${pretty} module catch?`,
      a: `${mod.description} Example finding: ${mod.example}`,
    },
    {
      q: `Does GateTest fix ${pretty} issues automatically?`,
      a: `Yes — on the Scan + Fix tier ($199) and Forensic Scan tier ($399), Claude reads the finding, writes the fix, validates against the scanner, writes a regression test, and opens a pull request for your review.`,
    },
    {
      q: `Which tiers include the ${pretty} module?`,
      a: `The Full tier ($99), Scan + Fix tier ($199), and Forensic Scan tier ($399) include all ${totalModules} modules including ${pretty}. The Quick tier ($29) only includes 4 essential modules.`,
    },
    {
      q: `Can I run the ${pretty} module from the CLI for free?`,
      a: `Yes — install with \`npm i -g gatetest\` and run \`gatetest --module ${mod.name}\` against any local repository. Paid tiers add AI auto-fix and the cross-finding correlation work.`,
    },
  ];

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };

  // SoftwareApplication structured data
  const softwareJsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: `GateTest — ${pretty}`,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Cross-platform (Node.js 20+)",
    offers: {
      "@type": "Offer",
      price: "99",
      priceCurrency: "USD",
      description: `Full Scan — all ${totalModules} modules including ${pretty}`,
    },
    aggregateRating: undefined, // not faked
  };

  return (
    <main className="min-h-screen bg-black text-white">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareJsonLd) }} />

      {/* Nav */}
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
          <Link href="/modules" className="text-sm text-white/50 hover:text-white transition-colors">
            All {totalModules} modules &rarr;
          </Link>
        </div>
      </nav>

      <main className="px-6 py-16 max-w-4xl mx-auto">
        {/* Breadcrumb */}
        <nav className="flex items-center gap-2 text-sm text-white/40 mb-10">
          <Link href="/" className="hover:text-white/70 transition-colors">GateTest</Link>
          <span>/</span>
          <Link href="/modules" className="hover:text-white/70 transition-colors">Modules</Link>
          <span>/</span>
          <Link href={`/modules#${mod.category.id}`} className="hover:text-white/70 transition-colors">{mod.category.title}</Link>
          <span>/</span>
          <span className="text-white/60">{pretty}</span>
        </nav>

        {/* Hero */}
        <div className="mb-12">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-teal-500/10 border border-teal-500/20 text-xs text-teal-400 font-medium mb-6">
            {mod.category.title} module
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold text-white leading-tight mb-6">
            {pretty}
          </h1>
          <p className="text-lg text-white/70 leading-relaxed mb-2">
            {mod.description}
          </p>
          <p className="text-sm text-white/45 leading-relaxed">
            One of {totalModules} modules in the GateTest scan suite. Catches the issue before it reaches code review, and on paid tiers opens a pull request with the fix already written.
          </p>
        </div>

        {/* Example finding */}
        <section className="mb-12 rounded-xl border border-white/[0.08] p-6" style={{ background: "rgba(255,255,255,0.02)" }}>
          <h2 className="text-sm uppercase tracking-wider text-white/40 font-semibold mb-3">Example finding from the {mod.name} module</h2>
          <pre className="text-sm font-mono text-amber-200/90 whitespace-pre-wrap leading-relaxed">{mod.example}</pre>
        </section>

        {/* Category context */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold text-white mb-4">Why we catch it</h2>
          <p className="text-white/65 leading-relaxed mb-3">{mod.category.blurb}</p>
          <p className="text-white/65 leading-relaxed">
            The <span className="text-teal-300 font-medium">{pretty}</span> module sits in this category alongside {related.length} related modules. Together they form one of the layers of a GateTest scan — checks fire in parallel, findings cluster by root cause, and on paid tiers the AI auto-fix loop reads each finding, writes the fix, validates against the scanner, and opens a PR.
          </p>
        </section>

        {/* How GateTest covers this */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold text-white mb-4">How GateTest covers {pretty.toLowerCase()}</h2>
          <ul className="space-y-3 text-white/70 leading-relaxed">
            <li className="flex items-start gap-2">
              <span className="text-teal-400 mt-1">&#10003;</span>
              <span><strong className="text-white">Runs in every scan.</strong> Included on the Full ($99), Scan + Fix ($199), and Forensic Scan ($399) tiers. No additional configuration.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-teal-400 mt-1">&#10003;</span>
              <span><strong className="text-white">Free CLI.</strong> <code className="text-white/80 text-sm bg-white/5 px-1.5 py-0.5 rounded">npm i -g gatetest && gatetest --module {mod.name}</code> against any local repo. No paywall on the scanning itself.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-teal-400 mt-1">&#10003;</span>
              <span><strong className="text-white">AI auto-fix PR.</strong> Scan + Fix tier opens a pull request with the fix, a regression test, and a pair-review by a second Claude. Forensic Scan tier adds per-finding diagnosis and cross-finding attack-chain correlation.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-teal-400 mt-1">&#10003;</span>
              <span><strong className="text-white">Honest confidence rating.</strong> Findings come with high / medium / low confidence so noisy patterns don&apos;t block the gate. The confidence-calibrator trainer reads customer suppressions and tightens rules over time.</span>
            </li>
          </ul>
        </section>

        {/* CTA */}
        <section className="mb-12 rounded-2xl border border-teal-500/20 p-8 text-center" style={{ background: "rgba(20,184,166,0.05)" }}>
          <h2 className="text-2xl font-bold text-white mb-3">Scan your repo for {pretty.toLowerCase()}</h2>
          <p className="text-white/60 mb-6">Free preview of the headline findings. Pay per scan — no subscription.</p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              href="/#pricing"
              className="inline-flex items-center justify-center px-6 py-3 rounded-xl font-semibold text-sm"
              style={{ background: "#2dd4bf", color: "#0a0a12" }}
            >
              Run a scan &mdash; from $29
            </Link>
            <Link
              href="/modules"
              className="inline-flex items-center justify-center px-6 py-3 rounded-xl font-semibold text-sm border border-white/15 text-white/70 hover:border-white/30 hover:text-white transition-colors"
            >
              See all {totalModules} modules
            </Link>
          </div>
        </section>

        {/* FAQ */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold text-white mb-6">Frequently asked questions</h2>
          <div className="space-y-4">
            {faqs.map((f) => (
              <div
                key={f.q}
                className="rounded-xl border border-white/[0.08] p-5"
                style={{ background: "rgba(255,255,255,0.02)" }}
              >
                <h3 className="text-white font-semibold mb-2 leading-snug">{f.q}</h3>
                <p className="text-white/60 text-sm leading-relaxed">{f.a}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Related modules — internal linking */}
        {related.length > 0 && (
          <section className="mb-12">
            <h2 className="text-2xl font-bold text-white mb-6">Related modules in {mod.category.title}</h2>
            <div className="grid sm:grid-cols-2 gap-3">
              {related.map((r) => (
                <Link
                  key={r.slug}
                  href={`/modules/${r.slug}`}
                  className="block rounded-xl border border-white/[0.08] p-4 hover:border-teal-500/30 transition-colors"
                  style={{ background: "rgba(255,255,255,0.02)" }}
                >
                  <div className="text-white font-semibold mb-1">{prettify(r.name)}</div>
                  <div className="text-white/55 text-sm leading-snug">{r.description.slice(0, 120)}{r.description.length > 120 ? "…" : ""}</div>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Cross-links to comparisons */}
        <section className="mb-12 rounded-xl border border-white/[0.08] p-6" style={{ background: "rgba(255,255,255,0.02)" }}>
          <h2 className="text-sm uppercase tracking-wider text-white/40 font-semibold mb-3">Comparing GateTest to another tool?</h2>
          <div className="flex flex-wrap gap-2">
            {["snyk", "sonarqube", "semgrep", "codeql", "deepsource", "eslint", "github-code-scanning"].map((c) => (
              <Link
                key={c}
                href={`/compare/${c}`}
                className="px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-sm text-white/70 hover:text-white hover:border-white/20 transition-colors"
              >
                vs. {c.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
              </Link>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-white/[0.06] px-6 py-8">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-white/30">
          <span>GateTest &copy; 2026</span>
          <div className="flex gap-6">
            <Link href="/modules" className="hover:text-white/60 transition-colors">Modules</Link>
            <Link href="/#pricing" className="hover:text-white/60 transition-colors">Pricing</Link>
            <Link href="/legal/terms" className="hover:text-white/60 transition-colors">Terms</Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
