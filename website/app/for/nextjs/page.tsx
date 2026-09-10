import type { Metadata } from "next";
import Link from "next/link";
import { TOTAL_MODULES } from "@/app/lib/module-count";
import PageHero from "../../components/site/PageHero";
import Section from "../../components/site/Section";

export const metadata: Metadata = {
  title: "Code Quality for Next.js Apps — GateTest",
  description:
    "121 checks built for Next.js: App Router route validation, React Hook exhaustive-deps, TypeScript strict mode, Core Web Vitals, OpenGraph tags, accessibility, security headers. AI-powered fixes at the Scan + Fix tier and above.",
  keywords: [
    "Next.js code quality",
    "Next.js testing",
    "Next.js security scanning",
    "App Router validation",
    "Next.js CI/CD",
    "Next.js accessibility",
    "Core Web Vitals scanning",
    "Next.js TypeScript strict mode",
  ],
  alternates: {
    canonical: "/for/nextjs",
  },
  openGraph: {
    title: "Code Quality for Next.js Apps — GateTest",
    description:
      "121 checks built for Next.js: App Router route validation, React Hook exhaustive-deps, TypeScript strict mode, Core Web Vitals, OpenGraph tags, accessibility, security headers. AI-powered fixes at the Scan + Fix tier and above.",
    url: "/for/nextjs",
    siteName: "GateTest",
    type: "website",
  },
};

const nextjsModules = [
  {
    name: "typescriptStrictness",
    label: "TypeScript Strict Mode",
    description: "Catches tsconfig regressions — strict: false, noImplicitAny: false, skipLibCheck: true. Flags @ts-ignore abuse and any-type leaks in exported signatures.",
    tag: "Quality",
  },
  {
    name: "importCycle",
    label: "Import Cycle Detection",
    description: "Finds circular imports across App Router pages, layouts, components, and server actions. Uses Tarjan's SCC algorithm — catches the bugs that reproduce randomly based on module-cache order.",
    tag: "Reliability",
  },
  {
    name: "webHeaders",
    label: "Security Headers",
    description: "Reads next.config.js headers() export and vercel.json. Flags CSP unsafe-eval/unsafe-inline, wildcard CORS with credentials, HSTS max-age below 180 days, missing X-Content-Type-Options.",
    tag: "Security",
  },
  {
    name: "deadCode",
    label: "Dead Code / Unused Exports",
    description: "Finds unused exports and orphaned files. Understands Next.js App Router conventions — page.tsx, layout.tsx, route.ts, loading.tsx, error.tsx, robots.ts, sitemap.ts are always live exports.",
    tag: "Quality",
  },
  {
    name: "openapiDrift",
    label: "API Route Drift",
    description: "Cross-references openapi.yaml against your app/api/**/route.ts handlers with exported GET/POST/PUT/DELETE functions. Flags undocumented routes and spec ghost routes.",
    tag: "Quality",
  },
  {
    name: "envVars",
    label: "Env Var Contract",
    description: "Compares .env.example against actual process.env reads in your codebase. Flags NEXT_PUBLIC_* client-bundled keys, undeclared vars, and declared-but-unreferenced secrets.",
    tag: "Security",
  },
  {
    name: "accessibility",
    label: "Accessibility (WCAG 2.2 automated audit — AA + AAA-aligned)",
    description: "Full accessibility audit — missing alt text, ARIA label gaps, keyboard navigation, focus indicators, color contrast, and structured landmark regions.",
    tag: "UX",
  },
  {
    name: "performance",
    label: "Core Web Vitals",
    description: "Lighthouse-equivalent performance analysis — LCP, CLS, FID, bundle size, image optimization, font loading, and render-blocking resources.",
    tag: "Performance",
  },
  {
    name: "promptSafety",
    label: "AI Safety (for AI-powered apps)",
    description: "Catches NEXT_PUBLIC_* API keys being bundled to the client, missing max_tokens (cost DoS), prompt injection surfaces from user input, deprecated AI models.",
    tag: "Security",
  },
  {
    name: "cookieSecurity",
    label: "Cookie & Session Security",
    description: "Flags httpOnly: false, secure: false, and weak session secrets like 'changeme' or 'keyboard cat' in Next.js session options and API route cookie handlers.",
    tag: "Security",
  },
];

const faqItems = [
  {
    q: "Does GateTest understand Next.js App Router conventions?",
    a: "Yes. GateTest's dead-code module recognises Next.js App Router reserved exports — page.tsx, layout.tsx, route.ts, loading.tsx, error.tsx, not-found.tsx, robots.ts, sitemap.ts, opengraph-image.tsx — and never flags them as unused, even if nothing explicitly imports them. The openapi-drift module harvests routes from app/api/**/route.ts files with exported HTTP method functions.",
  },
  {
    q: "Does GateTest check my next.config.js for security issues?",
    a: "Yes. The webHeaders module reads next.config.js (including the headers() async function), vercel.json, and _headers files. It flags: CSP with unsafe-eval (blocks arbitrary JS execution) or unsafe-inline (XSS risk), wildcard Access-Control-Allow-Origin combined with credentials: true (CORS credential leakage), HSTS max-age below 180 days (HSTS preload ineligible), and missing X-Content-Type-Options (MIME-sniffing attacks).",
  },
  {
    q: "Can GateTest detect environment variable issues in Next.js apps?",
    a: "Yes. The envVars module cross-references your .env.example, vercel.json env declarations, and actual process.env.* reads in source code. For Next.js specifically, it flags NEXT_PUBLIC_* variables — these are bundled into client JavaScript and visible to all users. If you accidentally declare NEXT_PUBLIC_STRIPE_SECRET_KEY, GateTest catches it before it ships.",
  },
  {
    q: "Does GateTest validate TypeScript strictness for Next.js projects?",
    a: "Yes. The typescriptStrictness module walks your tsconfig.json (including JSONC with comments), tsconfig.app.json, tsconfig.node.json, and any tsconfig.*.json files. It catches: strict: false (error), noImplicitAny: false (error), @ts-nocheck annotations (error), and unreasoned @ts-ignore without an explanation comment (warning). Test tsconfig files are allowed to relax strictness — production configs are not.",
  },
  {
    q: "Does GateTest scan Next.js Server Actions?",
    a: "Server Actions are TypeScript/JavaScript source files — all GateTest source-code modules apply: security patterns, N+1 query detection, SSRF checks, error-swallow detection, and AI code review. The agentic module investigates the most suspicious patterns in your action handlers with full context from Claude.",
  },
  {
    q: "How does GateTest handle Vercel deployment checks?",
    a: "GateTest reads vercel.json for security header configuration, env var declarations, and cron job expressions. The cronExpression module validates vercel.json crons[].schedule fields — catching impossible cron expressions like '0 0 31 2 *' (Feb 31 — never fires) before they reach production.",
  },
];

const realBugs = [
  {
    bug: "NEXT_PUBLIC_ANTHROPIC_KEY exposed in client bundle", // prompt-safety-ok — demo description
    module: "envVars + promptSafety",
    severity: "error",
    detail: "Any NEXT_PUBLIC_* variable is bundled into JavaScript sent to every user's browser. GateTest flags this at the CI gate before it reaches production.",
  },
  {
    bug: "import cycle: app/components/Modal → app/lib/auth → app/components/Modal",
    module: "importCycle",
    severity: "error",
    detail: "Circular imports in Next.js cause random 'undefined' values depending on module-cache initialization order. Tarjan's SCC finds every cycle — not just the obvious ones.",
  },
  {
    bug: "CSP header missing 'upgrade-insecure-requests' in next.config.js",
    module: "webHeaders",
    severity: "warning",
    detail: "GateTest reads your next.config.js headers() export and validates the full Content Security Policy against OWASP recommendations.",
  },
  {
    bug: "await prisma.user.findMany() inside users.map(async u => ...)",
    module: "nPlusOne",
    severity: "error",
    detail: "N+1 queries in Next.js Server Components and API routes are invisible to linters. GateTest detects database calls inside loop bodies — including .map(), .forEach(), .filter(), and for loops.",
  },
];

const tagColors: Record<string, string> = {
  Security: "text-danger bg-danger/10 border-danger/20",
  Quality: "text-accent bg-accent/10 border-accent/20",
  Reliability: "text-warning bg-warning/10 border-warning/20",
  UX: "text-purple-600 bg-purple-500/10 border-purple-500/20",
  Performance: "text-blue-600 bg-blue-500/10 border-blue-500/20",
};

const severityTone = (severity: string) =>
  severity === "error" ? "text-danger bg-danger/10 border-danger/20" : "text-warning bg-warning/10 border-warning/20";

export default function NextJsPage() {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqItems.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  };

  return (
    <main>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <div className="section-alt relative z-10 -mb-8">
        <nav aria-label="Breadcrumb" className="mx-auto max-w-7xl px-6 pt-6 flex flex-wrap items-center gap-2 text-sm text-muted">
          <Link href="/" className="hover:text-foreground transition-colors">GateTest</Link>
          <span aria-hidden="true">/</span>
          <Link href="/for" className="hover:text-foreground transition-colors">For</Link>
          <span aria-hidden="true">/</span>
          <span className="text-foreground-secondary">Next.js</span>
        </nav>
      </div>

      <PageHero
        eyebrow="Framework-specific scanning"
        title={
          <>
            Code Quality for
            <br />
            <span className="text-accent">Next.js Applications</span>
          </>
        }
        lede={
          <>
            GateTest understands Next.js — App Router conventions, server actions, Vercel deployment config,
            next.config.js security headers, and NEXT_PUBLIC_* environment variable exposure. {TOTAL_MODULES} modules
            built for the way modern Next.js apps are actually structured.
          </>
        }
        actions={
          <>
            <Link href="/" className="btn-cta px-6 py-3 text-sm">
              Scan My Next.js App — From $29
            </Link>
            <Link href="/" className="btn-secondary px-6 py-3 text-sm">
              See All {TOTAL_MODULES} Modules
            </Link>
          </>
        }
      />

      <Section
        title="Modules built for Next.js"
        lede="These modules have first-class Next.js awareness. Each applies to all JS/TS projects, but understands Next.js-specific patterns."
      >
        <div className="grid sm:grid-cols-2 gap-4">
          {nextjsModules.map((mod) => (
            <div key={mod.name} className="card p-5">
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="min-w-0">
                  <code className="text-accent text-xs font-mono">{mod.name}</code>
                  <h3 className="text-foreground font-semibold text-sm mt-0.5">{mod.label}</h3>
                </div>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full border shrink-0 ${tagColors[mod.tag] ?? "text-muted bg-surface-solid border-border"}`}>
                  {mod.tag}
                </span>
              </div>
              <p className="text-foreground-secondary text-xs leading-relaxed">{mod.description}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section alt title="Real bugs in real Next.js apps">
        <div className="space-y-4">
          {realBugs.map((item) => (
            <div key={item.bug} className="card p-5">
              <div className="flex flex-col sm:flex-row items-start gap-3">
                <span className={`text-xs font-semibold px-2 py-0.5 rounded border shrink-0 mt-0.5 ${severityTone(item.severity)}`}>
                  {item.severity}
                </span>
                <div className="min-w-0">
                  <code className="text-foreground text-sm font-mono break-words">{item.bug}</code>
                  <div className="flex items-center gap-2 mt-1.5 mb-2">
                    <code className="text-accent text-xs">{item.module}</code>
                  </div>
                  <p className="text-foreground-secondary text-xs leading-relaxed">{item.detail}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Frequently asked questions">
        <div className="space-y-4">
          {faqItems.map((item) => (
            <div key={item.q} className="card p-5">
              <h3 className="text-foreground font-semibold mb-3 leading-snug">{item.q}</h3>
              <p className="text-foreground-secondary text-sm leading-relaxed">{item.a}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section alt>
        <div className="rounded-2xl border border-accent/20 bg-accent/5 p-8 sm:p-10 text-center">
          <h2 className="font-display text-3xl font-bold text-foreground mb-4">
            Ship Next.js apps with confidence.
          </h2>
          <p className="text-foreground-secondary mb-8 max-w-xl mx-auto">
            {TOTAL_MODULES} modules, App Router awareness, AI-powered review on every paid tier, and AI auto-fix PRs at the Scan + Fix tier ($199) and Forensic Scan ($399). One price per scan, no seats.
          </p>
          <Link href="/" className="btn-cta px-8 py-4">
            Scan My Next.js App — From $29
          </Link>
          <p className="text-muted text-xs mt-6">
            One-time charge at checkout. No subscription, no per-seat licensing.
          </p>
        </div>
        <p className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-muted">
          <span>Also for:</span>
          <Link href="/for/typescript" className="hover:text-accent transition-colors">TypeScript</Link>
          <Link href="/for/nodejs" className="hover:text-accent transition-colors">Node.js</Link>
        </p>
      </Section>
    </main>
  );
}
