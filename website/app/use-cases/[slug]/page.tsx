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
import PageHero from "../../components/site/PageHero";
import Section from "../../components/site/Section";

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
    <main>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(articleSchema({ headline: uc.title, description: uc.shortDef, path: `/use-cases/${uc.slug}` })) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(faqSchema(uc.faqs)) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(breadcrumbSchema(crumbs)) }} />

      <div className="section-alt relative z-10 -mb-8">
        <nav aria-label="Breadcrumb" className="mx-auto max-w-7xl px-6 pt-6 flex flex-wrap items-center gap-2 text-sm text-muted">
          <Link href="/" className="hover:text-foreground transition-colors">GateTest</Link>
          <span aria-hidden="true">/</span>
          <Link href="/use-cases" className="hover:text-foreground transition-colors">Use cases</Link>
          <span aria-hidden="true">/</span>
          <span className="text-foreground-secondary">{uc.title}</span>
        </nav>
      </div>

      <PageHero
        eyebrow="Use case"
        title={uc.title}
        lede={
          <>
            <span className="block text-accent mb-4">{uc.intent}</span>
            {uc.shortDef}
          </>
        }
      />

      <Section narrow>
        <div className="mb-10">
          <h2 className="font-display text-2xl font-bold text-foreground mb-4">The problem</h2>
          <div className="space-y-4">
            {uc.problem.map((p, i) => (
              <p key={i} className="text-foreground-secondary leading-relaxed">{p}</p>
            ))}
          </div>
        </div>

        <div className="mb-10">
          <h2 className="font-display text-2xl font-bold text-foreground mb-4">How GateTest does it</h2>
          <div className="space-y-4">
            {uc.solution.map((p, i) => (
              <p key={i} className="text-foreground-secondary leading-relaxed">{p}</p>
            ))}
          </div>
        </div>

        {uc.code && (
          <div className="mb-10">
            <div className="text-xs font-mono text-muted mb-2">{uc.code.label}</div>
            <pre className="text-sm font-mono whitespace-pre-wrap leading-relaxed rounded-xl bg-panel text-panel-foreground border border-panel-border p-5 overflow-x-auto">{uc.code.content}</pre>
          </div>
        )}

        <div>
          <h2 className="font-display text-2xl font-bold text-foreground mb-5">Steps</h2>
          <ol className="space-y-3">
            {uc.steps.map((s, i) => (
              <li key={i} className="flex gap-3 text-foreground-secondary leading-relaxed">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-accent/10 border border-accent/30 text-accent text-xs font-semibold flex items-center justify-center">{i + 1}</span>
                <span>{s}</span>
              </li>
            ))}
          </ol>
        </div>
      </Section>

      <Section alt narrow title="Frequently asked questions">
        <div className="space-y-4">
          {uc.faqs.map((f) => (
            <div key={f.q} className="card p-5">
              <h3 className="text-foreground font-semibold mb-2 leading-snug">{f.q}</h3>
              <p className="text-foreground-secondary text-sm leading-relaxed">{f.a}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section narrow>
        <div className="rounded-2xl border border-accent/20 bg-accent/5 p-8 text-center">
          <h2 className="font-display text-2xl font-bold text-foreground mb-3">Put this gate on your repo</h2>
          <p className="text-foreground-secondary mb-6">Free preview of findings. Pay per scan — no subscription. AI auto-fix PR on the Scan + Fix tier.</p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link href="/github/setup" className="btn-cta px-6 py-3 text-sm">
              Install the GitHub App
            </Link>
            <Link href="/use-cases" className="btn-secondary px-6 py-3 text-sm">
              More use cases
            </Link>
          </div>
        </div>

        {related.length > 0 && (
          <div className="mt-12">
            <h2 className="font-display text-2xl font-bold text-foreground mb-6">Related use cases</h2>
            <div className="grid sm:grid-cols-2 gap-3">
              {related.map((r) => (
                <Link key={r.slug} href={`/use-cases/${r.slug}`} className="card block p-4">
                  <div className="text-foreground font-semibold mb-1">{r.title}</div>
                  <div className="text-foreground-secondary text-sm leading-snug">{r.intent}</div>
                </Link>
              ))}
            </div>
          </div>
        )}
      </Section>
    </main>
  );
}
