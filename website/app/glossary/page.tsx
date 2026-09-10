import type { Metadata } from "next";
import Link from "next/link";
import { GLOSSARY } from "./glossary-catalog";
import {
  contentMetadata,
  collectionPageSchema,
  breadcrumbSchema,
  jsonLd,
} from "../lib/seo/schema";
import PageHero from "../components/site/PageHero";
import Section from "../components/site/Section";
import siteStats from "../data/site-stats.json";

export const metadata: Metadata = contentMetadata({
  title: "Software Quality & Security Glossary | GateTest",
  description:
    "Plain-English definitions of the software quality and application-security terms developers actually search for — SAST, DAST, SCA, SARIF, quality gates, mutation testing, SBOM, and more, grounded in how GateTest scans for them.",
  path: "/glossary",
  keywords: [
    "software security glossary",
    "application security terms",
    "code quality glossary",
    "what is SAST",
    "what is DAST",
    "what is SCA",
  ],
});

export default function GlossaryIndexPage() {
  const items = GLOSSARY.map((g) => ({ name: g.term, path: `/glossary/${g.slug}` }));

  return (
    <main>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(collectionPageSchema({ name: "GateTest Software Quality & Security Glossary", description: "Definitions of the software quality and application-security terms developers search for.", path: "/glossary", items })) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(breadcrumbSchema([{ name: "GateTest", path: "/" }, { name: "Glossary" }])) }} />

      <div className="section-alt relative z-10 -mb-8">
        <nav aria-label="Breadcrumb" className="mx-auto max-w-7xl px-6 pt-6 flex flex-wrap items-center gap-2 text-sm text-muted">
          <Link href="/" className="hover:text-foreground transition-colors">GateTest</Link>
          <span aria-hidden="true">/</span>
          <span className="text-foreground-secondary">Glossary</span>
        </nav>
      </div>

      <PageHero
        eyebrow="Glossary"
        title={<>Software quality &amp; security glossary</>}
        lede="The terms that show up in every security review and every AI-generated pull request — defined in plain English, and tied back to exactly how GateTest scans for them."
        actions={
          <Link href="/modules" className="btn-secondary px-5 py-2.5 text-sm">
            {siteStats.modules.total} modules &rarr;
          </Link>
        }
      />

      <Section>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {GLOSSARY.map((g) => (
            <Link key={g.slug} href={`/glossary/${g.slug}`} className="card block p-5">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                {g.abbreviation && (
                  <span className="text-xs font-mono text-accent px-2 py-0.5 rounded bg-accent/10 border border-accent/20">{g.abbreviation}</span>
                )}
                <h2 className="font-display text-foreground font-semibold leading-snug">{g.term}</h2>
              </div>
              <p className="text-foreground-secondary text-sm leading-relaxed">{g.shortDef.slice(0, 140)}{g.shortDef.length > 140 ? "…" : ""}</p>
            </Link>
          ))}
        </div>
      </Section>
    </main>
  );
}
