import type { Metadata } from "next";
import Link from "next/link";
import { CWE_TOP_25 } from "./cwe-catalog";
import { SITE_URL } from "@/app/lib/site-url";
import PageHero from "../components/site/PageHero";
import Section from "../components/site/Section";
import siteStats from "../data/site-stats.json";

export const metadata: Metadata = {
  title: "CWE Top 25 — what GateTest catches and how to fix it",
  description: "Browse the 2023 MITRE CWE Top 25 most dangerous software weaknesses. See which GateTest modules catch each class, with examples and fix recommendations.",
  alternates: { canonical: "/find" },
  openGraph: {
    title: "CWE Top 25 — what GateTest catches and how to fix it",
    description: "Browse all 25 most dangerous software weaknesses. See which GateTest modules catch each class.",
    url: "/find",
    siteName: "GateTest",
    type: "website",
  },
};

export default function CweIndexPage() {
  const collectionJsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "CWE Top 25 — GateTest coverage",
    url: `${SITE_URL}/find`,
    hasPart: CWE_TOP_25.map((cwe) => ({
      "@type": "WebPage",
      url: `${SITE_URL}/find/${cwe.slug}`,
      name: `CWE-${cwe.id} ${cwe.name}`,
      description: cwe.shortDesc,
    })),
  };

  const coveredCount = CWE_TOP_25.filter((c) => c.modules.length > 0).length;

  return (
    <main>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(collectionJsonLd) }} />

      <div className="section-alt relative z-10 -mb-8">
        <nav aria-label="Breadcrumb" className="mx-auto max-w-7xl px-6 pt-6 flex flex-wrap items-center gap-2 text-sm text-muted">
          <Link href="/" className="hover:text-foreground transition-colors">GateTest</Link>
          <span aria-hidden="true">/</span>
          <span className="text-foreground-secondary">Find (CWE)</span>
        </nav>
      </div>

      <PageHero
        eyebrow="MITRE 2023 CWE Top 25"
        title={<>The 25 most dangerous bug classes. {coveredCount} of them caught by GateTest.</>}
        lede={
          <>
            MITRE&apos;s annual CWE Top 25 ranks the most dangerous software weaknesses by prevalence and severity. We show which classes GateTest catches today, which we don&apos;t, and the fix shape for each.
            <span className="block mt-4 text-sm text-muted">
              Honest scoring — we cover the injection, secrets, SSRF, race-condition and infrastructure-as-code classes. The C/C++ memory-safety classes (out-of-bounds writes, use-after-free, NULL deref) we don&apos;t scan today, and a few logic-level classes (missing or incorrect authorisation, unrestricted upload) have no dedicated rule yet. Each page says so.
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
          {CWE_TOP_25.map((cwe) => {
            const covered = cwe.modules.length > 0;
            return (
              <Link key={cwe.slug} href={`/find/${cwe.slug}`} className="card block p-5">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="text-xs font-mono text-accent">CWE-{cwe.id}</div>
                  <div className={`text-xs font-semibold px-2 py-0.5 rounded-full ${covered ? "bg-accent/10 text-accent" : "bg-warning/10 text-warning"}`}>
                    {covered ? "Caught" : "Not covered"}
                  </div>
                </div>
                <div className="font-display text-foreground font-semibold mb-1">{cwe.name}</div>
                <div className="text-foreground-secondary text-sm leading-snug">{cwe.shortDesc.slice(0, 120)}{cwe.shortDesc.length > 120 ? "…" : ""}</div>
                <div className="text-[10px] text-muted mt-2 uppercase tracking-wider">#{cwe.rank} in Top 25</div>
              </Link>
            );
          })}
        </div>
      </Section>

      <Section alt>
        <div className="rounded-2xl border border-accent/20 bg-accent/5 p-8 sm:p-10 text-center">
          <h2 className="font-display text-3xl font-bold text-foreground mb-4">
            Scan for {coveredCount} CWE classes in one run.
          </h2>
          <p className="text-foreground-secondary mb-8 max-w-xl mx-auto">
            {siteStats.modules.total} modules. Per-scan pricing. AI auto-fix PR on Scan + Fix and Forensic Scan tiers.
          </p>
          <Link href="/#pricing" className="btn-cta px-6 py-3 text-sm">
            See pricing &rarr;
          </Link>
        </div>
      </Section>
    </main>
  );
}
