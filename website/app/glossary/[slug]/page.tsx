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
import PageHero from "../../components/site/PageHero";
import Section from "../../components/site/Section";

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
    <main>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(definedTermSchema({ term: entry.term, description: entry.shortDef, path: `/glossary/${entry.slug}`, abbreviation: entry.abbreviation })) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(faqSchema(entry.faqs)) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(breadcrumbSchema(crumbs)) }} />

      <div className="section-alt relative z-10 -mb-8">
        <nav aria-label="Breadcrumb" className="mx-auto max-w-7xl px-6 pt-6 flex flex-wrap items-center gap-2 text-sm text-muted">
          <Link href="/" className="hover:text-foreground transition-colors">GateTest</Link>
          <span aria-hidden="true">/</span>
          <Link href="/glossary" className="hover:text-foreground transition-colors">Glossary</Link>
          <span aria-hidden="true">/</span>
          <span className="text-foreground-secondary">{entry.abbreviation ?? entry.term}</span>
        </nav>
      </div>

      <PageHero eyebrow="Glossary" title={entry.term} lede={entry.shortDef} />

      <Section narrow>
        <article className="space-y-5 mb-12">
          {entry.body.map((p, i) => (
            <p key={i} className="text-foreground-secondary leading-relaxed">{p}</p>
          ))}
        </article>

        <div className="rounded-xl border border-accent/20 bg-accent/5 p-6">
          <h2 className="text-sm uppercase tracking-wider text-accent font-semibold mb-3">How GateTest handles it</h2>
          <p className="text-foreground leading-relaxed">{entry.gatetest}</p>
          {entry.modules.length > 0 && (
            <p className="text-foreground-secondary text-sm mt-4">
              Related modules:{" "}
              {entry.modules.map((m, i) => (
                <span key={m}>
                  <Link href={`/modules/${moduleToSlug(m)}`} className="text-accent hover:text-accent-hover font-mono">{m}</Link>
                  {i < entry.modules.length - 1 ? ", " : ""}
                </span>
              ))}
            </p>
          )}
        </div>
      </Section>

      <Section alt narrow title="Frequently asked questions">
        <div className="space-y-4">
          {entry.faqs.map((f) => (
            <div key={f.q} className="card p-5">
              <h3 className="text-foreground font-semibold mb-2 leading-snug">{f.q}</h3>
              <p className="text-foreground-secondary text-sm leading-relaxed">{f.a}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section narrow>
        <div className="rounded-2xl border border-accent/20 bg-accent/5 p-8 text-center">
          <h2 className="font-display text-2xl font-bold text-foreground mb-3">See {entry.abbreviation ?? entry.term} on your own repo</h2>
          <p className="text-foreground-secondary mb-6">Free preview of findings. Pay per scan — no subscription required. AI auto-fix PR on the Scan + Fix tier.</p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link href="/#pricing" className="btn-cta px-6 py-3 text-sm">
              Run a scan &mdash; from $29
            </Link>
            <Link href="/glossary" className="btn-secondary px-6 py-3 text-sm">
              Browse the glossary
            </Link>
          </div>
        </div>

        {related.length > 0 && (
          <div className="mt-12">
            <h2 className="font-display text-2xl font-bold text-foreground mb-6">Related terms</h2>
            <div className="grid sm:grid-cols-2 gap-3">
              {related.map((r) => (
                <Link key={r.slug} href={`/glossary/${r.slug}`} className="card block p-4">
                  <div className="text-foreground font-semibold mb-1">{r.abbreviation ?? r.term}</div>
                  <div className="text-foreground-secondary text-sm leading-snug">{r.shortDef.slice(0, 110)}{r.shortDef.length > 110 ? "…" : ""}</div>
                </Link>
              ))}
            </div>
          </div>
        )}
      </Section>
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
