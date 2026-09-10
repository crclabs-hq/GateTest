import type { Metadata } from "next";
import Link from "next/link";
import { COUNTRIES } from "./countries";
import { TOTAL_MODULES } from "@/app/lib/module-count";
import PageHero from "../components/site/PageHero";
import Section from "../components/site/Section";

// Total live module count — single source of truth, see module-count.ts.
const MODULE_COUNT = TOTAL_MODULES;

const FRAMEWORK_PAGES = [
  { slug: "nextjs", name: "Next.js", note: "App Router, Server Actions, vercel.json" },
  { slug: "typescript", name: "TypeScript", note: "tsconfig strictness, any-leak detection" },
  { slug: "nodejs", name: "Node.js", note: "Express, Fastify, NestJS, runtime patterns" },
];

export const metadata: Metadata = {
  title: "GateTest by country and stack — compliance scanning for your market",
  description: `GateTest's ${MODULE_COUNT} modules tuned for your region's compliance regime — HIPAA / GDPR / Privacy Act / PDPA / PIPEDA — and your stack — Next.js, TypeScript, Node.js.`,
  alternates: {
    canonical: "/for",
  },
  openGraph: {
    title: "GateTest by country and stack",
    description: `Country-specific and framework-specific landing pages for GateTest's ${MODULE_COUNT}-module scan suite.`,
    url: "/for",
    siteName: "GateTest",
    type: "website",
  },
};

export default function ForIndex() {
  return (
    <main>
      <div className="section-alt relative z-10 -mb-8">
        <nav aria-label="Breadcrumb" className="mx-auto max-w-7xl px-6 pt-6 flex flex-wrap items-center gap-2 text-sm text-muted">
          <Link href="/" className="hover:text-foreground transition-colors">GateTest</Link>
          <span aria-hidden="true">/</span>
          <span className="text-foreground-secondary">For</span>
        </nav>
      </div>

      <PageHero
        eyebrow="By country and stack"
        title={
          <>
            GateTest <span className="gradient-text">for your stack and market</span>
          </>
        }
        lede={<>{MODULE_COUNT} modules, one scan, AI auto-fix PRs at the Scan + Fix tier. Pick the country or stack closest to yours — same engine, different framing for the compliance regime you actually have to defend.</>}
      />

      <Section
        title="By country"
        lede="Each page maps GateTest modules to the specific regulation clauses devs in that country answer to."
      >
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {COUNTRIES.map((c) => (
            <Link key={c.slug} href={`/for/${c.slug}`} className="card block p-5">
              <div className="flex items-start justify-between gap-2 mb-3">
                <span className="font-mono text-accent text-xs">{c.flag}</span>
                <span className="text-xs text-muted text-right">
                  {c.popularHosts.slice(0, 1).join(", ")}
                </span>
              </div>
              <h3 className="font-display text-foreground font-semibold text-lg mb-1">{c.name}</h3>
              <p className="text-accent text-xs font-mono mb-3">{c.primaryRegulation}</p>
              <p className="text-foreground-secondary text-xs leading-relaxed">{c.whyGateTestFits.split(".")[0]}.</p>
            </Link>
          ))}
        </div>
      </Section>

      <Section
        alt
        title="By stack"
        lede={<>Framework-specific landing pages. Same {MODULE_COUNT} modules, framed for the conventions you actually ship with.</>}
      >
        <div className="grid sm:grid-cols-3 gap-4">
          {FRAMEWORK_PAGES.map((f) => (
            <Link key={f.slug} href={`/for/${f.slug}`} className="card block p-5">
              <h3 className="font-display text-foreground font-semibold text-lg mb-1">{f.name}</h3>
              <p className="text-foreground-secondary text-xs leading-relaxed">{f.note}</p>
            </Link>
          ))}
        </div>
      </Section>

      <Section>
        <div className="rounded-2xl border border-accent/20 bg-accent/5 p-8 sm:p-10 text-center">
          <h2 className="font-display text-3xl font-bold text-foreground mb-4">Run a scan on your repo</h2>
          <p className="text-foreground-secondary mb-8 max-w-xl mx-auto">
            $29 Quick scan, no signup. {MODULE_COUNT} modules at the Full tier. AI auto-fix PR at Scan + Fix.
          </p>
          <Link href="/scan" className="btn-cta px-8 py-4">
            Run a scan — from $29
          </Link>
          <p className="mt-6 text-sm">
            <Link href="/modules" className="text-muted hover:text-accent transition-colors">All modules &rarr;</Link>
          </p>
        </div>
      </Section>
    </main>
  );
}
