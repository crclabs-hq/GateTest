"use client";

import { useState } from "react";
import Link from "next/link";

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
      className="shrink-0 flex items-center gap-1.5 text-xs text-white/40 hover:text-teal-400 transition-colors"
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
  { t: "info", text: "  GateTest v1.46.0 — 110 modules, Claude Sonnet 4.6" },
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
  cmd:  "text-white font-semibold",
  info: "text-white/40",
  pass: "text-emerald-400",
  fail: "text-red-400",
  err:  "text-red-300",
  warn: "text-amber-300",
  dim:  "text-white/45",
  sum:  "text-white/70 font-semibold",
  sep:  "block h-3",
};

export default function DevelopersPage() {
  return (
    <main className="min-h-screen bg-[#0d1117] text-white">

      {/* Nav */}
      <nav className="border-b border-white/[0.06] px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-md bg-teal-600 flex items-center justify-center">
              <span className="text-white font-bold text-xs font-mono">G</span>
            </div>
            <span className="text-base font-bold tracking-tight">Gate<span className="text-teal-400">Test</span></span>
          </Link>
          <div className="flex items-center gap-5 text-sm text-white/50">
            <Link href="/scan/preview" className="hover:text-white transition-colors">Free Preview</Link>
            <Link href="/scans" className="hover:text-white transition-colors">Hall of Scans</Link>
            <Link href="/github/setup" className="hover:text-teal-400 transition-colors">Install GitHub App</Link>
            <Link href="/#pricing" className="px-4 py-1.5 rounded-lg bg-teal-600 text-white text-xs font-semibold hover:bg-teal-500 transition-colors">Pricing</Link>
          </div>
        </div>
      </nav>

      <div className="max-w-5xl mx-auto px-6 py-16">

        {/* Hero */}
        <div className="mb-20 grid lg:grid-cols-2 gap-12 items-center">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-teal-500/10 border border-teal-500/20 text-xs text-teal-400 font-medium mb-6">
              <span className="w-1.5 h-1.5 rounded-full bg-teal-400 animate-pulse" />
              110 modules · 4 tiers · no subscription
            </div>
            <h1 className="text-4xl sm:text-5xl font-bold mb-4 leading-tight">
              The QA gate<br />your CI is{" "}
              <span className="text-teal-400">missing.</span>
            </h1>
            <p className="text-white/55 text-lg leading-relaxed mb-8">
              GateTest catches the bug patterns that slip through code review — race conditions, money stored in floats, secrets past rotation, async-iteration footguns, CI supply-chain vectors. One gate. Real findings. Auto-fix PR on every failure.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link href="/scan/preview" className="px-6 py-3 rounded-xl bg-teal-600 text-white font-semibold text-sm hover:bg-teal-500 transition-colors">
                Free preview scan →
              </Link>
              <Link href="/github/setup" className="px-6 py-3 rounded-xl border border-white/15 text-white/70 font-semibold text-sm hover:bg-white/[0.04] hover:text-white transition-all">
                Install on GitHub
              </Link>
            </div>
          </div>

          {/* Terminal */}
          <div className="rounded-xl bg-[#161b22] border border-white/[0.08] overflow-hidden shadow-2xl">
            <div className="flex items-center gap-1.5 px-4 py-3 border-b border-white/[0.06] bg-white/[0.02]">
              <div className="w-3 h-3 rounded-full bg-[#ff5f57]" />
              <div className="w-3 h-3 rounded-full bg-[#febc2e]" />
              <div className="w-3 h-3 rounded-full bg-[#28c840]" />
              <span className="ml-3 text-xs text-white/30 font-mono">terminal</span>
            </div>
            <div className="p-5 font-mono text-xs space-y-1">
              {TERMINAL_LINES.map((l, i) =>
                l.t === "sep" ? <div key={i} className="h-2" /> : (
                  <div key={i} className={T_CLR[l.t]}>{l.text}</div>
                )
              )}
            </div>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-20">
          {[
            { v: "1,564", l: "real issues found" },
            { v: "9",     l: "critical attack chains" },
            { v: "110",   l: "modules" },
            { v: "<30s",  l: "quick scan" },
          ].map((s) => (
            <div key={s.l} className="rounded-xl bg-[#161b22] border border-white/[0.08] p-5 text-center">
              <div className="text-3xl font-bold font-mono text-teal-400 mb-1">{s.v}</div>
              <div className="text-xs text-white/35 uppercase tracking-wider">{s.l}</div>
            </div>
          ))}
        </div>

        {/* What it catches */}
        <div className="mb-20">
          <div className="mb-8">
            <h2 className="text-2xl font-bold mb-2">What it catches</h2>
            <p className="text-white/50 text-sm">The patterns code review misses because they&apos;re invisible in a diff.</p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {CATCHES.map((c) => (
              <div key={c.tag} className="rounded-xl bg-[#161b22] border border-white/[0.08] p-5 hover:border-teal-500/30 transition-colors">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-xl">{c.icon}</span>
                  <span className="font-semibold text-sm text-white">{c.title}</span>
                  <span className="ml-auto text-[10px] font-mono text-teal-400/70">{c.tag}</span>
                </div>
                <p className="text-xs text-white/45 leading-relaxed">{c.desc}</p>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs text-white/30 text-center">
            + 98 more modules across security, CI/CD, TypeScript, async patterns, and runtime correctness.
          </p>
        </div>

        {/* npx / local scan */}
        <div className="mb-20 rounded-xl bg-[#161b22] border border-white/[0.08] overflow-hidden">
          <div className="px-5 py-3 border-b border-white/[0.06] bg-white/[0.02] flex items-center justify-between">
            <span className="text-xs font-mono text-white/50">try it on your own repo — 10 seconds, no signup</span>
          </div>
          <div className="p-6 space-y-5">
            <div>
              <p className="text-sm text-white/60 mb-3">
                Public repos: paste your GitHub URL into the free preview scan.
              </p>
              <Link href="/scan/preview" className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-teal-600 text-white font-semibold text-sm hover:bg-teal-500 transition-colors">
                Open free preview →
              </Link>
            </div>
            <div className="border-t border-white/[0.06] pt-5">
              <p className="text-sm text-white/60 mb-3">
                Any repo (public or private): install the CLI once, then scan locally.
              </p>
              <div className="space-y-2">
                <div className="rounded-lg bg-black/40 border border-white/[0.06] px-4 py-3 font-mono text-xs text-emerald-300 flex items-center justify-between gap-3">
                  <span className="break-all"><span className="text-white/30">$ </span>{INSTALL_CMD}</span>
                  <CopyButton text={INSTALL_CMD} label="Copy" />
                </div>
                <div className="rounded-lg bg-black/40 border border-white/[0.06] px-4 py-3 font-mono text-xs text-teal-300 flex items-center justify-between gap-3">
                  <span><span className="text-white/30">$ </span>{SCAN_CMD}</span>
                  <CopyButton text={SCAN_CMD} label="Copy" />
                </div>
              </div>
              <p className="mt-2 text-xs text-white/30">
                Requires Node 20+. Scans in memory — code never leaves your machine.
              </p>
            </div>
          </div>
        </div>

        {/* CI install */}
        <div className="mb-20 rounded-xl bg-[#161b22] border border-white/[0.08] overflow-hidden">
          <div className="px-5 py-3 border-b border-white/[0.06] bg-white/[0.02] flex items-center justify-between">
            <span className="text-xs font-mono text-white/50">add to CI — 30 seconds</span>
            <span className="text-xs font-mono text-teal-400/70">drops workflow + pre-push hook</span>
          </div>
          <div className="p-6 space-y-5">
            <p className="text-sm text-white/60">
              One command adds a GitHub Actions workflow, pre-push hook, and protection marker. Works on any public or private repo.
            </p>
            <div className="rounded-lg bg-black/40 border border-white/[0.06] px-4 py-3 font-mono text-xs text-emerald-300 flex items-start justify-between gap-3">
              <span className="break-all">{INSTALL_CMD}</span>
              <CopyButton text={INSTALL_CMD} />
            </div>
            <div className="grid sm:grid-cols-3 gap-3 text-xs text-white/50">
              {[
                { label: "Workflow added", desc: ".github/workflows/gatetest-gate.yml — runs quick scan on every PR" },
                { label: "Pre-push hook", desc: ".husky/pre-push — advisory output before you push, CI is the gate" },
                { label: "Protection marker", desc: ".gatetest.json — tells Claude sessions this repo is protected" },
              ].map((item) => (
                <div key={item.label} className="rounded-lg bg-white/[0.03] border border-white/[0.06] p-3">
                  <div className="font-semibold text-white/70 mb-1">{item.label}</div>
                  <div>{item.desc}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* GitHub App (private repos) */}
        <div className="mb-16 rounded-xl bg-white/[0.03] border border-teal-500/20 p-8 flex flex-col sm:flex-row items-start sm:items-center gap-6">
          <div className="flex-1">
            <h3 className="font-semibold text-white mb-1">Private repos — install the GitHub App</h3>
            <p className="text-sm text-white/50">
              One click. Auto-scans every push and PR. Results posted as commit statuses and PR comments. Findings show as inline annotations in the diff.
            </p>
          </div>
          <Link href="/github/setup" className="shrink-0 px-5 py-2.5 rounded-xl border border-teal-500/40 text-teal-400 font-semibold text-sm hover:bg-teal-500/10 transition-colors whitespace-nowrap">
            Install GitHub App →
          </Link>
        </div>

        {/* Proof */}
        <div className="text-center">
          <p className="text-xs text-white/30 mb-2">
            Real scans. Real repos. No cherry-picked data.
          </p>
          <Link href="/scans" className="text-sm text-teal-400 hover:underline">
            Hall of Scans — see what GateTest found in production codebases →
          </Link>
        </div>

      </div>
    </main>
  );
}
