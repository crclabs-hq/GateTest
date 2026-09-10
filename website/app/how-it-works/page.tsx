import Link from "next/link";
import ArchitectureDiagram from "../components/howitworks/ArchitectureDiagram";
import FlywheelTable from "../components/howitworks/FlywheelTable";
import CostTrendChart from "../components/howitworks/CostTrendChart";
import ModuleGrid from "../components/howitworks/ModuleGrid";
import TierTable from "../components/howitworks/TierTable";
import { MODULE_CATEGORIES, totalModuleCount } from "../components/howitworks/modules-data";
import PageHero from "../components/site/PageHero";
import Section from "../components/site/Section";

const TOTAL_MODULES = totalModuleCount();

const LIMITS = [
  "Doesn't replace a senior engineer's code review. We catch the bugs that have a recognisable shape; humans still own architecture and product judgement.",
  "Doesn't catch logic bugs that need domain context. If your invariant is 'don't ever discount over 30%', no scanner can know that without you telling it.",
  "Doesn't fix bugs that span 5+ files without human review. Multi-file refactors are flagged but require an engineer to drive.",
  "Coverage on Rust, Go, and Java is shallower than JS/TS/Python today. We have language-specific modules for nine non-JS backends but the depth is honestly thinner than our JS coverage.",
  "Hosted website scans read up to 50 source files per scan (prioritised by relevance) — enough for most small-to-mid repos, but a large monorepo gets a representative slice, not exhaustive coverage. The CLI and GitHub Action scan everything, with no file cap.",
  "No on-prem deployment yet. Everything runs on our own managed host with a Postgres (Neon) queue today. Air-gapped customers are on the roadmap.",
  "No VSCode extension that runs in real time yet. Today's loop is push → CI → PR comment. Editor integration is on the list.",
];

const QUIET_RULES = [
  {
    title: "One defect is one finding",
    body: "When three modules flag the same line — say a tainted eval() seen by the taint tracer, the security scanner and code quality — you read it once, owned by the module with the most detail. Folded duplicates are counted and disclosed, never silently dropped.",
  },
  {
    title: "Ranked by risk, budgeted to five",
    body: "The PR comment opens with the five findings that matter most — blocking first, then severity, then confidence, exploitable classes before hygiene, a concrete file:line before an aggregate. Everything else is collapsed under it. Nobody scrolls a wall.",
  },
  {
    title: "Dependency alerts that can actually hurt you",
    body: "A CVE blocks only when it sits in a production dependency your source actually imports. Dev-only tooling and installed-but-unused packages are reported with the reason — \"pulled in only by devDependencies\" — and never turn the check red.",
  },
  {
    title: "Errors need confidence to block",
    body: "Every error carries a confidence score from path and source context. Below the threshold it is shown, not enforced, and the report says how many were held back. Rules your team keeps dismissing are softened automatically by the flywheel.",
  },
  {
    title: "Environment failures are not your defects",
    body: "If a tool cannot run where the scan runs — no lockfile, no browser, no test runner installed — that is reported as a skip with the reason. It never becomes a red X on your code.",
  },
  {
    title: "Fragments, fixtures and vendored code are not pages",
    body: "SEO, accessibility and layout rules run on full documents, not template partials; test fixtures, docs screenshots and compiled vendor CSS are recognised for what they are. Measured on real repositories, with a positive control for every rule so quiet never means muted.",
  },
];

const DATA_FLOW = [
  { label: "Frontend", value: "Next.js 16 (App Router) + Tailwind 4. Server Components everywhere except where interactivity demands client." },
  { label: "Runtime",  value: "Node on our own managed host. Every request handler is stateless — no in-memory persistence between requests." },
  { label: "Database", value: "Postgres on Neon. Holds scan_queue, audit log, fix-recipe store, customer sessions." },
  { label: "Payments", value: "Stripe upfront-charge. Scan tiers are one-time payments at checkout — no auto-renew. Continuous ($49/mo) and MCP ($29/mo) are monthly subscriptions, cancel anytime." },
  { label: "AI layer", value: "Anthropic Claude — Fable 5 on the paid fix tiers (Scan + Fix, Forensic), Sonnet 5 on the free and high-volume paths. Our key for managed scans; your key for the self-healing CI bot in your repo." },
  { label: "Git host",  value: "Dual-host: GitHub App webhook and Gluecron Signal Bus. HostBridge abstraction means new hosts plug in without rewiring." },
  { label: "Browser",   value: "Playwright (open-source, Microsoft) — used internally for chaos, explorer, and runtime-error modules. Not a paid competitor; an implementation detail." },
];

const HEAL_STEPS = [
  { n: "1", t: "CI fails", d: "Workflow_run trigger fires on conclusion: failure." },
  { n: "2", t: "Logs in", d: "Heal step downloads the failing job's logs and the diff." },
  { n: "3", t: "Fix engine", d: "Recipe replay first, then Claude's three hypotheses race through syntax and test gates." },
  { n: "4", t: "Fix PR", d: "Patch lands on a follow-up branch, PR opens against your default." },
];

const SELF_HEALING_YML = `name: GateTest Self-Healing CI
on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]

jobs:
  heal:
    if: \${{ github.event.workflow_run.conclusion == 'failure' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npx @gatetest/cli --suite full --auto-pr
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN:      \${{ secrets.GITHUB_TOKEN }}`;

const CODE = "font-mono text-accent bg-surface-light border border-border px-1.5 py-0.5 rounded text-xs";

export default function HowItWorksPage() {
  return (
    <main>
      <PageHero
        eyebrow="Architecture, end to end"
        title="How GateTest works"
        lede={<>{TOTAL_MODULES} deterministic modules. One Claude pass when it&apos;s worth it. Zero hype.</>}
        actions={
          <>
            <Link href="/web" className="btn-cta inline-flex items-center justify-center px-6 py-3 text-sm">
              Run a free scan
            </Link>
            <a href="#pricing-tiers" className="btn-secondary inline-flex items-center justify-center px-6 py-3 text-sm">
              See the tiers
            </a>
          </>
        }
      >
        <p className="text-base text-foreground-secondary max-w-xl leading-relaxed">
          Most QA scanners are either purely pattern-matched (cheap, noisy) or purely LLM-driven (expensive,
          unpredictable). GateTest is neither. The default scan is a static engine with no AI in the loop —
          predictable, reproducible, no surprise API spend. AI is reserved for fix generation, and even there
          we try three deterministic layers first.
        </p>
      </PageHero>

      {/* 2. ARCHITECTURE DIAGRAM */}
      <Section
        id="architecture"
        title="The pipeline"
        lede="Customer push hits one of two ingress points, lands in a single Postgres queue, runs the gate, and ships a PR. The same path serves every tier — depth comes from what we layer on top, not from a different pipeline."
      >
        <div className="card p-4 sm:p-8">
          <ArchitectureDiagram />
        </div>
        <p className="text-xs text-muted mt-3 italic">
          The diagram is hand-rolled SVG. Mermaid would have required adding a dependency, and the rule on
          unapproved dependencies is hard.
        </p>
      </Section>

      {/* 3. MODULE GALLERY */}
      <Section
        id="modules-section"
        alt
        title={<>The {TOTAL_MODULES} modules</>}
        lede={
          <>
            Each module is self-contained, runs in parallel, and emits structured findings. Click a card
            to see a representative finding. Grouped by category for browsability — the actual suite
            assignment lives in <code className={CODE}>src/core/config.js</code>.
          </>
        }
      >
        <nav aria-label="Contents" className="flex flex-wrap gap-2 mb-10">
          {MODULE_CATEGORIES.map((c) => (
            <a
              key={c.id}
              href={`#modules-${c.id}`}
              className="text-xs px-3 py-1.5 rounded-full border border-border bg-surface-solid text-foreground-secondary hover:text-foreground hover:border-border-strong transition-colors"
            >
              {c.title} <span className="text-muted ml-1">{c.modules.length}</span>
            </a>
          ))}
        </nav>

        <ModuleGrid />
      </Section>

      {/* 3b. HOW WE KEEP IT QUIET — the sore points, answered in the engine
          (shipped 2026-08-18; every claim here is a tested code path) */}
      <Section
        id="quiet"
        title="How we keep it quiet"
        lede="The loudest complaint about every scanner is noise. These are not settings you tune — they are how the engine works by default."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {QUIET_RULES.map((q) => (
            <div key={q.title} className="card p-5">
              <h3 className="font-semibold text-foreground mb-1.5">{q.title}</h3>
              <p className="text-sm text-foreground-secondary leading-relaxed">{q.body}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* 4. FLYWHEEL DEEP DIVE */}
      <Section
        id="flywheel"
        alt
        title="The fix flywheel"
        lede={
          <>
            When the gate produces a finding that you&apos;ve paid to have fixed, the pipeline is Claude
            working under hard gates. The engine checks the recipe store first — a promoted recipe replays
            for free. Otherwise Claude proposes a minimal, surgical diff (on the CI path, three competing
            hypotheses in a single call). Every candidate patch must parse, and the fixed file is re-scanned:
            the original finding must be gone and nothing new raised. A no-op patch is rejected, and per-tier
            budget caps mean a fix can never cost more than you paid for it.
          </>
        }
      >
        <FlywheelTable />

        <div className="card mt-10 p-4 sm:p-6">
          <h3 className="text-base font-semibold text-foreground mb-2">Cost trend as recipes accumulate</h3>
          <p className="text-sm text-foreground-secondary mb-4 max-w-2xl leading-relaxed">
            When Claude solves something and the diff is small and templatey, the
            <code className={`mx-1 ${CODE}`}>auto-distill</code>
            step can record a recipe in your local store. A recipe replays — with Claude never called — once
            it has been confirmed enough times to be promoted to stable; an unproven patch never auto-applies.
            The chart below is the design goal: repeat shapes stop reaching Claude, so the paid-model share
            falls as promoted recipes accumulate.
          </p>
          <CostTrendChart />
        </div>
      </Section>

      {/* 5. TIERS */}
      <Section
        id="pricing-tiers"
        title="The four tiers"
        lede={
          <>
            Same engine, same modules, same queue. The tiers differ in what we layer on top of the
            base scan — and we&apos;re honest about what you don&apos;t get at each tier. &ldquo;no&rdquo; means no.
          </>
        }
      >
        <TierTable />

        <div className="mt-6 text-xs text-muted leading-relaxed max-w-3xl">
          <p>
            <span className="text-foreground-secondary font-semibold">Per-scan payment</span> at every tier. One-time charge via
            Stripe at checkout — one-time for scan tiers (no auto-renew; Continuous and MCP are monthly). If a scan fails to start or crashes mid-way,
            contact support &mdash; we re-run it or issue a credit at our discretion.
          </p>
        </div>
      </Section>

      {/* 6. SELF-HEALING CI */}
      <Section
        id="self-healing"
        alt
        title="Self-healing CI"
        lede={
          <>
            Beyond the managed scan, GateTest ships a GitHub Actions workflow that runs in <em>your</em> CI with
            <em> your</em> Anthropic key. When CI breaks, the workflow pipes the failing log through the same
            fix engine — promoted recipes replay first, then Claude proposes three competing patches that must
            survive the syntax and test gates — applies the fix, and opens a follow-up PR. Same engine, same
            recipe store, your bill on Anthropic rather than ours.
          </>
        }
      >
        <div className="rounded-2xl bg-panel border border-panel-border overflow-hidden">
          <div className="border-b border-panel-border px-4 py-2.5 flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-danger/80" aria-hidden="true" />
            <span className="w-3 h-3 rounded-full bg-warning/80" aria-hidden="true" />
            <span className="w-3 h-3 rounded-full bg-success/80" aria-hidden="true" />
            <span className="ml-2 text-xs text-panel-muted font-mono">.github/workflows/gatetest-self-healing.yml</span>
          </div>
          <pre className="p-5 text-xs sm:text-sm text-panel-foreground font-mono leading-relaxed overflow-x-auto">{SELF_HEALING_YML}</pre>
        </div>

        <ol className="mt-6 grid sm:grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
          {HEAL_STEPS.map((step) => (
            <li key={step.n} className="card p-4">
              <div className="flex items-center gap-2 mb-1">
                <span className="font-mono text-xs text-accent">{step.n}</span>
                <span className="font-semibold text-foreground text-sm">{step.t}</span>
              </div>
              <p className="text-xs text-foreground-secondary leading-relaxed">{step.d}</p>
            </li>
          ))}
        </ol>
      </Section>

      {/* 7. DATA FLOW / STACK */}
      <Section
        id="stack"
        title="The stack"
        lede={
          <>
            We deliberately keep the stack small. Every box below earns its place — no &ldquo;just in case&rdquo;
            services, no orchestration layers we don&apos;t need. The serverless rule is hard: no in-memory state
            between requests, ever.
          </>
        }
      >
        <div className="card divide-y divide-border">
          {DATA_FLOW.map((row) => (
            <div key={row.label} className="grid grid-cols-1 sm:grid-cols-[140px_1fr] gap-3 sm:gap-6 p-5 items-start">
              <div className="font-mono text-sm text-accent font-semibold">{row.label}</div>
              <p className="text-sm text-foreground-secondary leading-relaxed">{row.value}</p>
            </div>
          ))}
        </div>

        <p className="text-xs text-muted mt-4 leading-relaxed max-w-3xl">
          All scan state lives in Postgres or in Stripe&apos;s payment-intent metadata. We never write a Map or
          module-level variable that&apos;s expected to survive across requests — the function instance that
          picked up your second-page poll is not the one that ran your scan.
        </p>
      </Section>

      {/* 8. HONEST LIMITS */}
      <Section
        id="limits"
        alt
        title={<>What GateTest doesn&apos;t do (yet)</>}
        lede={
          <>
            Every QA vendor promises the moon. Here&apos;s what we don&apos;t deliver today. If any of these are
            blockers for you, the honest answer is &ldquo;not yet.&rdquo;
          </>
        }
      >
        <ul className="space-y-3">
          {LIMITS.map((limit, i) => (
            <li key={i} className="rounded-xl border border-warning/20 bg-warning/5 p-4 flex items-start gap-3">
              <span className="text-warning font-mono text-xs mt-0.5 shrink-0">
                {String(i + 1).padStart(2, "0")}
              </span>
              <p className="text-sm text-foreground-secondary leading-relaxed">{limit}</p>
            </li>
          ))}
        </ul>
      </Section>

      {/* 9. CTAs */}
      <Section
        id="cta"
        title="Run it against your code"
        lede="Architecture is just words until you see the report. The free URL scan takes well under a minute and returns a real health score against your live site."
      >
        <div className="flex flex-col sm:flex-row gap-3">
          <Link href="/web" className="btn-cta inline-flex items-center justify-center px-6 py-3.5 text-sm">
            Run a free scan now
          </Link>
          <a
            href="https://github.com/crclabs-hq/gatetest"
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary inline-flex items-center justify-center px-6 py-3.5 text-sm"
          >
            See the GitHub Action
          </a>
          <a
            href="https://github.com/crclabs-hq/gatetest/tree/main/docs/proofs"
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary inline-flex items-center justify-center px-6 py-3.5 text-sm"
          >
            Read the proof docs
          </a>
        </div>
      </Section>
    </main>
  );
}
