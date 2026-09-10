import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SITE_URL } from "@/app/lib/site-url";
import {
  COUNTRIES,
  getAllCountrySlugs,
  getCountryBySlug,
  type Country,
} from "../countries";
import PageHero from "../../components/site/PageHero";
import Section from "../../components/site/Section";

interface PageParams {
  params: Promise<{ country: string }>;
}

// Total live module count — keep in sync with CLAUDE.md VERSION section.
// tests/marketing-country-pages.test.js asserts this equals the measured
// `gatetest --list` count, so it cannot quietly go stale.
const MODULE_COUNT = 121;

export async function generateStaticParams(): Promise<{ country: string }[]> {
  return getAllCountrySlugs().map((country) => ({ country }));
}

export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { country } = await params;
  const data = getCountryBySlug(country);
  if (!data) {
    return { title: "Country not found — GateTest" };
  }
  const stackHint = data.popularStack.slice(0, 2).join("/");
  const title = `GateTest for ${data.name} — ${data.primaryRegulation} compliance, ${stackHint} stack`;
  const description = truncate(
    `${MODULE_COUNT} GateTest modules built for ${data.name} dev shops — catches the technical findings ${data.primaryRegulation} auditors look for across ${data.popularStack.slice(0, 3).join(", ")}.`,
    160,
  );
  const canonical = `/for/${data.slug}`;
  return {
    title,
    description,
    keywords: [
      `${data.name.toLowerCase()} code scanner`,
      `${data.primaryRegulation.toLowerCase()} scanner`,
      `${data.name.toLowerCase()} security scanning`,
      `${data.name.toLowerCase()} ci/cd gate`,
      ...data.popularStack.map((s) => `${s.toLowerCase()} scanner`),
    ],
    alternates: { canonical },
    openGraph: {
      title,
      description,
      url: canonical,
      siteName: "GateTest",
      locale: data.ogLocale,
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
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

// Hand-curated one-line descriptions for the topThreeModules cards.
// Keeps the page server-renderable without re-importing the full modules
// catalog. Source: website/app/components/howitworks/modules-data.ts.
const MODULE_BLURBS: Record<string, string> = {
  secrets:
    "AWS keys, GitHub tokens, Stripe keys, passwords, private keys, DB strings — caught before commit.",
  secretRotation:
    "Long-lived credentials in git history, .env drift, placeholder values that match real shapes.",
  logPii:
    "Credentials, tokens, request bodies and sensitive identifiers logged in plaintext.",
  dependencies:
    "Supply-chain hygiene across npm, pip, Pipenv, Poetry, go.mod, Cargo, Bundler, Composer, Maven, Gradle.",
  webHeaders:
    "CSP / HSTS / XFO / CORS misconfig across Next.js, Vercel, Netlify, Express, Fastify, nginx.",
  tlsSecurity:
    "rejectUnauthorized: false, verify=False, NODE_TLS_REJECT_UNAUTHORIZED=0 and other MITM-shipping shapes.",
  cookieSecurity:
    "httpOnly: false, weak session secrets, SESSION_COOKIE_* misconfigurations.",
  envVars:
    "Cross-references .env.example with process.env reads. Flags NEXT_PUBLIC_* / VITE_* client-bundled keys.",
  ssrf:
    "Taints req.* sources to fetch/axios/http.request sinks and flags hardcoded cloud-metadata endpoints.",
  prSize:
    "Per-PR file + line cap. Produces timestamped change-management evidence on every commit status.",
  errorSwallow:
    "Empty catch blocks, .catch(() => {}) on Promise chains, Node-callback handlers that ignore err.",
  kubernetes:
    "Privileged containers, hostNetwork, runAsUser: 0, docker.sock mounts, dangerous capabilities.",
  ciSecurity:
    "Unpinned GitHub Actions, pwn-request shapes, shell injection via ${{ github.event.* }}, missing permissions.",
};

function getModuleBlurb(name: string): string {
  return (
    MODULE_BLURBS[name] ??
    `${name} module — runs as part of the GateTest scan suite.`
  );
}

const TAG_COLORS: Record<string, string> = {
  Security: "text-danger bg-danger/10 border-danger/20",
  Quality: "text-accent bg-accent/10 border-accent/20",
  Reliability: "text-warning bg-warning/10 border-warning/20",
};

const PILL = "px-3 py-1.5 rounded-full text-xs font-mono border";

export default async function CountryPage({ params }: PageParams) {
  const { country } = await params;
  const data = getCountryBySlug(country);
  if (!data) notFound();

  const softwareJsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: `GateTest for ${data.name}`,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Cross-platform",
    description: `${MODULE_COUNT} GateTest modules tuned for ${data.name} compliance with ${data.primaryRegulation}.`,
    offers: {
      "@type": "Offer",
      price: "29",
      priceCurrency: "USD",
      url: `${SITE_URL}/scan`,
    },
    publisher: {
      "@type": "Organization",
      name: "GateTest",
      url: SITE_URL,
    },
  };

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "GateTest", item: SITE_URL },
      { "@type": "ListItem", position: 2, name: "For", item: `${SITE_URL}/for` },
      { "@type": "ListItem", position: 3, name: "Countries", item: `${SITE_URL}/for` },
      {
        "@type": "ListItem",
        position: 4,
        name: data.name,
        item: `${SITE_URL}/for/${data.slug}`,
      },
    ],
  };

  const showLaunchBadges = process.env.NEXT_PUBLIC_LAUNCH_HN === "1";

  return (
    <main>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />

      <div className="section-alt relative z-10 -mb-8">
        <nav aria-label="Breadcrumb" className="mx-auto max-w-7xl px-6 pt-6 flex flex-wrap items-center gap-2 text-sm text-muted">
          <Link href="/" className="hover:text-foreground transition-colors">GateTest</Link>
          <span aria-hidden="true">/</span>
          <Link href="/for" className="hover:text-foreground transition-colors">For</Link>
          <span aria-hidden="true">/</span>
          <Link href="/for" className="hover:text-foreground transition-colors">Countries</Link>
          <span aria-hidden="true">/</span>
          <span className="text-foreground-secondary">{data.name}</span>
        </nav>
      </div>

      <PageHero
        eyebrow={
          <>
            <span className="font-mono">{data.flag}</span>
            <span>Country-specific compliance</span>
          </>
        }
        title={
          <>
            GateTest for <span className="gradient-text">{data.name}</span>
          </>
        }
        lede={data.whyGateTestFits}
        actions={
          <>
            <Link href="/scan" className="btn-cta px-6 py-3 text-sm">
              Run a scan — from $29
            </Link>
            <Link href="/modules" className="btn-secondary px-6 py-3 text-sm">
              See compliance modules
            </Link>
          </>
        }
      />

      {/* Stack */}
      <Section
        title={<>What devs in {data.name} build with</>}
        lede={<>Stack and host shapes we see across the {data.name} dev market — GateTest is tuned for all of them.</>}
      >
        <div className="space-y-6">
          <div>
            <div className="text-xs uppercase tracking-wider text-muted mb-3">Popular stack</div>
            <div className="flex flex-wrap gap-2">
              {data.popularStack.map((s) => (
                <span key={s} className={`${PILL} text-accent border-accent/20 bg-accent/5`}>
                  {s}
                </span>
              ))}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-muted mb-3">Popular hosts</div>
            <div className="flex flex-wrap gap-2">
              {data.popularHosts.map((h) => (
                <span key={h} className={`${PILL} text-foreground-secondary border-border bg-surface-solid`}>
                  {h}
                </span>
              ))}
            </div>
          </div>
        </div>
      </Section>

      {/* Top 3 modules */}
      <Section
        alt
        title={<>The 3 modules most relevant in {data.name}</>}
        lede={<>Every {data.name} scan runs all {MODULE_COUNT} modules — these three are the highest-signal for {data.primaryRegulation}.</>}
      >
        <div className="grid sm:grid-cols-3 gap-4">
          {data.topThreeModules.map((mod) => (
            <Link key={mod} href={`/modules/${moduleToSlug(mod)}`} className="card block p-5">
              <div className="flex items-start justify-between gap-2 mb-3">
                <code className="text-accent text-xs font-mono">{mod}</code>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full border shrink-0 ${TAG_COLORS.Security}`}>
                  Security
                </span>
              </div>
              <p className="text-foreground-secondary text-xs leading-relaxed">
                {getModuleBlurb(mod)}
              </p>
            </Link>
          ))}
        </div>
      </Section>

      {/* Compliance lens */}
      <Section
        title={<>{data.primaryRegulation} — what GateTest catches</>}
        lede={
          <>
            Each bullet ties a real GateTest module to a specific clause in the {data.name} compliance landscape.{" "}
            {data.regulationInternalSlug ? (
              <Link href={`/regulation/${data.regulationInternalSlug}`} className="text-accent hover:text-accent-hover">
                Deep-dive on the regulation &rarr;
              </Link>
            ) : (
              <a href={data.regulationLink} rel="noopener noreferrer nofollow" target="_blank" className="text-accent hover:text-accent-hover">
                Official source &rarr;
              </a>
            )}
          </>
        }
      >
        <div className="space-y-3">
          {data.complianceBullets.map((b) => (
            <div key={b.clause} className="card p-5">
              <div className="flex flex-col sm:flex-row items-start gap-3">
                <code className="text-accent text-xs font-mono shrink-0 mt-0.5">
                  {b.module}
                </code>
                <div>
                  <div className="text-foreground font-semibold text-sm mb-2 leading-snug">
                    {b.clause}
                  </div>
                  <p className="text-foreground-secondary text-xs leading-relaxed">{b.explanation}</p>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Honest limitations */}
        <div className="mt-12 rounded-xl border border-warning/25 bg-warning/5 p-6">
          <h3 className="text-sm uppercase tracking-wider text-warning font-semibold mb-3">
            Honest limitations
          </h3>
          <p className="text-foreground-secondary leading-relaxed text-sm mb-3">
            GateTest is a code-quality + security scanner — not a SOC 2 / HIPAA / ISO auditor. We catch the technical findings auditors look for, but the audit itself needs a qualified human assessor.
          </p>
          <ul className="space-y-2 text-foreground-secondary text-sm leading-relaxed">
            {data.countryCaveats.map((c) => (
              <li key={c} className="flex gap-2">
                <span className="text-warning shrink-0" aria-hidden="true">&middot;</span>
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      {/* Use cases */}
      <Section alt title={<>Who hires GateTest in {data.name}</>}>
        <div className="space-y-3">
          {data.useCases.map((uc) => (
            <div key={uc} className="card p-4 flex items-start gap-3">
              <span className="text-accent shrink-0 mt-0.5" aria-hidden="true">&rarr;</span>
              <span className="text-foreground-secondary text-sm leading-relaxed">{uc}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* Pricing strip */}
      <Section title="Pricing" lede="Starting at $29 USD — paid via Stripe in your local currency.">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            { tier: "Quick", price: "$29", modules: "4 modules" },
            { tier: "Full", price: "$99", modules: `All ${MODULE_COUNT} modules` },
            { tier: "Scan + Fix", price: "$199", modules: "+ AI auto-fix PR" },
            { tier: "Forensic", price: "$399", modules: "+ pair review + exec summary" },
          ].map((p) => (
            <div key={p.tier} className="card p-5">
              <div className="text-xs uppercase tracking-wider text-muted mb-2">{p.tier}</div>
              <div className="font-display text-2xl font-bold text-foreground mb-1">{p.price}</div>
              <div className="text-xs text-foreground-secondary">{p.modules}</div>
            </div>
          ))}
        </div>

        {/* Trust strip */}
        <div className="mt-12 flex flex-wrap items-center justify-center gap-3 sm:gap-6 text-xs text-muted">
          <span className="px-3 py-1.5 rounded-full border border-border">
            CLI is MIT-licensed
          </span>
          <span className="px-3 py-1.5 rounded-full border border-border">
            Available on GitHub Marketplace soon
          </span>
          {showLaunchBadges && (
            <span className="px-3 py-1.5 rounded-full border border-warning/30 text-warning">
              As featured on Hacker News &amp; Product Hunt
            </span>
          )}
        </div>

        {/* CTA footer */}
        <div className="mt-12 rounded-2xl border border-accent/20 bg-accent/5 p-8 sm:p-10 text-center">
          <h2 className="font-display text-3xl font-bold text-foreground mb-4">
            Try it on your own repo
          </h2>
          <p className="text-foreground-secondary mb-8 max-w-xl mx-auto">
            $29 Quick scan, no signup. One-time charge, no subscription.
          </p>
          <Link href="/scan" className="btn-cta px-8 py-4">
            Run a {data.name} scan — $29
          </Link>
        </div>

        <p className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-muted">
          <span>Also for:</span>
          {COUNTRIES.filter((c) => c.slug !== data.slug)
            .slice(0, 4)
            .map((c: Country) => (
              <Link key={c.slug} href={`/for/${c.slug}`} className="hover:text-accent transition-colors">
                {c.name}
              </Link>
            ))}
        </p>
      </Section>
    </main>
  );
}
