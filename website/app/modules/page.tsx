import type { Metadata } from "next";
import Link from "next/link";
import { getModulesByCategory, getTotalModuleCount } from "../components/howitworks/module-slugs";
import { SITE_URL } from "@/app/lib/site-url";
import { Hero, Section, Card } from "../components/v2";
import { NonceScript } from "@/app/lib/seo/NonceScript";

export const metadata: Metadata = {
  title: `${getTotalModuleCount()} GateTest modules — one config, every QA check in 2026`,
  description: `Browse all ${getTotalModuleCount()} modules in the GateTest scan suite — security, IaC, accessibility, performance, AI-app safety, code quality, and more. One config, AI auto-fix PR included.`,
  alternates: { canonical: "/modules" },
  openGraph: {
    title: `${getTotalModuleCount()} GateTest modules — one config replaces 12 tools`,
    description: `Every QA check GateTest runs. Browse by category — security, IaC, accessibility, performance, code quality, more.`,
    url: "/modules",
    siteName: "GateTest",
    type: "website",
  },
};

function prettify(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

export default function ModulesIndexPage() {
  const categories = getModulesByCategory();
  const total = getTotalModuleCount();

  // CollectionPage structured data — surfaces all module pages to search engines
  const collectionJsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: `GateTest modules — ${total} checks in one config`,
    url: `${SITE_URL}/modules`,
    hasPart: categories.flatMap((cat) =>
      cat.modules.map((mod) => ({
        "@type": "WebPage",
        // Never a literal — CLAUDE.md THE DOMAIN. This one survived the
        // .ai -> .io sweep and would publish a dead host in structured data
        // the moment NEXT_PUBLIC_BASE_URL moves again.
        url: `${SITE_URL}/modules/${mod.slug}`,
        name: prettify(mod.name),
        description: mod.description,
      }))
    ),
  };

  return (
    <main>
      <NonceScript type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(collectionJsonLd) }} />

      <Section wrap={false}>
        <div className="v2-wrap">
          <Hero
            kicker={`All ${total} modules`}
            title={<>One scan. {total} modules. Every QA check unified.</>}
            lede={
              <>
                GateTest runs {total} distinct checks against your codebase — security, infrastructure, accessibility, performance, code quality, AI-app safety, and more. Each module is the GateTest equivalent of a separate tool: Snyk, SonarQube, Semgrep, ESLint, hadolint, kube-score, axe, Lighthouse, and 20 more. One config, one bill.
              </>
            }
            actions={
              <>
                <Link href="/#pricing" className="v2-btn v2-btn-primary">See pricing</Link>
                <Link href="/compare/snyk" className="v2-btn">Compare to Snyk</Link>
              </>
            }
          />
        </div>
      </Section>

      <Section>
        <p className="max-w-2xl text-[15px] leading-relaxed text-[var(--v2-muted)] mb-10">
          Click any module to see what it catches, example findings, pricing tiers it&apos;s included on, and how the AI auto-fix loop handles it.
        </p>
        <nav aria-label="Contents" className="flex flex-wrap gap-2 mb-14">
          {categories.map((cat) => (
            <a
              key={cat.id}
              href={`#${cat.id}`}
              className="v2-kicker !text-xs px-3 py-1.5 rounded-full border border-[var(--v2-line-strong)] hover:text-[var(--v2-fg)] hover:border-[var(--v2-fg)] transition-colors"
            >
              {cat.title} <span className="ml-1">{cat.modules.length}</span>
            </a>
          ))}
        </nav>

        <div className="space-y-16">
          {categories.map((cat) => (
            <section key={cat.id} id={cat.id} className="scroll-mt-24">
              <div className="mb-6">
                <div className="flex flex-wrap items-center gap-3 mb-2">
                  <h2 className="v2-h2 !text-2xl sm:!text-3xl">{cat.title}</h2>
                  {cat.comingSoon && (
                    <span className="v2-kicker !text-[10px] uppercase px-2 py-0.5 rounded-full border border-[var(--v2-warn)]/40 text-[var(--v2-warn)]">
                      Coming soon
                    </span>
                  )}
                </div>
                <p className="text-[var(--v2-muted)] leading-relaxed max-w-3xl">{cat.blurb}</p>
                {cat.comingSoon && (
                  <p className="text-xs text-[var(--v2-warn)] mt-2">{cat.comingSoon.reason}</p>
                )}
                <p className="v2-kicker mt-2">{cat.modules.length} module{cat.modules.length === 1 ? "" : "s"} in this category</p>
              </div>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {cat.modules.map((mod) => (
                  <Link key={mod.slug} href={`/modules/${mod.slug}`}>
                    <Card>
                      <div className="flex items-center gap-2 mb-1">
                        <div className="text-[var(--v2-fg)] font-semibold">{prettify(mod.name)}</div>
                        {cat.comingSoon && (
                          <span className="v2-kicker !text-[9px] uppercase px-1.5 py-0.5 rounded-full border border-[var(--v2-warn)]/40 text-[var(--v2-warn)]">
                            Soon
                          </span>
                        )}
                      </div>
                      <div className="text-xs v2-mono text-[var(--v2-accent)] mb-2">{mod.name}</div>
                      <div className="text-[var(--v2-muted)] text-sm leading-snug">{mod.description.slice(0, 130)}{mod.description.length > 130 ? "…" : ""}</div>
                    </Card>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>

        <section className="mt-20 v2-card !border-[var(--v2-accent)] px-6 py-10 sm:p-12 text-center">
          <h2 className="v2-h2 mb-4">
            {total} checks. One scan. From $29.
          </h2>
          <p className="text-[var(--v2-muted)] mb-8 max-w-xl mx-auto">
            Per-scan pricing, not per seat — one-time scans never auto-renew. AI auto-fix PR on the Scan + Fix and Forensic Scan tiers.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link href="/#pricing" className="v2-btn v2-btn-primary">See pricing</Link>
            <Link href="/compare/snyk" className="v2-btn">Compare to Snyk</Link>
          </div>
        </section>
      </Section>
    </main>
  );
}
