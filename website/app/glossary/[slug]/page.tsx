import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getAllGlossarySlugs,
  getGlossaryBySlug,
  getRelatedGlossary,
} from "../glossary-catalog";
import {
  contentMetadata,
  definedTermSchema,
  faqSchema,
  breadcrumbSchema,
  jsonLd,
} from "../../lib/seo/schema";

interface PageParams {
  params: Promise<{ slug: string }>;
}

export function generateStaticParams(): { slug: string }[] {
  return getAllGlossarySlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { slug } = await params;
  const entry = getGlossaryBySlug(slug);
  if (!entry) return { title: "Term not found — GateTest glossary" };
  return contentMetadata({
    title: `${entry.term} — definition | GateTest glossary`,
    description: entry.shortDef.slice(0, 180),
    path: `/glossary/${entry.slug}`,
    ogType: "article",
    keywords: [
      entry.term.toLowerCase(),
      ...(entry.abbreviation ? [entry.abbreviation.toLowerCase()] : []),
      `what is ${entry.term.toLowerCase()}`,
      `${entry.term.toLowerCase()} definition`,
      `${entry.term.toLowerCase()} meaning`,
    ],
  });
}

export default async function GlossaryTermPage({ params }: PageParams) {
  const { slug } = await params;
  const entry = getGlossaryBySlug(slug);
  if (!entry) notFound();

  const related = getRelatedGlossary(slug, 4);

  const crumbs = [
    { name: "GateTest", path: "/" },
    { name: "Glossary", path: "/glossary" },
    { name: entry.abbreviation ?? entry.term },
  ];

  return (
    <main className="min-h-screen bg-black text-white">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(definedTermSchema({ term: entry.term, description: entry.shortDef, path: `/glossary/${entry.slug}`, abbreviation: entry.abbreviation })) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(faqSchema(entry.faqs)) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(breadcrumbSchema(crumbs)) }} />

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
          <Link href="/glossary" className="text-sm text-white/50 hover:text-white transition-colors">
            Glossary &rarr;
          </Link>
        </div>
      </nav>

      <main className="px-6 py-16 max-w-3xl mx-auto">
        <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm text-white/40 mb-10">
          <Link href="/" className="hover:text-white/70 transition-colors">GateTest</Link>
          <span>/</span>
          <Link href="/glossary" className="hover:text-white/70 transition-colors">Glossary</Link>
          <span>/</span>
          <span className="text-white/60">{entry.abbreviation ?? entry.term}</span>
        </nav>

        <div className="mb-10">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-teal-500/10 border border-teal-500/20 text-xs text-teal-300 font-medium mb-6">
            Glossary
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold text-white leading-tight mb-5">
            {entry.term}
          </h1>
          <p className="text-lg text-white/75 leading-relaxed">{entry.shortDef}</p>
        </div>

        <article className="space-y-5 mb-12">
          {entry.body.map((p, i) => (
            <p key={i} className="text-white/70 leading-relaxed">{p}</p>
          ))}
        </article>

        <section className="mb-12 rounded-xl border border-teal-500/20 p-6" style={{ background: "rgba(20,184,166,0.05)" }}>
          <h2 className="text-sm uppercase tracking-wider text-teal-400 font-semibold mb-3">How GateTest handles it</h2>
          <p className="text-white/80 leading-relaxed">{entry.gatetest}</p>
          {entry.modules.length > 0 && (
            <p className="text-white/60 text-sm mt-4">
              Related modules:{" "}
              {entry.modules.map((m, i) => (
                <span key={m}>
                  <Link href={`/modules/${moduleToSlug(m)}`} className="text-teal-300 hover:text-teal-200 font-mono">{m}</Link>
                  {i < entry.modules.length - 1 ? ", " : ""}
                </span>
              ))}
            </p>
          )}
        </section>

        <section className="mb-12">
          <h2 className="text-2xl font-bold text-white mb-6">Frequently asked questions</h2>
          <div className="space-y-4">
            {entry.faqs.map((f) => (
              <div key={f.q} className="rounded-xl border border-white/[0.08] p-5" style={{ background: "rgba(255,255,255,0.02)" }}>
                <h3 className="text-white font-semibold mb-2 leading-snug">{f.q}</h3>
                <p className="text-white/60 text-sm leading-relaxed">{f.a}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mb-12 rounded-2xl border border-teal-500/20 p-8 text-center" style={{ background: "rgba(20,184,166,0.05)" }}>
          <h2 className="text-2xl font-bold text-white mb-3">See {entry.abbreviation ?? entry.term} on your own repo</h2>
          <p className="text-white/60 mb-6">Free preview of findings. Pay per scan — no subscription. AI auto-fix PR on the Scan + Fix tier.</p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link href="/#pricing" className="inline-flex items-center justify-center px-6 py-3 rounded-xl font-semibold text-sm" style={{ background: "#2dd4bf", color: "#0a0a12" }}>
              Run a scan &mdash; from $29
            </Link>
            <Link href="/glossary" className="inline-flex items-center justify-center px-6 py-3 rounded-xl font-semibold text-sm border border-white/15 text-white/70 hover:border-white/30 hover:text-white transition-colors">
              Browse the glossary
            </Link>
          </div>
        </section>

        {related.length > 0 && (
          <section className="mb-12">
            <h2 className="text-2xl font-bold text-white mb-6">Related terms</h2>
            <div className="grid sm:grid-cols-2 gap-3">
              {related.map((r) => (
                <Link key={r.slug} href={`/glossary/${r.slug}`} className="block rounded-xl border border-white/[0.08] p-4 hover:border-teal-500/30 transition-colors" style={{ background: "rgba(255,255,255,0.02)" }}>
                  <div className="text-white font-semibold mb-1">{r.abbreviation ?? r.term}</div>
                  <div className="text-white/55 text-sm leading-snug">{r.shortDef.slice(0, 110)}{r.shortDef.length > 110 ? "…" : ""}</div>
                </Link>
              ))}
            </div>
          </section>
        )}
      </main>

      <footer className="border-t border-white/[0.06] px-6 py-8">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-white/30">
          <span>GateTest &copy; 2026</span>
          <div className="flex gap-6">
            <Link href="/glossary" className="hover:text-white/60 transition-colors">Glossary</Link>
            <Link href="/use-cases" className="hover:text-white/60 transition-colors">Use cases</Link>
            <Link href="/modules" className="hover:text-white/60 transition-colors">Modules</Link>
            <Link href="/#pricing" className="hover:text-white/60 transition-colors">Pricing</Link>
          </div>
        </div>
      </footer>
    </main>
  );
}

function moduleToSlug(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
