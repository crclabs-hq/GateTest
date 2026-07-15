import type { Metadata } from "next";
import Link from "next/link";
import { COUNTRIES } from "./countries";
import { TOTAL_MODULES } from "@/app/lib/module-count";

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
    canonical: "https://gatetest.ai/for",
  },
  openGraph: {
    title: "GateTest by country and stack",
    description: `Country-specific and framework-specific landing pages for GateTest's ${MODULE_COUNT}-module scan suite.`,
    url: "https://gatetest.ai/for",
    siteName: "GateTest",
    type: "website",
  },
};

export default function ForIndex() {
  return (
    <div className="min-h-screen" style={{ background: "#0a0a12" }}>
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
          <Link href="/" className="text-sm text-white/50 hover:text-white transition-colors">
            &larr; Back to GateTest
          </Link>
        </div>
      </nav>

      <main className="px-6 py-16 max-w-5xl mx-auto">
        <nav className="flex items-center gap-2 text-sm text-white/40 mb-10">
          <Link href="/" className="hover:text-white/70 transition-colors">GateTest</Link>
          <span>/</span>
          <span className="text-white/60">For</span>
        </nav>

        <header className="mb-16">
          <h1 className="text-4xl sm:text-5xl font-bold text-white leading-tight mb-6">
            GateTest <span className="gradient-text">for your stack and market</span>
          </h1>
          <p className="text-lg text-white/60 max-w-2xl leading-relaxed">
            {MODULE_COUNT} modules, one scan, AI auto-fix PRs at the Scan + Fix tier. Pick the country or stack closest to yours — same engine, different framing for the compliance regime you actually have to defend.
          </p>
        </header>

        <section className="mb-16">
          <h2 className="text-2xl font-bold text-white mb-3">By country</h2>
          <p className="text-white/50 text-sm mb-8">
            Each page maps GateTest modules to the specific regulation clauses devs in that country answer to.
          </p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {COUNTRIES.map((c) => (
              <Link
                key={c.slug}
                href={`/for/${c.slug}`}
                className="rounded-xl p-5 border border-white/[0.08] hover:border-teal-500/30 transition-colors block"
                style={{ background: "rgba(255,255,255,0.03)" }}
              >
                <div className="flex items-start justify-between gap-2 mb-3">
                  <span className="font-mono text-teal-400 text-xs">{c.flag}</span>
                  <span className="text-xs text-white/40 text-right">
                    {c.popularHosts.slice(0, 1).join(", ")}
                  </span>
                </div>
                <h3 className="text-white font-semibold text-lg mb-1">{c.name}</h3>
                <p className="text-teal-300/80 text-xs font-mono mb-3">{c.primaryRegulation}</p>
                <p className="text-white/55 text-xs leading-relaxed">{c.whyGateTestFits.split(".")[0]}.</p>
              </Link>
            ))}
          </div>
        </section>

        <section className="mb-16">
          <h2 className="text-2xl font-bold text-white mb-3">By stack</h2>
          <p className="text-white/50 text-sm mb-8">
            Framework-specific landing pages. Same {MODULE_COUNT} modules, framed for the conventions you actually ship with.
          </p>
          <div className="grid sm:grid-cols-3 gap-4">
            {FRAMEWORK_PAGES.map((f) => (
              <Link
                key={f.slug}
                href={`/for/${f.slug}`}
                className="rounded-xl p-5 border border-white/[0.08] hover:border-teal-500/30 transition-colors block"
                style={{ background: "rgba(255,255,255,0.03)" }}
              >
                <h3 className="text-white font-semibold text-lg mb-1">{f.name}</h3>
                <p className="text-white/55 text-xs leading-relaxed">{f.note}</p>
              </Link>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-teal-500/20 p-10 text-center" style={{ background: "rgba(20,184,166,0.05)" }}>
          <h2 className="text-3xl font-bold text-white mb-4">Run a scan on your repo</h2>
          <p className="text-white/60 mb-8 max-w-xl mx-auto">
            $29 Quick scan, no signup. {MODULE_COUNT} modules at the Full tier. AI auto-fix PR at Scan + Fix.
          </p>
          <Link
            href="/scan"
            className="btn-primary inline-flex items-center justify-center px-8 py-4 rounded-xl font-semibold"
            style={{ background: "#2dd4bf", color: "#0a0a12" }}
          >
            Run a scan — from $29
          </Link>
        </section>
      </main>

      <footer className="border-t border-white/[0.06] px-6 py-8 mt-16">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-4 text-sm text-white/30">
          <span>GateTest &copy; 2026</span>
          <Link href="/modules" className="hover:text-white/60 transition-colors">All modules</Link>
        </div>
      </footer>
    </div>
  );
}
