import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  COUNTRIES,
  getAllCountrySlugs,
  getCountryBySlug,
  type Country,
} from "../countries";

interface PageParams {
  params: Promise<{ country: string }>;
}

// Total live module count — keep in sync with CLAUDE.md VERSION section.
const MODULE_COUNT = 120;

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
  const canonical = `https://gatetest.ai/for/${data.slug}`;
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
  Security: "text-red-400 bg-red-500/10 border-red-500/20",
  Quality: "text-teal-400 bg-teal-500/10 border-teal-500/20",
  Reliability: "text-amber-400 bg-amber-500/10 border-amber-500/20",
};

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
      url: "https://gatetest.ai/scan",
    },
    publisher: {
      "@type": "Organization",
      name: "GateTest",
      url: "https://gatetest.ai",
    },
  };

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "GateTest", item: "https://gatetest.ai" },
      { "@type": "ListItem", position: 2, name: "For", item: "https://gatetest.ai/for" },
      { "@type": "ListItem", position: 3, name: "Countries", item: "https://gatetest.ai/for" },
      {
        "@type": "ListItem",
        position: 4,
        name: data.name,
        item: `https://gatetest.ai/for/${data.slug}`,
      },
    ],
  };

  const showLaunchBadges = process.env.NEXT_PUBLIC_LAUNCH_HN === "1";

  return (
    <div className="min-h-screen" style={{ background: "#0a0a12" }}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />

      {/* Nav */}
      <nav className="border-b border-white/[0.06] px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-teal-600 flex items-center justify-center">
              <span className="text-white font-bold text-sm font-mono">G</span>
            </div>
            <span className="text-xl font-bold tracking-tight text-white">
              Gate<span className="text-teal-400">Test</span>
            </span>
          </Link>
          <Link href="/for" className="text-sm text-white/50 hover:text-white transition-colors">
            All countries &rarr;
          </Link>
        </div>
      </nav>

      <main className="px-6 py-16 max-w-5xl mx-auto">
        {/* Breadcrumb */}
        <nav className="flex items-center gap-2 text-sm text-white/40 mb-10">
          <Link href="/" className="hover:text-white/70 transition-colors">GateTest</Link>
          <span>/</span>
          <Link href="/for" className="hover:text-white/70 transition-colors">For</Link>
          <span>/</span>
          <Link href="/for" className="hover:text-white/70 transition-colors">Countries</Link>
          <span>/</span>
          <span className="text-white/60">{data.name}</span>
        </nav>

        {/* Hero */}
        <section className="mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-teal-500/10 border border-teal-500/20 text-xs text-teal-400 font-medium mb-6">
            <span className="font-mono">{data.flag}</span>
            <span>Country-specific compliance</span>
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold text-white leading-tight mb-6">
            GateTest for <span className="gradient-text">{data.name}</span>
          </h1>
          <p className="text-lg text-white/60 max-w-2xl leading-relaxed">
            {data.whyGateTestFits}
          </p>
          <div className="flex flex-col sm:flex-row gap-4 mt-8">
            <Link
              href="/scan"
              className="btn-primary inline-flex items-center justify-center px-6 py-3 rounded-xl font-semibold text-sm"
              style={{ background: "#2dd4bf", color: "#0a0a12" }}
            >
              Run a scan — from $29
            </Link>
            <Link
              href="/modules"
              className="btn-secondary inline-flex items-center justify-center px-6 py-3 rounded-xl font-semibold text-sm border border-white/15 text-white/70 hover:border-white/30 hover:text-white transition-colors"
            >
              See compliance modules
            </Link>
          </div>
        </section>

        {/* Stack */}
        <section className="mb-16">
          <h2 className="text-2xl font-bold text-white mb-3">
            What devs in {data.name} build with
          </h2>
          <p className="text-white/50 text-sm mb-8">
            Stack and host shapes we see across the {data.name} dev market — GateTest is tuned for all of them.
          </p>
          <div className="space-y-6">
            <div>
              <div className="text-xs uppercase tracking-wider text-white/40 mb-3">Popular stack</div>
              <div className="flex flex-wrap gap-2">
                {data.popularStack.map((s) => (
                  <span
                    key={s}
                    className="px-3 py-1.5 rounded-full text-xs font-mono text-teal-300 border border-teal-500/20"
                    style={{ background: "rgba(20,184,166,0.05)" }}
                  >
                    {s}
                  </span>
                ))}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-white/40 mb-3">Popular hosts</div>
              <div className="flex flex-wrap gap-2">
                {data.popularHosts.map((h) => (
                  <span
                    key={h}
                    className="px-3 py-1.5 rounded-full text-xs font-mono text-white/70 border border-white/15"
                    style={{ background: "rgba(255,255,255,0.03)" }}
                  >
                    {h}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Top 3 modules */}
        <section className="mb-16">
          <h2 className="text-2xl font-bold text-white mb-3">
            The 3 modules most relevant in {data.name}
          </h2>
          <p className="text-white/50 text-sm mb-8">
            Every {data.name} scan runs all {MODULE_COUNT} modules — these three are the highest-signal for {data.primaryRegulation}.
          </p>
          <div className="grid sm:grid-cols-3 gap-4">
            {data.topThreeModules.map((mod) => (
              <Link
                key={mod}
                href={`/modules/${moduleToSlug(mod)}`}
                className="rounded-xl p-5 border border-white/[0.08] hover:border-teal-500/30 transition-colors"
                style={{ background: "rgba(255,255,255,0.03)" }}
              >
                <div className="flex items-start justify-between gap-2 mb-3">
                  <code className="text-teal-400 text-xs font-mono">{mod}</code>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full border shrink-0 ${TAG_COLORS.Security}`}>
                    Security
                  </span>
                </div>
                <p className="text-white/55 text-xs leading-relaxed">
                  {getModuleBlurb(mod)}
                </p>
              </Link>
            ))}
          </div>
        </section>

        {/* Compliance lens */}
        <section className="mb-16">
          <h2 className="text-2xl font-bold text-white mb-3">
            {data.primaryRegulation} — what GateTest catches
          </h2>
          <p className="text-white/50 text-sm mb-8">
            Each bullet ties a real GateTest module to a specific clause in the {data.name} compliance landscape.{" "}
            {data.regulationInternalSlug ? (
              <Link
                href={`/regulation/${data.regulationInternalSlug}`}
                className="text-teal-400 hover:text-teal-300"
              >
                Deep-dive on the regulation &rarr;
              </Link>
            ) : (
              <a
                href={data.regulationLink}
                rel="noopener noreferrer nofollow"
                target="_blank"
                className="text-teal-400 hover:text-teal-300"
              >
                Official source &rarr;
              </a>
            )}
          </p>
          <div className="space-y-3">
            {data.complianceBullets.map((b) => (
              <div
                key={b.clause}
                className="rounded-xl border border-white/[0.08] p-5"
                style={{ background: "rgba(255,255,255,0.03)" }}
              >
                <div className="flex items-start gap-3">
                  <code className="text-teal-300/80 text-xs font-mono shrink-0 mt-0.5">
                    {b.module}
                  </code>
                  <div>
                    <div className="text-white font-semibold text-sm mb-2 leading-snug">
                      {b.clause}
                    </div>
                    <p className="text-white/55 text-xs leading-relaxed">{b.explanation}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Honest limitations */}
        <section className="mb-16 rounded-xl border border-amber-500/20 p-6" style={{ background: "rgba(245,158,11,0.04)" }}>
          <h2 className="text-sm uppercase tracking-wider text-amber-300 font-semibold mb-3">
            Honest limitations
          </h2>
          <p className="text-white/75 leading-relaxed text-sm mb-3">
            GateTest is a code-quality + security scanner — not a SOC 2 / HIPAA / ISO auditor. We catch the technical findings auditors look for, but the audit itself needs a qualified human assessor.
          </p>
          <ul className="space-y-2 text-white/55 text-sm leading-relaxed">
            {data.countryCaveats.map((c) => (
              <li key={c} className="flex gap-2">
                <span className="text-amber-400/80 shrink-0">&middot;</span>
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* Use cases */}
        <section className="mb-16">
          <h2 className="text-2xl font-bold text-white mb-3">
            Who hires GateTest in {data.name}
          </h2>
          <div className="space-y-3 mt-6">
            {data.useCases.map((uc) => (
              <div
                key={uc}
                className="rounded-xl border border-white/[0.08] p-4 flex items-start gap-3"
                style={{ background: "rgba(255,255,255,0.03)" }}
              >
                <span className="text-teal-400 shrink-0 mt-0.5">&rarr;</span>
                <span className="text-white/70 text-sm leading-relaxed">{uc}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Pricing strip */}
        <section className="mb-16">
          <h2 className="text-2xl font-bold text-white mb-3">Pricing</h2>
          <p className="text-white/50 text-sm mb-8">
            Starting at $29 USD — paid via Stripe in your local currency.
          </p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { tier: "Quick", price: "$29", modules: "4 modules" },
              { tier: "Full", price: "$99", modules: `All ${MODULE_COUNT} modules` },
              { tier: "Scan + Fix", price: "$199", modules: "+ AI auto-fix PR" },
              { tier: "Forensic", price: "$399", modules: "+ pair review + exec summary" },
            ].map((p) => (
              <div
                key={p.tier}
                className="rounded-xl border border-white/[0.08] p-5"
                style={{ background: "rgba(255,255,255,0.03)" }}
              >
                <div className="text-xs uppercase tracking-wider text-white/40 mb-2">{p.tier}</div>
                <div className="text-2xl font-bold text-white mb-1">{p.price}</div>
                <div className="text-xs text-white/50">{p.modules}</div>
              </div>
            ))}
          </div>
        </section>

        {/* Trust strip */}
        <section className="mb-16">
          <div className="flex flex-wrap items-center justify-center gap-6 text-xs text-white/40">
            <span className="px-3 py-1.5 rounded-full border border-white/15">
              CLI is MIT-licensed
            </span>
            <span className="px-3 py-1.5 rounded-full border border-white/15">
              Available on GitHub Marketplace soon
            </span>
            {showLaunchBadges && (
              <span className="px-3 py-1.5 rounded-full border border-orange-500/20 text-orange-300">
                As featured on Hacker News &amp; Product Hunt
              </span>
            )}
          </div>
        </section>

        {/* CTA footer */}
        <section className="rounded-2xl border border-teal-500/20 p-10 text-center" style={{ background: "rgba(20,184,166,0.05)" }}>
          <h2 className="text-3xl font-bold text-white mb-4">
            Try it on your own repo
          </h2>
          <p className="text-white/60 mb-8 max-w-xl mx-auto">
            $29 Quick scan, no signup. Pay only when results land.
          </p>
          <Link
            href="/scan"
            className="btn-primary inline-flex items-center justify-center px-8 py-4 rounded-xl font-semibold"
            style={{ background: "#2dd4bf", color: "#0a0a12" }}
          >
            Run a {data.name} scan — $29
          </Link>
        </section>
      </main>

      <footer className="border-t border-white/[0.06] px-6 py-8 mt-16">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-white/30">
          <span>GateTest &copy; 2026</span>
          <div className="flex items-center gap-6 flex-wrap justify-center">
            {COUNTRIES.filter((c) => c.slug !== data.slug)
              .slice(0, 4)
              .map((c: Country) => (
                <Link
                  key={c.slug}
                  href={`/for/${c.slug}`}
                  className="hover:text-white/60 transition-colors"
                >
                  {c.name}
                </Link>
              ))}
          </div>
        </div>
      </footer>
    </div>
  );
}
