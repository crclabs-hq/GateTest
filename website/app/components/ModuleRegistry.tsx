/**
 * ModuleRegistry — curated grid highlighting analysis modules (120 total; see
 * /modules for the full enumerated list — this component shows a representative wall).
 *
 * Server component — no client state needed. The grid is the social proof:
 * an enterprise security lead scrolls this and sees that GateTest does the
 * work of 30+ tools. Thin-border cells, monospace labels, teal accent on
 * hover.
 */

type ModuleEntry = {
  key: string;
  label: string;
  note?: string;
};

type ModuleGroup = {
  title: string;
  tagline: string;
  modules: ModuleEntry[];
};

const GROUPS: ModuleGroup[] = [
  {
    title: "Security & Trust",
    tagline: "Credential hygiene, injection surfaces, cert bypass, supply chain",
    modules: [
      { key: "secrets",           label: "Secrets Detection",         note: "gitleaks-class" },
      { key: "tlsSecurity",       label: "TLS Cert Bypass",           note: "9 rule classes" },
      { key: "cookieSecurity",    label: "Cookie / Session Config",   note: "httpOnly, secure, weak-secret" },
      { key: "webHeaders",        label: "Security Headers & CORS",   note: "CSP, HSTS, XFO" },
      { key: "ssrf",              label: "SSRF / URL Validation",     note: "taint + metadata IPs" },
      { key: "hardcodedUrl",      label: "Hardcoded URLs",            note: "localhost, RFC1918, internal TLDs" },
      { key: "ciSecurity",        label: "CI Workflow Hardening",     note: "pwn-request, shell injection" },
      { key: "promptSafety",      label: "Prompt / LLM Safety",       note: "client-bundled keys, injection" },
      { key: "logPii",            label: "PII in Logs",               note: "GDPR / CCPA compliance" },
      { key: "homoglyph",         label: "Homoglyph / Unicode",       note: "Trojan Source CVE-2021-42574" },
      { key: "authBypass",        label: "Auth Bypass Patterns",      note: "check-then-act gaps" },
      { key: "crossFileTaint",    label: "Cross-File Taint",          note: "source-to-sink across files" },
    ],
  },
  {
    title: "Reliability & Correctness",
    tagline: "The subtle bugs that pass code review and fail in production",
    modules: [
      { key: "errorSwallow",   label: "Error Swallow",          note: "empty catch, fire-and-forget" },
      { key: "asyncIteration", label: "Async Iteration",        note: "forEach/filter/reduce async" },
      { key: "raceCondition",  label: "Race Conditions",        note: "TOCTOU, get-or-create" },
      { key: "resourceLeak",   label: "Resource Leaks",         note: "streams, sockets, intervals" },
      { key: "retryHygiene",   label: "Retry Hygiene",          note: "backoff, jitter, unbounded loops" },
      { key: "nPlusOne",       label: "N+1 Queries",            note: "Prisma, Sequelize, TypeORM, Mongoose" },
      { key: "featureFlag",    label: "Stale Feature Flags",    note: "always-true, dead branches" },
      { key: "importCycle",    label: "Circular Imports",       note: "Tarjan SCC, TDZ runtime kill" },
      { key: "redos",          label: "ReDoS",                  note: "catastrophic regex backtracking" },
      { key: "moneyFloat",     label: "Money Float",            note: "parseFloat on currency vars" },
      { key: "datetimeBug",    label: "Datetime / TZ Bugs",     note: "naive datetime, month-0 trap" },
      { key: "cronExpression", label: "Cron Expression",        note: "Feb 30, impossible dates" },
    ],
  },
  {
    title: "Testing & Verification",
    tagline: "Mutation, bidirectional gate, flaky-test radar, fake-fix detector",
    modules: [
      { key: "mutation",           label: "Mutation Testing",         note: "19 operator classes" },
      { key: "flakyTests",         label: "Flaky Test Radar",         note: ".only, Math.random, real fetch" },
      { key: "fakeFixDetector",    label: "Fake-Fix Detector",        note: "catches symptom patches" },
      { key: "aiReview",           label: "AI Code Review",           note: "memory-enriched Claude" },
      { key: "regressionPredictor",label: "Regression Predictor",     note: "pattern-aware risk scoring" },
      { key: "intentVerification", label: "Intent Verification",      note: "spec-vs-code drift" },
    ],
  },
  {
    title: "Type Safety & Quality",
    tagline: "TypeScript strictness regressions, API spec drift, code smell",
    modules: [
      { key: "typescriptStrictness", label: "TS Strictness",       note: "@ts-nocheck, any leaks" },
      { key: "codeQuality",          label: "Code Quality",         note: "SonarQube-class patterns" },
      { key: "syntax",               label: "Syntax Correctness",   note: "zero-tolerance parse errors" },
      { key: "lint",                 label: "ESLint / Stylelint",   note: "unified rule surface" },
      { key: "openapiDrift",         label: "OpenAPI Drift",        note: "spec ↔ handler mismatch" },
      { key: "deadCode",             label: "Dead Code",            note: "unused exports, orphaned files" },
    ],
  },
  {
    title: "Infrastructure",
    tagline: "Deployment config, secret rotation, IaC, container hardening",
    modules: [
      { key: "dependencies",    label: "Dependency Hygiene",    note: "npm / pip / go.mod / Cargo / Maven" },
      { key: "dockerfile",      label: "Dockerfile Security",   note: "root user, :latest, curl|sh" },
      { key: "terraform",       label: "Terraform / IaC",       note: "public ACLs, wildcard IAM" },
      { key: "kubernetes",      label: "Kubernetes Manifests",  note: "privileged, missing limits" },
      { key: "shell",           label: "Shell Scripts",         note: "shellcheck-class, set -euo pipefail" },
      { key: "sqlMigrations",   label: "SQL Migration Safety",  note: "DROP COLUMN, ADD NOT NULL" },
      { key: "envVars",         label: "Env Var Contract",      note: "declared ↔ used cross-check" },
      { key: "secretRotation",  label: "Secret Rotation",       note: "git-aware age: >90d error" },
      { key: "deployReadiness", label: "Deploy Readiness",      note: "pre-launch gate checklist" },
    ],
  },
  {
    title: "Performance & Accessibility",
    tagline: "Lighthouse-class signals, bundle bloat, a11y, broken links",
    modules: [
      { key: "performance",   label: "Performance",      note: "Lighthouse 95+ target" },
      { key: "bundleSize",    label: "Bundle Size",       note: "chunk analysis, tree-shake gaps" },
      { key: "accessibility", label: "Accessibility",     note: "axe/pa11y-class, WCAG 2.1 AA" },
      { key: "seo",           label: "SEO & Metadata",    note: "OG tags, structured data" },
      { key: "links",         label: "Broken Links",      note: "static + anchor verification" },
      { key: "cacheHeaders",  label: "Cache Headers",     note: "stale-while-revalidate, ETags" },
      { key: "visual",        label: "Visual Regression", note: "Percy-class baseline diffing" },
      { key: "e2e",           label: "E2E Coverage",      note: "Playwright / Cypress detection" },
    ],
  },
  {
    title: "Language Coverage",
    tagline: "Universal-checker engine — same rule depth across every stack",
    modules: [
      { key: "python",  label: "Python",     note: "type hints, naive datetime, float money" },
      { key: "go",      label: "Go",         note: "goroutine leaks, error wrapping" },
      { key: "rust",    label: "Rust",       note: "unsafe blocks, unwrap in prod" },
      { key: "java",    label: "Java",       note: "Spring Security, serialisation" },
      { key: "ruby",    label: "Ruby",       note: "mass assignment, send injection" },
      { key: "php",     label: "PHP",        note: "eval, register_globals, PDO hygiene" },
      { key: "csharp",  label: "C#",         note: "async void, ToList inside LINQ" },
      { key: "kotlin",  label: "Kotlin",     note: "coroutine scope leaks, !! abuse" },
      { key: "swift",   label: "Swift",      note: "force-unwrap, implicit retain cycles" },
    ],
  },
  {
    title: "AI & Agentic",
    tagline: "Self-healing engine, memory flywheel, architecture awareness",
    modules: [
      { key: "memory",            label: "Codebase Memory",      note: "compounding fix history" },
      { key: "agentic",           label: "Agentic Exploration",  note: "hypothesis-driven investigation" },
      { key: "aiHallucination",   label: "AI Hallucination",     note: "patch-vs-intent verification" },
      { key: "architectureDrift", label: "Architecture Drift",   note: "spec deviation detection" },
    ],
  },
];

// ── Sub-components ─────────────────────────────────────────────────────────────

function ModuleCell({ entry }: { entry: ModuleEntry }) {
  return (
    <div className="group border border-zinc-800 rounded-lg px-3 py-2.5 hover:border-teal-700 hover:bg-zinc-900/60 transition-all duration-150 cursor-default">
      <div className="font-mono text-[11px] text-zinc-300 group-hover:text-teal-300 transition-colors duration-150 leading-tight">
        {entry.label}
      </div>
      {entry.note && (
        <div className="font-mono text-[10px] text-zinc-600 group-hover:text-zinc-500 mt-0.5 leading-tight truncate">
          {entry.note}
        </div>
      )}
    </div>
  );
}

function ModuleGroupSection({ group }: { group: ModuleGroup }) {
  return (
    <div className="mb-12">
      <div className="flex items-baseline gap-3 mb-1">
        <h3 className="text-sm font-semibold text-zinc-200">{group.title}</h3>
        <span className="text-[10px] font-mono text-zinc-600 uppercase tracking-widest">
          {group.modules.length} modules
        </span>
      </div>
      <p className="text-[12px] text-zinc-500 mb-3 font-mono">{group.tagline}</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
        {group.modules.map((m) => (
          <ModuleCell key={m.key} entry={m} />
        ))}
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function ModuleRegistry() {
  const totalModules = GROUPS.reduce((n, g) => n + g.modules.length, 0);

  return (
    <section className="py-24 px-6 bg-zinc-950 border-t border-zinc-900">
      <div className="mx-auto max-w-6xl">

        {/* Header */}
        <div className="text-center mb-14">
          <span className="inline-block text-[11px] font-mono uppercase tracking-[0.2em] text-teal-500 mb-4">
            Analysis Engine
          </span>
          <h2 className="text-2xl sm:text-3xl font-bold text-zinc-100 mb-3">
            {totalModules} Modules. One Gate. One Decision.
          </h2>
          <p className="text-zinc-400 max-w-xl mx-auto text-sm leading-relaxed">
            Every module produces a structured finding. Every finding feeds the
            repair engine. Every repair is bidirectionally certified before a PR
            opens. No exceptions.
          </p>
        </div>

        {/* Module groups */}
        {GROUPS.map((g) => (
          <ModuleGroupSection key={g.title} group={g} />
        ))}

        {/* Footer stat */}
        <div className="border-t border-zinc-800 pt-8 mt-4 flex flex-wrap gap-8 justify-center text-center">
          {[
            ["120", "Analysis modules"],
            ["30+", "Tools replaced"],
            ["1", "Gate verdict"],
            ["$29", "Starting price"],
          ].map(([stat, label]) => (
            <div key={label}>
              <div className="text-2xl font-bold text-teal-400 font-mono">{stat}</div>
              <div className="text-[11px] text-zinc-500 font-mono uppercase tracking-widest mt-0.5">{label}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
