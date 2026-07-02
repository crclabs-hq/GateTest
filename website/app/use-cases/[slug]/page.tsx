import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getAllUseCaseSlugs,
  getUseCaseBySlug,
  getRelatedUseCases,
} from "../use-cases-catalog";
import {
  contentMetadata,
  articleSchema,
  faqSchema,
  breadcrumbSchema,
  jsonLd,
} from "../../lib/seo/schema";

interface PageParams {
  params: Promise<{ slug: string }>;
}

export function generateStaticParams(): { slug: string }[] {
  return getAllUseCaseSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { slug } = await params;
  const uc = getUseCaseBySlug(slug);
  if (!uc) return { title: "Use case not found — GateTest" };
  return contentMetadata({
    title: `${uc.title} — with GateTest`,
    description: uc.shortDef.slice(0, 180),
    path: `/use-cases/${uc.slug}`,
    ogType: "article",
    keywords: [
      uc.title.toLowerCase(),
      uc.intent.toLowerCase(),
      "gatetest",
      "ci quality gate",
      "block pr security",
    ],
  });
}

export default async function UseCasePage({ params }: PageParams) {
  const { slug } = await params;
  const uc = getUseCaseBySlug(slug);
  if (!uc) notFound();

  const related = getRelatedUseCases(slug, 3);
  const crumbs = [
    { name: "GateTest", path: "/" },
    { name: "Use cases", path: "/use-cases" },
    { name: uc.title },
  ];

  return (
    <main className="min-h-screen bg-black text-white">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(articleSchema({ headline: uc.title, description: uc.shortDef, path: `/use-cases/${uc.slug}` })) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(faqSchema(uc.faqs)) }} />
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
          <Link href="/use-cases" className="text-sm text-white/50 hover:text-white transition-colors">
            Use cases &rarr;
          </Link>
        </div>
      </nav>

      <main className="px-6 py-16 max-w-3xl mx-auto">
        <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm text-white/40 mb-10">
          <Link href="/" className="hover:text-white/70 transition-colors">GateTest</Link>
          <span>/</span>
          <Link href="/use-cases" className="hover:text-white/70 transition-colors">Use cases</Link>
          <span>/</span>
          <span className="text-white/60">{uc.title}</span>
        </nav>

        <div className="mb-10">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-teal-500/10 border border-teal-500/20 text-xs text-teal-300 font-medium mb-6">
            Use case
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold text-white leading-tight mb-4">{uc.title}</h1>
          <p className="text-lg text-teal-200/70 mb-5">{uc.intent}</p>
          <p className="text-lg text-white/75 leading-relaxed">{uc.shortDef}</p>
        </div>

        <section className="mb-10">
          <h2 className="text-2xl font-bold text-white mb-4">The problem</h2>
          <div className="space-y-4">
            {uc.problem.map((p, i) => (
              <p key={i} className="text-white/70 leading-relaxed">{p}</p>
            ))}
          </div>
        </section>

        <section className="mb-10">
          <h2 className="text-2xl font-bold text-white mb-4">How GateTest does it</h2>
          <div className="space-y-4">
            {uc.solution.map((p, i) => (
              <p key={i} className="text-white/70 leading-relaxed">{p}</p>
            ))}
          </div>
        </section>

        {uc.code && (
          <section className="mb-10">
            <div className="text-xs font-mono text-white/40 mb-2">{uc.code.label}</div>
            <pre className="text-sm font-mono text-teal-100/90 whitespace-pre-wrap leading-relaxed rounded-xl border border-white/[0.08] p-5 overflow-x-auto" style={{ background: "rgba(255,255,255,0.02)" }}>{uc.code.content}</pre>
          </section>
        )}

        <section className="mb-12">
          <h2 className="text-2xl font-bold text-white mb-5">Steps</h2>
          <ol className="space-y-3">
            {uc.steps.map((s, i) => (
              <li key={i} className="flex gap-3 text-white/70 leading-relaxed">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-teal-500/15 border border-teal-500/30 text-teal-300 text-xs font-semibold flex items-center justify-center">{i + 1}</span>
                <span>{s}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="mb-12">
          <h2 className="text-2xl font-bold text-white mb-6">Frequently asked questions</h2>
          <div className="space-y-4">
            {uc.faqs.map((f) => (
              <div key={f.q} className="rounded-xl border border-white/[0.08] p-5" style={{ background: "rgba(255,255,255,0.02)" }}>
                <h3 className="text-white font-semibold mb-2 leading-snug">{f.q}</h3>
                <p className="text-white/60 text-sm leading-relaxed">{f.a}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mb-12 rounded-2xl border border-teal-500/20 p-8 text-center" style={{ background: "rgba(20,184,166,0.05)" }}>
          <h2 className="text-2xl font-bold text-white mb-3">Put this gate on your repo</h2>
          <p className="text-white/60 mb-6">Free preview of findings. Pay per scan — no subscription. AI auto-fix PR on the Scan + Fix tier.</p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link href="/github/setup" className="inline-flex items-center justify-center px-6 py-3 rounded-xl font-semibold text-sm" style={{ background: "#2dd4bf", color: "#0a0a12" }}>
              Install the GitHub App
            </Link>
            <Link href="/use-cases" className="inline-flex items-center justify-center px-6 py-3 rounded-xl font-semibold text-sm border border-white/15 text-white/70 hover:border-white/30 hover:text-white transition-colors">
              More use cases
            </Link>
          </div>
        </section>

        {related.length > 0 && (
          <section className="mb-12">
            <h2 className="text-2xl font-bold text-white mb-6">Related use cases</h2>
            <div className="grid sm:grid-cols-2 gap-3">
              {related.map((r) => (
                <Link key={r.slug} href={`/use-cases/${r.slug}`} className="block rounded-xl border border-white/[0.08] p-4 hover:border-teal-500/30 transition-colors" style={{ background: "rgba(255,255,255,0.02)" }}>
                  <div className="text-white font-semibold mb-1">{r.title}</div>
                  <div className="text-white/55 text-sm leading-snug">{r.intent}</div>
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
            <Link href="/use-cases" className="hover:text-white/60 transition-colors">Use cases</Link>
            <Link href="/glossary" className="hover:text-white/60 transition-colors">Glossary</Link>
            <Link href="/modules" className="hover:text-white/60 transition-colors">Modules</Link>
            <Link href="/#pricing" className="hover:text-white/60 transition-colors">Pricing</Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
