import type { Metadata } from "next";
import Link from "next/link";
import { TOTAL_MODULES } from "@/app/lib/module-count";
import PageHero from "../../components/site/PageHero";
import Section from "../../components/site/Section";

export const metadata: Metadata = {
  title: "Node.js Security & Quality Scanning — GateTest",
  description:
    "Security headers, SQL injection detection, N+1 queries, resource leaks, SSRF vulnerabilities, ReDoS patterns, race conditions — GateTest covers every Node.js failure mode.",
  keywords: [
    "Node.js security scanning",
    "Node.js code quality",
    "Node.js SSRF detection",
    "Node.js N+1 queries",
    "Express.js security",
    "Node.js race conditions",
    "Node.js resource leaks",
    "Node.js CI gate",
  ],
  alternates: {
    canonical: "/for/nodejs",
  },
  openGraph: {
    title: "Node.js Security & Quality Scanning — GateTest",
    description:
      "Security headers, SQL injection detection, N+1 queries, resource leaks, SSRF vulnerabilities, ReDoS patterns, race conditions — GateTest covers every Node.js failure mode.",
    url: "/for/nodejs",
    siteName: "GateTest",
    type: "website",
  },
};

const faqItems = [
  {
    q: "What Node.js security issues does GateTest find?",
    a: "GateTest covers the full OWASP Top 10 for Node.js: SSRF (tracking user-controlled input from req.body to fetch()), SQL injection patterns, ReDoS (catastrophic regex that can halt your event loop), TLS validation bypass (rejectUnauthorized: false, NODE_TLS_REJECT_UNAUTHORIZED=0), cookie security misconfigs (httpOnly: false, secure: false, weak secrets), hardcoded localhost URLs that leak to production, PII in logs (console.log(user), logger.info(req.body)), and more.",
  },
  {
    q: "Does GateTest detect N+1 query problems in Node.js ORMs?",
    a: "Yes. The nPlusOne module covers Prisma, Sequelize, TypeORM, Mongoose, Knex, Drizzle, node-postgres, MySQL2, and generic db/orm/repo shapes. It finds database calls inside loop bodies — for loops, while loops, .map(), .forEach(), .filter(), .reduce(). It recognises await Promise.all(arr.map(async () => await db.query(...))) as the batched fix pattern and records it as info rather than error.",
  },
  {
    q: "Does GateTest detect resource leaks in Node.js?",
    a: "Yes. The resourceLeak module catches: unclosed fs.createReadStream / createWriteStream (error), fs.open / fs.promises.open file handles that are never closed (warning), WebSocket / EventSource / net.createConnection objects that are never closed (warning), and setInterval calls where the return value is discarded (error — no way to call clearInterval). It recognises stream.pipeline() and stream.finished() as proper cleanup patterns.",
  },
  {
    q: "How does GateTest catch SSRF in Node.js apps?",
    a: "The ssrf module tracks taint from request sources (req.body, req.query, req.params, req.headers) to HTTP client calls (fetch, axios, got, http.request, https.request, needle, superagent, undici, ky). If user input flows to a URL without an intermediate validator (validateUrl(), isValidUrl(), allowedHosts.includes(), new URL(x).hostname check), GateTest flags it as an error. It also flags hardcoded cloud-metadata endpoints (AWS 169.254.169.254, GCP metadata.google.internal).",
  },
  {
    q: "Does GateTest detect race conditions in Node.js?",
    a: "Yes. The raceCondition module catches TOCTOU (check-then-act) patterns: fs.exists()/fs.stat()/fs.access() followed within 15 lines by a destructive fs operation (unlink/rm/rename/chmod/copyFile/truncate) on the same path. For databases, it catches Prisma/Sequelize/Mongoose/TypeORM findFirst/findOne followed by create/update/upsert on the same model without a visible $transaction, ON CONFLICT, or upsert guard — the get-or-create lost-update bug.",
  },
  {
    q: "Does GateTest find ReDoS vulnerabilities in Node.js?",
    a: "Yes. The redos module extracts regex patterns from literal form (/pattern/), new RegExp('...') constructors, and checks for three catastrophic backtracking shapes: nested quantifiers ((a+)+, (.*)*), alternation with overlapping branches inside quantified groups ((a|a)*), and greedy .* sequences in unanchored patterns. It also catches user-controlled regex construction (new RegExp(req.body.pattern)) — a CWE-1333 injection vector.",
  },
];

const nodeModules = [
  {
    name: "ssrf",
    label: "SSRF / URL Validation",
    severity: "error",
    what: "Tracks req.body/query/params → fetch/axios/got. Flags tainted URLs, metadata endpoints (AWS 169.x.x.x, GCP), suspicious webhook vars without validation.",
  },
  {
    name: "nPlusOne",
    label: "N+1 Query Detector",
    severity: "error",
    what: "Database calls inside loops across Prisma, Sequelize, TypeORM, Mongoose, Knex, Drizzle, node-pg. Understands Promise.all(arr.map(async...)) as a fix.",
  },
  {
    name: "raceCondition",
    label: "Race Condition / TOCTOU",
    severity: "error",
    what: "fs.exists → fs.unlink on the same path. ORM findOne → create without $transaction or ON CONFLICT guard. The get-or-create lost-update bug.",
  },
  {
    name: "resourceLeak",
    label: "Resource Leak Detector",
    severity: "error",
    what: "Unclosed streams, file handles, WebSockets, net.createServer. setInterval with discarded return value. Recognises stream.pipeline() as safe cleanup.",
  },
  {
    name: "redos",
    label: "ReDoS / Catastrophic Regex",
    severity: "error",
    what: "Nested quantifiers (a+)+, overlapping alternation (a|a)*, greedy .* in unanchored patterns. User-controlled RegExp construction (CWE-1333).",
  },
  {
    name: "retryHygiene",
    label: "Retry Hygiene",
    severity: "warning",
    what: "while(true) with fetch and no break/max-attempts (unbounded). Constant sleep with no exponential multiplier (no backoff). No randomised jitter on the sleep. Retry-on-4xx without bail.",
  },
  {
    name: "tlsSecurity",
    label: "TLS Bypass Detection",
    severity: "error",
    what: "rejectUnauthorized: false in https.Agent. NODE_TLS_REJECT_UNAUTHORIZED=0 (global nuclear disable). strictSSL: false. insecure: true.",
  },
  {
    name: "cookieSecurity",
    label: "Cookie / Session Security",
    severity: "error",
    what: "httpOnly:false (XSS readable), secure:false (rides over HTTP), weak session secret. Express-session, cookie-parser, next/headers.", // cookie-ok — demo description
  },
  {
    name: "hardcodedUrl",
    label: "Hardcoded URL / Localhost Leak",
    severity: "error",
    what: "localhost / 127.0.0.1 / 0.0.0.0, RFC1918 ranges, .internal/.local/.corp TLDs, staging subdomains in production source code.", // hardcoded-url-ok — demo description
  },
  {
    name: "sqlMigrations",
    label: "SQL Migration Safety",
    severity: "error",
    what: "DROP COLUMN/TABLE, ADD COLUMN NOT NULL without default, SET NOT NULL, CREATE/DROP INDEX without CONCURRENTLY, ALTER TYPE rewrites, TRUNCATE.",
  },
];

const invisibleBugs = [
  {
    title: "SSRF is invisible to ESLint",
    code: "const url = req.query.webhook;\nfetch(url); // ← SSRF: user controls the target",
    module: "ssrf",
  },
  {
    title: "N+1 looks like normal async code",
    code: "const users = await db.user.findMany();\nfor (const u of users) {\n  // 1 query per user:\n  u.orders = await db.order.findMany({where: {userId: u.id}});\n}",
    module: "nPlusOne",
  },
  {
    title: "Resource leaks are silent",
    code: "// handle never used:\nsetInterval(syncData, 30_000);\n// nothing calls clearInterval",
    module: "resourceLeak",
  },
];

const severityTone = (severity: string) =>
  severity === "error" ? "text-danger bg-danger/10 border-danger/20" : "text-warning bg-warning/10 border-warning/20";

export default function NodeJsPage() {
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
          <span className="text-foreground-secondary">Node.js</span>
        </nav>
      </div>

      <PageHero
        eyebrow="Runtime-specific scanning"
        title={
          <>
            Node.js Security
            <br />
            <span className="text-accent">&amp; Quality Scanning</span>
          </>
        }
        lede={
          <>
            Node.js has a unique failure-mode profile: SSRF from request-to-fetch data flows,
            N+1 queries hidden inside async loops, race conditions in concurrent request handlers,
            resource leaks from unclosed streams, and ReDoS that can halt the event loop.
            GateTest covers every one.
          </>
        }
        actions={
          <>
            <Link href="/" className="btn-cta px-6 py-3 text-sm">
              Scan My Node.js App — From $29
            </Link>
            <Link href="/" className="btn-secondary px-6 py-3 text-sm">
              See All {TOTAL_MODULES} Modules
            </Link>
          </>
        }
      />

      <Section title="Node.js-specific modules">
        <div className="grid sm:grid-cols-2 gap-4">
          {nodeModules.map((mod) => (
            <div key={mod.name} className="card p-5">
              <div className="flex items-center justify-between gap-3 mb-2">
                <code className="text-accent text-xs font-mono">{mod.name}</code>
                <span className={`text-xs font-semibold px-2 py-0.5 rounded border ${severityTone(mod.severity)}`}>{mod.severity}</span>
              </div>
              <div className="text-foreground text-sm font-medium mb-1.5">{mod.label}</div>
              <p className="text-foreground-secondary text-xs leading-relaxed">{mod.what}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section
        alt
        title="Why these bugs survive code review"
        lede={
          <>
            SSRF, N+1, race conditions, and resource leaks are invisible to linters and most static analysis tools. They require understanding <em>what code does</em>, not just <em>how it looks</em>. GateTest uses data-flow analysis and AI reasoning to find bugs that pattern-matching tools miss entirely.
          </>
        }
      >
        <div className="grid sm:grid-cols-3 gap-4">
          {invisibleBugs.map((item) => (
            <div key={item.title} className="card p-4">
              <div className="text-foreground text-xs font-medium mb-2">{item.title}</div>
              <pre className="text-xs font-mono bg-panel text-panel-foreground border border-panel-border rounded p-3 mb-2 overflow-x-auto leading-relaxed whitespace-pre-wrap">{item.code}</pre>
              <code className="text-accent text-xs">→ caught by {item.module}</code>
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
            Find the bugs that survive code review.
          </h2>
          <p className="text-foreground-secondary mb-8 max-w-xl mx-auto">
            SSRF, N+1, race conditions, resource leaks, ReDoS — GateTest catches every Node.js failure mode. One-time payment per scan.
          </p>
          <Link href="/" className="btn-cta px-8 py-4">
            Scan My Node.js App — From $29
          </Link>
          <p className="text-muted text-xs mt-6">
            One-time payment per scan via Stripe. No subscription, no auto-renew.
          </p>
        </div>
        <p className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-muted">
          <span>Also for:</span>
          <Link href="/for/nextjs" className="hover:text-accent transition-colors">Next.js</Link>
          <Link href="/for/typescript" className="hover:text-accent transition-colors">TypeScript</Link>
        </p>
      </Section>
    </main>
  );
}
