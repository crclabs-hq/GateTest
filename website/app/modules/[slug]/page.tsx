import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getAllModuleSlugs,
  getModuleBySlug,
  getRelatedModules,
  getTotalModuleCount,
  type ResolvedModule,
} from "../../components/howitworks/module-slugs";
import PageHero from "../../components/site/PageHero";
import { availabilityFor } from "./availability";

interface PageParams {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams(): Promise<{ slug: string }[]> {
  return getAllModuleSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { slug } = await params;
  const mod = getModuleBySlug(slug);
  if (!mod) {
    return { title: "Module not found — GateTest" };
  }
  const title = `${prettify(mod.name)} — GateTest module that catches it before you ship`;
  const description = `${mod.description} Runs as part of the GateTest scan suite — one config, ${getTotalModuleCount()} modules, AI auto-fix PR included.`;
  const canonical = `/modules/${mod.slug}`;
  return {
    title,
    description,
    keywords: buildKeywords(mod),
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

function prettify(name: string): string {
  // Convert camelCase to spaced Title Case for headings
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

function buildKeywords(mod: { name: string }): string[] {
  const pretty = prettify(mod.name).toLowerCase();
  return [
    `${pretty} detection`,
    `${pretty} scanner`,
    `${pretty} bug`,
    `how to detect ${pretty}`,
    `how to fix ${pretty}`,
    `${pretty} static analysis`,
    `gatetest ${mod.name}`,
  ];
}

const COMPARISONS = ["snyk", "sonarqube", "semgrep", "codeql", "deepsource", "eslint", "github-code-scanning"];

export default async function ModulePage({ params }: PageParams) {
  const { slug } = await params;
  const mod: ResolvedModule | null = getModuleBySlug(slug);
  if (!mod) notFound();

  const related = getRelatedModules(slug, 6);
  const pretty = prettify(mod.name);
  const totalModules = getTotalModuleCount();
  const comingSoon = mod.category.comingSoon;
  // Which tiers really run this module — from the engine's suite table and
  // the Stripe tier table, so the page cannot promise a tier that skips it.
  const avail = availabilityFor(mod.name, pretty, totalModules);
  const repoFix = avail.kind !== "live" && avail.kind !== "action";

  // FAQPage structured data — 4 questions per module
  const faqs = comingSoon
    ? [
        {
          q: `What does the ${pretty} module catch?`,
          a: `${mod.description} Example finding: ${mod.example}`,
        },
        {
          q: `Can I buy a scan that includes ${pretty} today?`,
          a: `Not yet — ${comingSoon.reason} It's registered in the engine and documented here so it's discoverable, but it isn't included in any purchasable tier yet.`,
        },
        {
          q: `Which tiers include the ${pretty} module?`,
          a: `None yet — this module is Coming Soon. ${comingSoon.reason}`,
        },
      ]
    : [
        {
          q: `What does the ${pretty} module catch?`,
          a: `${mod.description} Example finding: ${mod.example}`,
        },
        {
          q: `Does GateTest fix ${pretty} issues automatically?`,
          a: repoFix
            ? `Yes — on the Scan + Fix tier ($199) and Forensic Scan tier ($399), Claude reads the finding, writes the fix, validates against the scanner, writes a regression test, and opens a pull request for your review.`
            : avail.kind === "live"
              ? `Live-URL findings ship with plain-English fix instructions and, where the platform allows it, a generated config file. Auto-fix pull requests are written for repository findings on the Scan + Fix ($199) and Forensic ($399) tiers.`
              : `On the GitHub Action, with your own Anthropic key, \`--auto-pr\` opens the fix PR from the same fix engine. The hosted Scan + Fix ($199) and Forensic ($399) tiers auto-fix the repository findings they run.`,
        },
        {
          q: `Which tiers include the ${pretty} module?`,
          a: avail.tiers,
        },
        {
          q: `Can I run the ${pretty} module from the CLI for free?`,
          a: `Yes — install with \`npm i -g @gatetest/cli\` and run \`${avail.cli}\`. The local CLI is free; paid tiers add AI auto-fix and the cross-finding correlation work.`,
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

  // SoftwareApplication structured data — omit the Offer entirely when
  // nothing purchasable runs the module (Coming Soon, or CLI/Action-only);
  // a schema.org Offer implies it's for sale today, which would be false.
  const softwareJsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: `GateTest — ${pretty}`,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Cross-platform (Node.js 20+)",
    ...(comingSoon || !avail.offer
      ? {}
      : {
          offers: {
            "@type": "Offer",
            price: avail.offer.price,
            priceCurrency: "USD",
            description: avail.offer.description,
          },
        }),
    aggregateRating: undefined, // not faked
  };

  const h2 = "font-display text-2xl sm:text-3xl font-bold tracking-tight text-foreground";

  return (
    <main>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareJsonLd) }} />

      <PageHero
        eyebrow={
          <>
            <Link href="/modules" className="hover:text-foreground transition-colors">Modules</Link>
            <span aria-hidden="true">/</span>
            <Link href={`/modules#${mod.category.id}`} className="hover:text-foreground transition-colors">{mod.category.title}</Link>
            {comingSoon && <span className="text-warning">· Coming soon</span>}
          </>
        }
        title={pretty}
        lede={mod.description}
        actions={
          comingSoon ? (
            <p className="text-sm text-muted leading-relaxed">Not yet included in any purchasable tier. {comingSoon.reason}</p>
          ) : (
            <p className="text-sm text-muted leading-relaxed">
              One of {totalModules} modules in the GateTest scan suite. Catches the issue before it reaches code review, and on paid tiers opens a pull request with the fix already written.
            </p>
          )
        }
      >
        {/* Example finding — what CI sees, so it stays a dark panel */}
        <div className="rounded-2xl bg-panel border border-panel-border overflow-hidden">
          <div className="border-b border-panel-border px-4 py-2.5 flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-danger/80" aria-hidden="true" />
            <span className="w-3 h-3 rounded-full bg-warning/80" aria-hidden="true" />
            <span className="w-3 h-3 rounded-full bg-success/80" aria-hidden="true" />
            <span className="ml-2 text-xs text-panel-muted font-mono">gatetest --module {mod.name}</span>
          </div>
          <pre className="p-5 text-sm font-mono text-panel-foreground whitespace-pre-wrap leading-relaxed">{mod.example}</pre>
        </div>
      </PageHero>

      <div className="mx-auto max-w-4xl px-6 py-16 sm:py-20">
        {/* Category context */}
        <section className="mb-12">
          <h2 className={`${h2} mb-4`}>Why we catch it</h2>
          <p className="text-foreground-secondary leading-relaxed mb-3">{mod.category.blurb}</p>
          <p className="text-foreground-secondary leading-relaxed">
            The <span className="text-accent font-medium">{pretty}</span> module sits in this category alongside {related.length} related modules. Together they form one of the layers of a GateTest scan — checks fire in parallel, findings cluster by root cause, and on paid tiers the AI auto-fix loop reads each finding, writes the fix, validates against the scanner, and opens a PR.
          </p>
        </section>

        {/* How GateTest covers this */}
        <section className="mb-12">
          <h2 className={`${h2} mb-4`}>How GateTest covers {pretty.toLowerCase()}</h2>
          {comingSoon ? (
            <ul className="space-y-3 text-foreground-secondary leading-relaxed">
              <li className="flex items-start gap-2">
                <span className="text-warning mt-1" aria-hidden="true">&#9679;</span>
                <span><strong className="text-foreground">Not yet purchasable.</strong> {comingSoon.reason} It&apos;s registered in the engine today so it&apos;s discoverable, but no tier includes it yet.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-warning mt-1" aria-hidden="true">&#9679;</span>
                <span><strong className="text-foreground">Requires explicit authorization when it ships.</strong> Live probes only ever run against a target you&apos;ve proven you own — a three-layer consent check gates every run.</span>
              </li>
            </ul>
          ) : (
            <ul className="space-y-3 text-foreground-secondary leading-relaxed">
              <li className="flex items-start gap-2">
                <span className="text-accent mt-1" aria-hidden="true">&#10003;</span>
                <span><strong className="text-foreground">{avail.lead}</strong> {avail.tiers} No additional configuration.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-accent mt-1" aria-hidden="true">&#10003;</span>
                <span><strong className="text-foreground">Free CLI.</strong> <code className="text-foreground text-sm bg-surface-light border border-border px-1.5 py-0.5 rounded">npm i -g @gatetest/cli && {avail.cli}</code>{avail.kind === "live" ? " against a site you own." : " against any local repo."} No paywall on the scanning itself.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-accent mt-1" aria-hidden="true">&#10003;</span>
                <span><strong className="text-foreground">AI auto-fix PR.</strong> {repoFix
                  ? "Scan + Fix tier opens a pull request with the fix, a regression test, and a pair-review by a second Claude. Forensic Scan tier adds per-finding diagnosis and cross-finding attack-chain correlation."
                  : avail.kind === "live"
                    ? "Live-URL findings come with plain-English fix instructions. Auto-fix pull requests are for repository findings on the Scan + Fix and Forensic tiers."
                    : "On the GitHub Action, with your own Anthropic key, --auto-pr opens the fix PR from the same fix engine that powers Scan + Fix and Forensic."}</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-accent mt-1" aria-hidden="true">&#10003;</span>
                <span><strong className="text-foreground">Honest confidence rating.</strong> Findings come with high / medium / low confidence so noisy patterns don&apos;t block the gate. The confidence-calibrator trainer reads customer suppressions and tightens rules over time.</span>
              </li>
            </ul>
          )}
        </section>

        {/* CTA */}
        {comingSoon ? (
          <section className="mb-12 rounded-2xl border border-amber-400/30 bg-amber-500/5 px-6 py-8 text-center">
            <h2 className={`${h2} mb-3`}>{pretty} is coming soon</h2>
            <p className="text-foreground-secondary mb-6">{comingSoon.reason} Want early access when it ships?</p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <a
                href={`mailto:support@gatetest.io?subject=${encodeURIComponent(`Early access: ${pretty}`)}`}
                className="btn-cta inline-flex items-center justify-center px-6 py-3 text-sm"
              >
                Request early access
              </a>
              <Link href="/modules" className="btn-secondary inline-flex items-center justify-center px-6 py-3 text-sm">
                See all {totalModules} modules
              </Link>
            </div>
          </section>
        ) : (
          <section className="mb-12 rounded-2xl border border-accent/20 bg-accent/5 px-6 py-8 text-center">
            <h2 className={`${h2} mb-3`}>Scan your repo for {pretty.toLowerCase()}</h2>
            <p className="text-foreground-secondary mb-6">Free preview of the headline findings. Pay per scan, not per seat — one-time scans never auto-renew.</p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Link href="/#pricing" className="btn-cta inline-flex items-center justify-center px-6 py-3 text-sm">
                Run a scan &mdash; from $29
              </Link>
              <Link href="/modules" className="btn-secondary inline-flex items-center justify-center px-6 py-3 text-sm">
                See all {totalModules} modules
              </Link>
            </div>
          </section>
        )}

        {/* FAQ */}
        <section className="mb-12">
          <h2 className={`${h2} mb-6`}>Frequently asked questions</h2>
          <div className="space-y-4">
            {faqs.map((f) => (
              <div key={f.q} className="card p-5">
                <h3 className="text-foreground font-semibold mb-2 leading-snug">{f.q}</h3>
                <p className="text-foreground-secondary text-sm leading-relaxed">{f.a}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Related modules — internal linking */}
        {related.length > 0 && (
          <section className="mb-12">
            <h2 className={`${h2} mb-6`}>Related modules in {mod.category.title}</h2>
            <div className="grid sm:grid-cols-2 gap-3">
              {related.map((r) => (
                <Link key={r.slug} href={`/modules/${r.slug}`} className="card block p-4">
                  <div className="text-foreground font-semibold mb-1">{prettify(r.name)}</div>
                  <div className="text-foreground-secondary text-sm leading-snug">{r.description.slice(0, 120)}{r.description.length > 120 ? "…" : ""}</div>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Cross-links to comparisons */}
        <section className="rounded-2xl border border-border bg-surface-light p-6">
          <h2 className="text-sm uppercase tracking-wider text-muted font-semibold mb-3">Comparing GateTest to another tool?</h2>
          <div className="flex flex-wrap gap-2">
            {COMPARISONS.map((c) => (
              <Link
                key={c}
                href={`/compare/${c}`}
                className="px-3 py-1.5 rounded-full bg-background border border-border text-sm text-foreground-secondary hover:text-foreground hover:border-border-strong transition-colors"
              >
                vs. {c.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
              </Link>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
