interface ModuleCategory {
  name: string;
  blurb: string;
  modules: { name: string; desc: string }[];
}

const categories: ModuleCategory[] = [
  {
    name: "Source & quality",
    blurb: "The fundamentals. Every scan, every file.",
    modules: [
      { name: "Syntax", desc: "JS, TS, JSON, YAML, CSS, HTML parse checks." },
      { name: "Lint", desc: "ESLint / Stylelint rule coverage." },
      { name: "Secrets", desc: "AWS, GitHub, Stripe, private keys, DB strings — 14 patterns." },
      { name: "Code quality", desc: "console.log, debugger, eval, function complexity." },
      { name: "TypeScript strictness", desc: "tsconfig regressions, any-leaks, @ts-nocheck abuse." },
    ],
  },
  {
    name: "Security",
    blurb: "OWASP, CWE, and the long tail nobody else scans.",
    modules: [
      { name: "Security", desc: "XSS, SQLi, innerHTML, shell exec, OWASP patterns." },
      { name: "SSRF", desc: "Taint-tracked URL validation gaps and cloud-metadata leaks." },
      { name: "TLS bypass", desc: "rejectUnauthorized:false, verify=False, NODE_TLS_REJECT_UNAUTHORIZED=0." },
      { name: "Cookie security", desc: "httpOnly:false, weak secrets, SESSION_COOKIE_* misconfig." },
      { name: "ReDoS", desc: "Catastrophic backtracking + user-controlled RegExp construction." },
      { name: "Homoglyph", desc: "Trojan Source bidi attacks, Cyrillic lookalikes, zero-width chars." },
      { name: "Prompt safety", desc: "Client-bundled LLM keys, unbounded max_tokens, prompt injection." },
      { name: "Secret rotation", desc: "Git-aware credential age (>90d error, >30d warning)." },
      { name: "Web headers / CORS", desc: "CSP unsafe-eval, wildcard origin+credentials, missing HSTS." },
      { name: "CI security", desc: "GitHub Actions pwn-request, shell injection, secret-echo." },
      { name: "Hardcoded URLs", desc: "localhost / private IPs / staging subdomains leaking to prod." },
    ],
  },
  {
    name: "Reliability",
    blurb: "The silent runtime killers — the bugs that only break in prod.",
    modules: [
      { name: "Error swallow", desc: "Empty catch, log-and-eat, .catch(noop), fire-and-forget promises." },
      { name: "Flaky tests", desc: "Committed .only/.skip, unseeded randoms, real clocks, real HTTP." },
      { name: "N+1 queries", desc: "Prisma / Sequelize / TypeORM / Mongoose / Drizzle loop-query detector." },
      { name: "Retry hygiene", desc: "Unbounded loops, no backoff, no jitter, retry-on-4xx." },
      { name: "Race conditions", desc: "TOCTOU fs patterns, get-or-create lost-update on ORMs." },
      { name: "Resource leaks", desc: "Unclosed streams / WebSockets / intervals / file handles." },
      { name: "Datetime bugs", desc: "Python naive datetime, JS 0-vs-1 month, moment legacy mode." },
      { name: "Import cycles", desc: "Tarjan SCC across .js/.ts with type-only exclusion." },
      { name: "Async iteration", desc: ".reduce(async), .filter(async), unwrapped .map(async)." },
      { name: "Cron expressions", desc: "Field-range + impossible-date validator across GH Actions, K8s, Vercel." },
      { name: "Money / float", desc: "parseFloat on currency, .toFixed(0) precision bugs, decimal safe-harbour." },
    ],
  },
  {
    name: "Web & UX",
    blurb: "What users actually see.",
    modules: [
      { name: "Accessibility", desc: "WCAG 2.2 AAA, alt text, ARIA, keyboard traps, heading hierarchy." },
      { name: "SEO", desc: "Meta tags, Open Graph, structured data, canonical URLs." },
      { name: "Links", desc: "Every href — dead anchors, placeholder links, 404s." },
      { name: "Compatibility", desc: "Browser matrix, modern CSS / API coverage without polyfills." },
      { name: "Performance", desc: "Dependency count, bundle size, image optimisation." },
      { name: "Documentation", desc: "README, CHANGELOG, LICENSE, JSDoc coverage, env docs." },
      { name: "Data integrity", desc: "Migration safety, SQL patterns, PII in logs, schema validation." },
    ],
  },
  {
    name: "Infrastructure",
    blurb: "Supply chain, containers, clusters, and pipelines.",
    modules: [
      { name: "Dependencies", desc: "npm, pip, Poetry, go.mod, Cargo, Bundler, Composer, Maven, Gradle." },
      { name: "Dockerfile", desc: "Root user, :latest tags, curl|sh, apt hygiene, chmod 777." },
      { name: "Shell scripts", desc: "curl|sh, unsafe rm -rf, eval, set -euo pipefail, bashisms." },
      { name: "SQL migrations", desc: "DROP COLUMN, NOT NULL without default, CONCURRENTLY safety." },
      { name: "Terraform / IaC", desc: "Public S3, 0.0.0.0/0 on SSH, unencrypted RDS, IAM Principal:*." },
      { name: "Kubernetes", desc: "privileged, hostNetwork, :latest images, missing resources.limits." },
      { name: "Env vars contract", desc: ".env.example ↔ process.env drift, client-bundled keys." },
    ],
  },
  {
    name: "Developer hygiene",
    blurb: "The slow compounding drag on every codebase.",
    modules: [
      { name: "Dead code", desc: "Unused exports, orphaned files, rotting commented-out blocks." },
      { name: "Feature flags", desc: "Stale flags collapsed to constants, dead branches." },
      { name: "Log PII", desc: "Catches credentials, tokens, and request objects logged in plaintext." },
      { name: "OpenAPI drift", desc: "Spec ↔ Express / Fastify / Next.js route cross-reference." },
      { name: "PR size", desc: "File / line / directory-sprawl limits with lockfile auto-exclude." },
      { name: "Fake-fix detector", desc: "Catches AI symptom patches on diffs — the chicken-scratch killer." },
    ],
  },
  {
    name: "AI & advanced",
    blurb: "What Claude sees that grep can't.",
    modules: [
      { name: "AI code review", desc: "Claude reads your diff, finds real bugs — fix-pattern aware." },
      { name: "Agentic explorer", desc: "AI agent investigates memory-informed hypotheses." },
      { name: "Codebase memory", desc: "Issue history + fix-pattern database. The compounding moat." },
      { name: "Mutation testing", desc: "Modifies source to verify tests catch bugs." },
    ],
  },
  {
    name: "Scanning & testing",
    blurb: "Live, real-world behaviour — not just static analysis.",
    modules: [
      { name: "Unit tests", desc: "Jest, Vitest, Mocha — coverage + passing discovery." },
      { name: "Integration tests", desc: "Cross-module test discovery and execution." },
      { name: "E2E", desc: "Full-flow browser testing — every click, every form, every state." },
      { name: "Chaos", desc: "Slow networks, API failures, missing resources." },
      { name: "Live crawler", desc: "Real-site crawl — every page, every error." },
      { name: "Autonomous explorer", desc: "AI fills forms, clicks buttons, verifies state changes." },
      { name: "Visual regression", desc: "Screenshot comparison between deploys." },
    ],
  },
  {
    name: "Language coverage",
    blurb: "Beyond JS/TS — 9 language backends in one gate.",
    modules: [
      { name: "Python", desc: "PEP 8, security, type-annotation hygiene, naive datetimes." },
      { name: "Go", desc: "gofmt, vet patterns, error handling, time.Now() tz issues." },
      { name: "Rust", desc: "Clippy-style checks, unsafe block discipline, unwrap hygiene." },
      { name: "Java", desc: "Security, SpotBugs patterns, concurrency, Spring config drift." },
      { name: "Ruby", desc: "RuboCop coverage, Rails anti-patterns, SQL safety." },
      { name: "PHP", desc: "Composer hygiene, XSS, SQL injection, deprecated APIs." },
      { name: "C#", desc: ".NET patterns, async void, IDisposable, config leaks." },
      { name: "Kotlin", desc: "Android and JVM patterns, null-safety abuse, coroutine hygiene." },
      { name: "Swift", desc: "iOS/macOS patterns, force-unwrap, retain cycles, App Store hygiene." },
    ],
  },
];

export default function Modules() {
  return (
    <section id="modules" className="py-24 px-6 border-t border-border">
      <div className="mx-auto max-w-6xl">
        <div className="text-center mb-16">
          <span className="text-sm font-semibold text-accent uppercase tracking-wider">
            What We Check
          </span>
          <h2 className="text-3xl sm:text-4xl font-bold mt-4 mb-4 text-foreground">
            67 modules. <span className="gradient-text">Every scan.</span>
          </h2>
          <p className="text-muted text-lg max-w-2xl mx-auto">
            Source code analysis, AI review, infrastructure hardening, supply chain,
            and 9 language backends. Every module runs on every Full Scan. No
            configuration needed.
          </p>
          <p className="text-muted text-sm max-w-2xl mx-auto mt-3">
            13 core modules shown below &mdash; plus 54 more covering
            polyglot dependencies, Dockerfile &amp; Kubernetes hygiene,
            CI security, Terraform, SQL migrations, TLS &amp; cookie
            config, PII-in-logs, N+1 queries, SSRF, ReDoS, and more.
          </p>
        </div>

        {/* Active modules — the 13 flagship module cards. The remaining
            54 modules (infra, supply-chain, language checkers, etc.) are
            summarised in the subtitle above; see CLAUDE.md for the full
            list. */}
        {categories.map((cat) => (
          <div key={cat.name} className="mb-10">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-lg font-bold text-foreground">{cat.name}</h3>
                <p className="text-sm text-muted">{cat.blurb}</p>
              </div>
              <span className="text-xs font-mono text-muted shrink-0 ml-4">
                {cat.modules.length} module{cat.modules.length !== 1 ? "s" : ""}
              </span>
            </div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {cat.modules.map((mod) => (
                <div key={mod.name} className="card p-4">
                  <span className="text-sm font-semibold text-foreground">{mod.name}</span>
                  <p className="text-xs text-muted mt-1">{mod.desc}</p>
                </div>
              ))}
            </div>
          </div>
        ))}

      </div>
    </section>
  );
}
