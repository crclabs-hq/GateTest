"use client";

import { useState } from "react";
import Link from "next/link";
// Version + module count come from the generated stats, never typed here.
// This demo line read "v1.59.0 — 121 modules" while the CLI printed v1.61.0.
import siteStats from "../data/site-stats.json";
import PageHero from "../components/site/PageHero";
import Section from "../components/site/Section";
import StatTiles from "../components/site/StatTiles";

const INSTALL_CMD = "curl -sSL https://raw.githubusercontent.com/crclabs-hq/gatetest/main/integrations/scripts/install.sh | bash";
const SCAN_CMD = "gatetest scan --suite quick --diff";

type CopyState = "idle" | "copied" | "failed";

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<CopyState>("idle");

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
      setTimeout(() => setState("idle"), 2000);
    } catch (_err) {
      setState("failed");
      setTimeout(() => setState("idle"), 2000);
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="shrink-0 flex items-center gap-1.5 text-xs text-panel-muted hover:text-accent-light transition-colors"
    >
      {state === "copied" ? (
        <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>Copied</>
      ) : state === "failed" ? (
        <>&#x2715; Failed</>
      ) : (
        <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>{label}</>
      )}
    </button>
  );
}

const CATCHES = [
  { icon: "💸", title: "Money in floats", desc: "parseFloat() on billing amounts — sub-cent drift becomes fraud at scale. Finds it across JS + Python with safe-harbour for decimal.js / big.js.", tag: "moneyFloat" },
  { icon: "🔑", title: "Secrets + rotation age", desc: "Credentials older than 90 days flagged as error. Git-history dated, not guessed. Catches the ones that outlived the breach.", tag: "secrets" },
  { icon: "⚡", title: "Race conditions", desc: "findOne → create with no transaction or ON CONFLICT guard. The duplicate-insert bug you hit only in prod under load.", tag: "raceCondition" },
  { icon: "🔁", title: "Async-iteration bugs", desc: "forEach(async ...) — errors swallowed, events processed out of order. Also catches .filter(async) returning Promise-truthy nonsense.", tag: "asyncIteration" },
  { icon: "🚨", title: "CI supply-chain", desc: "Unpinned GitHub Actions + write-scope GITHUB_TOKEN + ${{ github.event }} shell injection. The attack chain that hits unattended CI.", tag: "ciSecurity" },
  { icon: "📦", title: "N+1 queries", desc: "Database calls inside map/forEach/for loops across Prisma, TypeORM, Sequelize, Mongoose, Drizzle. Understands Promise.all batching.", tag: "nPlusOne" },
  { icon: "🌀", title: "Circular imports", desc: "Tarjan SCC across your full import graph. Finds the cycle that reproduces randomly depending on module-cache warmth.", tag: "importCycle" },
  { icon: "🍪", title: "Session security", desc: "httpOnly:false, secure:false, placeholder secrets. Turns XSS into session takeover. Django / Express / FastAPI all covered.", tag: "cookieSecurity" },
  { icon: "🔥", title: "Error swallowing", desc: "Empty catch blocks, .catch(noop), fire-and-forget .save() with no await. Failure becomes invisible success.", tag: "errorSwallow" },
  { icon: "📡", title: "SSRF vectors", desc: "User input flowing into fetch() without hostname validation. Taint-tracks across assignments — not just inline calls.", tag: "ssrf" },
  { icon: "💾", title: "ReDoS patterns", desc: "Nested quantifiers, overlapping alternation, user-controlled regex construction. Catastrophic backtracking before it hits prod.", tag: "redos" },
  { icon: "⏰", title: "Cron expression bugs", desc: "Invalid field ranges, impossible dates (Feb 30), typo aliases (@weely). The silent-failure class nobody checks.", tag: "cronExpression" },
];

const TERMINAL_LINES = [
  { t: "cmd",  text: "$ gatetest scan --suite quick --diff" },
  { t: "info", text: `  GateTest v${siteStats.version} — ${siteStats.modules.total} modules, Claude Sonnet 5` },
  { t: "info", text: "  Scanning 14 changed files vs main..." },
  { t: "pass", text: "  [PASS] syntax" },
  { t: "pass", text: "  [PASS] lint" },
  { t: "fail", text: "  [FAIL] secrets        — 2 issues" },
  { t: "fail", text: "  [FAIL] asyncIteration — 1 issue" },
  { t: "sep",  text: "" },
  { t: "err",  text: "  ERR  secrets › src/billing/stripe.ts:47" },
  { t: "dim",  text: "       STRIPE_SECRET_KEY older than 90 days — rotate now" },
  { t: "err",  text: "  ERR  secrets › .github/workflows/deploy.yml:12" },
  { t: "dim",  text: "       Unpinned action + write GITHUB_TOKEN + shell injection" },
  { t: "warn", text: "  WARN asyncIteration › src/jobs/process.ts:83" },
  { t: "dim",  text: "       forEach(async ...) — errors swallowed, events out of order" },
  { t: "sep",  text: "" },
  { t: "sum",  text: "  3 issues · 2 errors · 1 warning · 8.3s" },
];

const T_CLR: Record<string, string> = {
  cmd:  "text-panel-foreground font-semibold",
  info: "text-panel-muted",
  pass: "text-emerald-400",
  fail: "text-red-400",
  err:  "text-red-300",
  warn: "text-amber-300",
  dim:  "text-panel-muted",
  sum:  "text-panel-foreground font-semibold",
  sep:  "block h-3",
};

const PANEL = "rounded-xl bg-panel text-panel-foreground border border-panel-border overflow-hidden";
const PANEL_HEAD = "flex items-center gap-1.5 px-4 py-3 border-b border-panel-border bg-panel-alt";
const CMD_ROW = "rounded-lg bg-panel border border-panel-border px-4 py-3 font-mono text-xs flex items-center justify-between gap-3";

function TerminalDots() {
  return (
    <>
      <div className="w-3 h-3 rounded-full bg-danger/80" />
      <div className="w-3 h-3 rounded-full bg-warning/80" />
      <div className="w-3 h-3 rounded-full bg-success/80" />
    </>
  );
}

export default function DevelopersPage() {
  const modules = siteStats.modules.total;
  return (
    <main>
      <PageHero
        eyebrow={`${modules} modules · 6 tiers · pay per scan or subscribe`}
        title={<>The QA gate<br />your CI is <span className="text-accent">missing.</span></>}
        lede="GateTest catches the bug patterns that slip through code review — race conditions, money stored in floats, secrets past rotation, async-iteration footguns, CI supply-chain vectors. One gate. Real findings. Auto-fix PR on every failure."
        actions={
          <>
            <Link href="/scan/preview" className="btn-cta px-6 py-3 text-sm font-semibold rounded-xl">Free preview scan →</Link>
            <Link href="/github/setup" className="btn-secondary px-6 py-3 text-sm font-semibold rounded-xl">Install on GitHub</Link>
          </>
        }
      >
        <div className={`${PANEL} shadow-lg`}>
          <div className={PANEL_HEAD}>
            <TerminalDots />
            <span className="ml-3 text-xs text-panel-muted font-mono">terminal</span>
          </div>
          <div className="p-5 font-mono text-xs space-y-1 overflow-x-auto">
            {TERMINAL_LINES.map((l, i) =>
              l.t === "sep" ? <div key={i} className="h-2" /> : (
                <div key={i} className={`whitespace-pre ${T_CLR[l.t]}`}>{l.text}</div>
              )
            )}
          </div>
        </div>
      </PageHero>

      <Section>
        <StatTiles />
      </Section>

      <Section alt title="What it catches" lede="The patterns code review misses because they're invisible in a diff.">
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {CATCHES.map((c) => (
            <div key={c.tag} className="card p-5">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xl">{c.icon}</span>
                <span className="font-semibold text-sm text-foreground">{c.title}</span>
                <span className="ml-auto text-[10px] font-mono text-accent">{c.tag}</span>
              </div>
              <p className="text-xs text-muted leading-relaxed">{c.desc}</p>
            </div>
          ))}
        </div>
        <p className="mt-6 text-xs text-muted text-center">
          + {modules - CATCHES.length} more modules across security, CI/CD, TypeScript, async patterns, and runtime correctness.
        </p>
      </Section>

      <Section title="Try it on your own repo" lede="10 seconds, no signup.">
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="card p-6 space-y-5">
            <div>
              <p className="text-sm text-foreground-secondary mb-3">
                Public repos: paste your GitHub URL into the free preview scan.
              </p>
              <Link href="/scan/preview" className="btn-cta inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-xl">
                Open free preview →
              </Link>
            </div>
            <div className="border-t border-border pt-5">
              <p className="text-sm text-foreground-secondary mb-3">
                Any repo (public or private): install the CLI once, then scan locally.
              </p>
              <div className="space-y-2">
                <div className={`${CMD_ROW} text-emerald-300`}>
                  <span className="break-all"><span className="text-panel-muted">$ </span>{INSTALL_CMD}</span>
                  <CopyButton text={INSTALL_CMD} label="Copy" />
                </div>
                <div className={`${CMD_ROW} text-accent-light`}>
                  <span><span className="text-panel-muted">$ </span>{SCAN_CMD}</span>
                  <CopyButton text={SCAN_CMD} label="Copy" />
                </div>
              </div>
              <p className="mt-2 text-xs text-muted">
                Requires Node 20+. Scans in memory — code never leaves your machine.
              </p>
            </div>
          </div>

          <div className="card p-6 space-y-5">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-mono text-muted">add to CI — 30 seconds</span>
              <span className="text-xs font-mono text-accent">drops workflow + pre-push hook</span>
            </div>
            <p className="text-sm text-foreground-secondary">
              One command adds a GitHub Actions workflow, pre-push hook, and protection marker. Works on any public or private repo.
            </p>
            <div className={`${CMD_ROW} text-emerald-300 items-start`}>
              <span className="break-all">{INSTALL_CMD}</span>
              <CopyButton text={INSTALL_CMD} />
            </div>
            <div className="grid sm:grid-cols-3 gap-3 text-xs text-muted">
              {[
                { label: "Workflow added", desc: ".github/workflows/gatetest-gate.yml — runs quick scan on every PR" },
                { label: "Pre-push hook", desc: ".husky/pre-push — advisory output before you push, CI is the gate" },
                { label: "Protection marker", desc: ".gatetest.json — tells Claude sessions this repo is protected" },
              ].map((item) => (
                <div key={item.label} className="rounded-lg section-alt border border-border p-3">
                  <div className="font-semibold text-foreground mb-1">{item.label}</div>
                  <div>{item.desc}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Section>

      <Section alt>
        <div className="card p-8 flex flex-col sm:flex-row items-start sm:items-center gap-6">
          <div className="flex-1">
            <h3 className="font-display font-semibold text-foreground mb-1">Private repos — install the GitHub App</h3>
            <p className="text-sm text-muted">
              One click. Auto-scans every push and PR. Results posted as commit statuses and PR comments. Findings show as inline annotations in the diff.
            </p>
          </div>
          <Link href="/github/setup" className="btn-secondary shrink-0 px-5 py-2.5 text-sm font-semibold rounded-xl whitespace-nowrap">
            Install GitHub App →
          </Link>
        </div>
        <div className="text-center mt-12">
          <Link href="/precision" className="text-sm text-accent hover:underline">
            Measured on real repositories — see the precision numbers →
          </Link>
        </div>
      </Section>
    </main>
  );
}
