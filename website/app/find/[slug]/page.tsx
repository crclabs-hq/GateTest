import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SITE_URL } from "@/app/lib/site-url";
import {
  getAllCweSlugs,
  getCweBySlug,
  getRelatedCwes,
  type CweEntry,
} from "../cwe-catalog";
import PageHero from "../../components/site/PageHero";
import Section from "../../components/site/Section";

interface PageParams {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams(): Promise<{ slug: string }[]> {
  return getAllCweSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { slug } = await params;
  const cwe = getCweBySlug(slug);
  if (!cwe) {
    return { title: "CWE not found — GateTest" };
  }
  const title = `${cwe.name} (CWE-${cwe.id}) — how to detect + fix | GateTest`;
  const description = `${cwe.shortDesc} ${cwe.modules.length > 0 ? `Caught by GateTest's ${cwe.modules.join(", ")} module${cwe.modules.length === 1 ? "" : "s"}.` : "Not currently covered by GateTest."}`;
  const canonical = `/find/${cwe.slug}`;
  return {
    title,
    description,
    keywords: [
      `CWE-${cwe.id}`,
      cwe.name.toLowerCase(),
      `how to detect ${cwe.name.toLowerCase()}`,
      `how to fix ${cwe.name.toLowerCase()}`,
      `${cwe.name.toLowerCase()} scanner`,
      `${cwe.name.toLowerCase()} static analysis`,
      ...cwe.modules.map((m) => `gatetest ${m}`),
    ],
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

export default async function CwePage({ params }: PageParams) {
  const { slug } = await params;
  const cwe = getCweBySlug(slug);
  if (!cwe) notFound();

  const related = getRelatedCwes(slug, 4);
  const covered = cwe.modules.length > 0;

  const faqs: { q: string; a: string }[] = [
    {
      q: `What is CWE-${cwe.id} (${cwe.name})?`,
      a: cwe.shortDesc,
    },
    {
      q: `How do I fix ${cwe.name.toLowerCase()}?`,
      a: cwe.remediation,
    },
    covered
      ? {
          q: `Does GateTest detect ${cwe.name.toLowerCase()}?`,
          a: `Yes — GateTest's ${cwe.modules.join(", ")} module${cwe.modules.length === 1 ? "" : "s"} catch this class. Findings appear in the standard scan output with file and line numbers. On Scan + Fix and Forensic Scan tiers, Claude opens a pull request with the fix.`,
        }
      : {
          q: `Does GateTest detect CWE-${cwe.id}?`,
          a: isMemorySafetyClass(slug)
            ? `Not directly today. GateTest focuses on web-stack languages (JavaScript, TypeScript, Python, Go, Rust, Java, Ruby, PHP, C#, Kotlin, Swift) and infrastructure-as-code. ${cwe.name} is most relevant to C / C++ code. For full coverage of this class, pair GateTest with CodeQL or a memory-safety analyzer.`
            : `Not with a dedicated rule today. ${cwe.name} depends on application logic or runtime behaviour that a static pattern cannot see on its own. ${cwe.remediation}`,
        },
    {
      q: `What rank is ${cwe.name} in the CWE Top 25?`,
      a: `${cwe.name} is ranked #${cwe.rank} in the MITRE 2023 CWE Top 25 Most Dangerous Software Weaknesses list. The ranking reflects both prevalence (how often it appears in real CVEs) and severity (the typical impact when it's exploited).`,
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

  const techArticleJsonLd = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: `${cwe.name} (CWE-${cwe.id}) — detection and remediation`,
    description: cwe.shortDesc,
    author: { "@type": "Organization", name: "GateTest" },
    publisher: { "@type": "Organization", name: "GateTest", url: SITE_URL },
    mainEntityOfPage: `${SITE_URL}/find/${cwe.slug}`,
  };

  return (
    <main>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(techArticleJsonLd) }} />

      <div className="section-alt relative z-10 -mb-8">
        <nav aria-label="Breadcrumb" className="mx-auto max-w-7xl px-6 pt-6 flex flex-wrap items-center gap-2 text-sm text-muted">
          <Link href="/" className="hover:text-foreground transition-colors">GateTest</Link>
          <span aria-hidden="true">/</span>
          <Link href="/find" className="hover:text-foreground transition-colors">Find</Link>
          <span aria-hidden="true">/</span>
          <span className="text-foreground-secondary">CWE-{cwe.id}</span>
        </nav>
      </div>

      <PageHero
        eyebrow={<>CWE Top 25 — #{cwe.rank}</>}
        title={cwe.name}
        lede={
          <>
            <span className="block text-sm font-mono text-accent mb-3">CWE-{cwe.id}</span>
            {cwe.shortDesc}
          </>
        }
      />

      <Section narrow>
        {/* Coverage status */}
        {covered ? (
          <div className="mb-12 rounded-xl border border-accent/20 bg-accent/5 p-6">
            <h2 className="text-sm uppercase tracking-wider text-accent font-semibold mb-3">GateTest coverage</h2>
            <p className="text-foreground leading-relaxed">
              Caught by:{" "}
              {cwe.modules.map((m, i) => (
                <span key={m}>
                  <Link href={`/modules/${moduleToSlug(m)}`} className="text-accent hover:text-accent-hover font-mono">{m}</Link>
                  {i < cwe.modules.length - 1 ? ", " : ""}
                </span>
              ))}
            </p>
          </div>
        ) : (
          <div className="mb-12 rounded-xl border border-warning/25 bg-warning/5 p-6">
            <h2 className="text-sm uppercase tracking-wider text-warning font-semibold mb-3">GateTest coverage</h2>
            <p className="text-foreground leading-relaxed">
              <strong className="text-warning">Not directly covered today.</strong>{" "}
              {isMemorySafetyClass(slug)
                ? "GateTest focuses on web-stack languages and infrastructure-as-code. For this class of bug, pair GateTest with a C/C++-aware analyzer."
                : "GateTest has no dedicated rule for this class yet — it depends on application logic or runtime behaviour a static pattern cannot see. The remediation below says which adjacent GateTest checks apply."}
            </p>
          </div>
        )}

        {/* Example */}
        <div className="mb-12 rounded-xl bg-panel text-panel-foreground border border-panel-border p-6">
          <h2 className="text-sm uppercase tracking-wider text-panel-muted font-semibold mb-3">Example</h2>
          <pre className="text-sm font-mono whitespace-pre-wrap leading-relaxed overflow-x-auto">{cwe.example}</pre>
        </div>

        {/* Remediation */}
        <div className="mb-12">
          <h2 className="font-display text-2xl font-bold text-foreground mb-4">How to fix it</h2>
          <p className="text-foreground-secondary leading-relaxed">{cwe.remediation}</p>
        </div>

        {/* CTA */}
        {covered && (
          <div className="rounded-2xl border border-accent/20 bg-accent/5 p-8 text-center">
            <h2 className="font-display text-2xl font-bold text-foreground mb-3">Scan your repo for CWE-{cwe.id}</h2>
            <p className="text-foreground-secondary mb-6">Free preview of findings. Pay per scan — no subscription required. AI auto-fix PR included on the Scan + Fix tier.</p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Link href="/#pricing" className="btn-cta px-6 py-3 text-sm">
                Run a scan &mdash; from $29
              </Link>
              <Link href="/find" className="btn-secondary px-6 py-3 text-sm">
                Browse CWE Top 25
              </Link>
            </div>
          </div>
        )}
      </Section>

      <Section alt narrow title="Frequently asked questions">
        <div className="space-y-4">
          {faqs.map((f) => (
            <div key={f.q} className="card p-5">
              <h3 className="text-foreground font-semibold mb-2 leading-snug">{f.q}</h3>
              <p className="text-foreground-secondary text-sm leading-relaxed">{f.a}</p>
            </div>
          ))}
        </div>
      </Section>

      {related.length > 0 && (
        <Section narrow title="Related CWEs">
          <div className="grid sm:grid-cols-2 gap-3">
            {related.map((r) => (
              <Link key={r.slug} href={`/find/${r.slug}`} className="card block p-4">
                <div className="text-xs font-mono text-accent mb-1">CWE-{r.id} &middot; #{r.rank} in Top 25</div>
                <div className="text-foreground font-semibold mb-1">{r.name}</div>
                <div className="text-foreground-secondary text-sm leading-snug">{r.shortDesc.slice(0, 120)}{r.shortDesc.length > 120 ? "…" : ""}</div>
              </Link>
            ))}
          </div>
        </Section>
      )}
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

/** The C/C++ memory-safety classes GateTest does not scan for — the
 *  "pair with a memory-safety analyzer" advice only makes sense for these;
 *  an uncovered authorisation or upload class needs different advice. */
function isMemorySafetyClass(slug: string): boolean {
  return ["buffer", "memory", "overflow", "null-pointer", "integer", "out-of-bounds", "use-after-free"].some((k) => slug.includes(k));
}

// Silence unused-export warnings on the type when imported only for shape
type _Used = CweEntry;
void (null as unknown as _Used);
