import type { Metadata } from "next";
import Link from "next/link";
import { REGULATIONS } from "./catalog";
import { SITE_URL } from "@/app/lib/site-url";
import PageHero from "../components/site/PageHero";
import Section from "../components/site/Section";

export const metadata: Metadata = {
  title: "Compliance regulations — what GateTest catches for GDPR, HIPAA, SOC 2, CCPA, PCI DSS, ISO 27001",
  description:
    "Browse the technical findings GateTest catches under the world's major compliance regimes. One scan covers code-level evidence auditors sample.",
  alternates: { canonical: "/regulation" },
  openGraph: {
    title: "Compliance regulations — what GateTest catches",
    description:
      "Technical findings GateTest catches under GDPR, HIPAA, SOC 2, CCPA, PCI DSS, and ISO 27001.",
    url: "/regulation",
    siteName: "GateTest",
    type: "website",
  },
};

export default function RegulationIndexPage() {
  const collectionJsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Compliance regulations — GateTest coverage",
    url: `${SITE_URL}/regulation`,
    hasPart: REGULATIONS.map((r) => ({
      "@type": "WebPage",
      url: `${SITE_URL}/regulation/${r.slug}`,
      name: `${r.name} — ${r.longName}`,
      description: r.whyDevsCareThisYear,
    })),
  };

  return (
    <main>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(collectionJsonLd) }} />

      <div className="section-alt relative z-10 -mb-8">
        <nav aria-label="Breadcrumb" className="mx-auto max-w-7xl px-6 pt-6 flex flex-wrap items-center gap-2 text-sm text-muted">
          <Link href="/" className="hover:text-foreground transition-colors">GateTest</Link>
          <span aria-hidden="true">/</span>
          <span className="text-foreground-secondary">Regulations</span>
        </nav>
      </div>

      <PageHero
        eyebrow={<>{REGULATIONS.length} compliance regimes</>}
        title={
          <>
            What GateTest catches, by <span className="gradient-text">regulation</span>.
          </>
        }
        lede={
          <>
            Compliance is a programme, not a tool. But every major regime has a list of code-level findings auditors sample &mdash; secrets in source, missing TLS, PII in logs, unrotated credentials, vulnerable dependencies. GateTest catches those before the auditor sees them.
            <span className="block mt-4 text-sm text-muted">
              Every page below ties specific GateTest findings to specific clauses of the regulation. We also publish what GateTest does NOT cover &mdash; physical security, contracts, training &mdash; because compliance honesty matters.
            </span>
          </>
        }
        actions={
          <Link href="/modules" className="btn-secondary px-5 py-2.5 text-sm">
            All modules &rarr;
          </Link>
        }
      />

      <Section>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {REGULATIONS.map((reg) => (
            <Link key={reg.slug} href={`/regulation/${reg.slug}`} className="card block p-5">
              <div className="flex items-center justify-between gap-2 mb-3">
                <div className="font-display text-foreground font-bold text-lg">{reg.name}</div>
                <div className="text-[10px] text-accent uppercase tracking-wider">{reg.effectiveSince}</div>
              </div>
              <div className="text-foreground-secondary text-sm font-medium mb-2">{reg.longName}</div>
              <div className="text-muted text-xs mb-3">{reg.jurisdiction.split("—")[0].trim()}</div>
              <div className="text-foreground-secondary text-sm leading-snug">
                {reg.whyDevsCareThisYear.slice(0, 140)}{reg.whyDevsCareThisYear.length > 140 ? "…" : ""}
              </div>
            </Link>
          ))}
        </div>
      </Section>

      <Section alt>
        <div className="rounded-2xl border border-accent/20 bg-accent/5 p-8 sm:p-10 text-center">
          <h2 className="font-display text-3xl font-bold text-foreground mb-4">
            One scan, every regime&apos;s technical findings.
          </h2>
          <p className="text-foreground-secondary mb-8 max-w-xl mx-auto">
            Per-scan pricing. AI auto-fix PR on Scan + Fix and Forensic tiers.
          </p>
          <Link href="/scan" className="btn-cta px-6 py-3 text-sm">
            Run a scan &rarr;
          </Link>
        </div>
      </Section>
    </main>
  );
}
