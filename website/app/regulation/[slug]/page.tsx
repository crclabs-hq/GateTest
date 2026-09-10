import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  REGULATIONS,
  getAllRegulationSlugs,
  getRegulationBySlug,
  moduleNameToSlug,
} from "../catalog";
import { contentMetadata } from "../../lib/seo/schema";
import { SITE_URL } from "../../lib/site-url";
import PageHero from "../../components/site/PageHero";
import Section from "../../components/site/Section";

interface PageParams {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams(): Promise<{ slug: string }[]> {
  return getAllRegulationSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { slug } = await params;
  const reg = getRegulationBySlug(slug);
  if (!reg) return { title: "Regulation not found — GateTest" };
  return contentMetadata({
    title: `${reg.name} compliance scanning for developers | GateTest`,
    description: `Catch the code-level findings ${reg.name} (${reg.longName}) auditors look for — secret hygiene, PII in logs, TLS misconfig — in one GateTest scan.`.slice(0, 180),
    path: `/regulation/${reg.slug}`,
    ogType: "article",
    keywords: [
      `${reg.name.toLowerCase()} compliance`,
      `${reg.name.toLowerCase()} code scanning`,
      `${reg.name.toLowerCase()} developer checklist`,
      "compliance scanner",
      "code audit",
    ],
  });
}

const SHOW_HN_BADGE = process.env.NEXT_PUBLIC_LAUNCH_HN === "1";

const PILL = "inline-flex items-center gap-2 px-4 py-2 rounded-full border border-border bg-surface-solid text-sm text-foreground-secondary";

export default async function RegulationPage({ params }: PageParams) {
  const { slug } = await params;
  const reg = getRegulationBySlug(slug);
  if (!reg) notFound();

  // Absolute, not relative: this feeds JSON-LD only (no `alternates` here),
  // and schema.org consumers do not resolve against metadataBase.
  const canonical = `${SITE_URL}/regulation/${reg.slug}`;

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
      { "@type": "ListItem", position: 1, name: "GateTest", item: SITE_URL },
      { "@type": "ListItem", position: 2, name: "Regulations", item: `${SITE_URL}/regulation` },
      { "@type": "ListItem", position: 3, name: reg.name, item: canonical },
    ],
  };

  return (
    <main>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareJsonLd) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }} />

      <div className="section-alt relative z-10 -mb-8">
        <nav aria-label="Breadcrumb" className="mx-auto max-w-7xl px-6 pt-6 flex flex-wrap items-center gap-2 text-sm text-muted">
          <Link href="/" className="hover:text-foreground transition-colors">GateTest</Link>
          <span aria-hidden="true">/</span>
          <Link href="/regulation" className="hover:text-foreground transition-colors">Regulations</Link>
          <span aria-hidden="true">/</span>
          <span className="text-foreground-secondary">{reg.name}</span>
        </nav>
      </div>

      <PageHero
        eyebrow={<>Compliance regime · {reg.jurisdiction.split("—")[0].trim()}</>}
        title={
          <>
            <span className="gradient-text">{reg.name}</span> compliance — what GateTest actually catches
          </>
        }
        lede={
          <>
            <span className="block text-base text-muted mb-4">{reg.longName}</span>
            {reg.whyDevsCareThisYear}
          </>
        }
        actions={
          <>
            <Link href="/scan" className="btn-cta px-6 py-3 text-sm">
              Run a scan &rarr;
            </Link>
            <Link href="/modules" className="btn-secondary px-6 py-3 text-sm">
              See the modules
            </Link>
          </>
        }
      />

      <Section narrow>
        {/* The regime in one paragraph */}
        <div className="mb-12 card p-6">
          <h2 className="text-sm uppercase tracking-wider text-muted font-semibold mb-3">The regime</h2>
          <p className="text-foreground-secondary leading-relaxed mb-3">
            <strong className="text-foreground">{reg.longName}</strong> — {reg.jurisdiction}. Effective since {reg.effectiveSince}.
          </p>
          <p className="text-foreground-secondary leading-relaxed mb-3">
            <strong className="text-warning">Maximum penalty:</strong> {reg.fineRange}
          </p>
          <p className="text-sm text-muted">
            Authoritative source:{" "}
            <a href={reg.authoritativeUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:text-accent-hover underline underline-offset-2 break-all">
              {reg.authoritativeUrl}
            </a>
          </p>
        </div>

        {/* Top 3 modules */}
        <div className="mb-12">
          <h2 className="font-display text-2xl font-bold text-foreground mb-2">The 3 modules that do the heaviest lifting for {reg.name}</h2>
          <p className="text-muted mb-6">Linked to each module&apos;s page for the full finding list.</p>
          <div className="grid sm:grid-cols-3 gap-3">
            {reg.topThreeModules.map((mod) => (
              <Link key={mod} href={`/modules/${moduleNameToSlug(mod)}`} className="card block p-5">
                <div className="text-xs uppercase tracking-wider text-accent mb-2">GateTest module</div>
                <div className="text-foreground font-mono font-semibold mb-1 break-words">{mod}</div>
                <div className="text-muted text-sm">View full coverage &rarr;</div>
              </Link>
            ))}
          </div>
        </div>

        {/* Catchable technical findings */}
        <div className="mb-12 rounded-xl border border-accent/20 bg-accent/5 p-6">
          <h2 className="font-display text-2xl font-bold text-foreground mb-2">Technical findings GateTest catches for {reg.name}</h2>
          <p className="text-foreground-secondary mb-6 text-sm">
            Each item ties a specific code-level pattern to a clause or principle of {reg.name}. These are the findings auditors sample.
          </p>
          <ul className="space-y-3">
            {reg.catchableTechnicalFindings.map((finding) => (
              <li key={finding} className="flex gap-3 text-foreground leading-relaxed">
                <span className="text-accent mt-1 select-none" aria-hidden="true">&#10003;</span>
                <span>{finding}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Out of scope */}
        <div className="mb-12 rounded-xl border border-warning/25 bg-warning/5 p-6">
          <h2 className="font-display text-2xl font-bold text-foreground mb-2">Out of scope — what you still need humans for</h2>
          <p className="text-foreground-secondary mb-6 text-sm">
            GateTest is a code scanner. {reg.name} compliance is a programme, not a tool. These items will never be answerable from source code alone.
          </p>
          <ul className="space-y-2">
            {reg.outOfScopeForGateTest.map((item) => (
              <li key={item} className="flex gap-3 text-foreground-secondary leading-relaxed">
                <span className="text-warning mt-1 select-none" aria-hidden="true">&minus;</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Countries chips */}
        {reg.countriesAffected.length > 0 && (
          <div className="mb-12">
            <h2 className="font-display text-2xl font-bold text-foreground mb-2">Where this regime applies</h2>
            <p className="text-muted mb-6 text-sm">Country-specific guides:</p>
            <div className="flex flex-wrap gap-2">
              {reg.countriesAffected.map((country) => (
                <Link key={country} href={`/for/${country}`} className={`${PILL} hover:border-accent/40 hover:text-foreground transition-colors`}>
                  <span className="text-accent" aria-hidden="true">&rarr;</span>
                  <span className="capitalize">{country.replace(/-/g, " ")}</span>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* How GateTest fits */}
        <div className="card p-6">
          <h2 className="font-display text-2xl font-bold text-foreground mb-4">How GateTest fits a compliance programme</h2>
          <p className="text-foreground-secondary leading-relaxed">
            GateTest is a code-quality and security scanner. It belongs in your CI pipeline, not in your auditor&apos;s office. We catch the technical findings auditors look for &mdash; secrets, missing rotation, weak TLS, PII in logs, dangerous dependencies &mdash; so the audit becomes a paperwork exercise instead of an emergency.
          </p>
        </div>
      </Section>

      <Section alt narrow title="Pricing">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            { name: "Quick", price: "$29", blurb: "4 essential modules" },
            { name: "Full", price: "$99", blurb: "All modules — scan only" },
            { name: "Scan + Fix", price: "$199", blurb: "Full scan + AI auto-fix PR" },
            { name: "Forensic", price: "$399", blurb: "Everything + correlation + report" },
          ].map((tier) => (
            <div key={tier.name} className="card p-5">
              <div className="text-xs uppercase tracking-wider text-muted mb-2">{tier.name}</div>
              <div className="font-display text-2xl font-bold text-foreground mb-1">{tier.price}</div>
              <div className="text-foreground-secondary text-sm">{tier.blurb}</div>
            </div>
          ))}
        </div>

        {/* Trust strip */}
        <h2 className="text-sm uppercase tracking-wider text-muted font-semibold mt-12 mb-4">Trust</h2>
        <div className="flex flex-wrap gap-3">
          <span className={PILL}>
            <span className="text-accent" aria-hidden="true">&#9679;</span>
            CLI is MIT-licensed
          </span>
          <span className={PILL}>
            <span className="text-accent" aria-hidden="true">&#9679;</span>
            Available on GitHub Marketplace soon
          </span>
          {SHOW_HN_BADGE && (
            <span className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-warning/30 bg-warning/5 text-sm text-warning">
              <span aria-hidden="true">&#9679;</span>
              As featured on Hacker News &amp; Product Hunt
            </span>
          )}
        </div>
      </Section>

      <Section narrow>
        {/* CTA footer */}
        <div className="mb-12 rounded-2xl border border-accent/20 bg-accent/5 p-8 sm:p-10 text-center">
          <h2 className="font-display text-3xl font-bold text-foreground mb-3">Try a $29 Quick scan on your repo</h2>
          <p className="text-foreground-secondary mb-6 max-w-xl mx-auto">
            See the {reg.name}-relevant findings on your own code in minutes. Free preview. Pay only if you ship the report.
          </p>
          <Link href="/scan" className="btn-cta px-6 py-3 text-sm">
            Start a scan &rarr;
          </Link>
        </div>

        {/* Related regulations */}
        <h2 className="font-display text-2xl font-bold text-foreground mb-6">Other regulations</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {REGULATIONS.filter((r) => r.slug !== reg.slug)
            .slice(0, 5)
            .map((r) => (
              <Link key={r.slug} href={`/regulation/${r.slug}`} className="card block p-4">
                <div className="text-foreground font-semibold mb-1">{r.name}</div>
                <div className="text-foreground-secondary text-sm">{r.longName.slice(0, 80)}{r.longName.length > 80 ? "…" : ""}</div>
              </Link>
            ))}
        </div>
      </Section>
    </main>
  );
}
