"use client";

import { useState, type CSSProperties } from "react";
import Link from "next/link";
// Version + module count come from the generated stats, never typed here.
// This demo line read "v1.59.0 — 121 modules" while the CLI printed v1.61.0.
import siteStats from "../data/site-stats.json";
import { defaultStats } from "../components/site/StatTiles";
import { Hero, Section, Card, Terminal } from "../components/v2";

const INSTALL_CMD = "curl -sSL https://raw.githubusercontent.com/crclabs-hq/gatetest/main/integrations/scripts/install.sh | bash";
// install.sh drops the CI workflow, hook and marker — it does NOT put a
// `gatetest` binary on PATH. The local-scan card therefore installs the CLI
// from npm first (bare `npx @gatetest/cli` does not resolve on the published
// 1.61.0; `npm i -g` and `npx -p` both do).
const CLI_INSTALL_CMD = "npm install -g @gatetest/cli";
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
  { title: "Money in floats", desc: "parseFloat() on billing amounts — sub-cent drift becomes fraud at scale. Finds it across JS + Python with safe-harbour for decimal.js / big.js.", tag: "moneyFloat" },
  { title: "Secrets + rotation age", desc: "Credentials older than 90 days flagged as error. Git-history dated, not guessed. Catches the ones that outlived the breach.", tag: "secrets" },
  { title: "Race conditions", desc: "findOne → create with no transaction or ON CONFLICT guard. The duplicate-insert bug you hit only in prod under load.", tag: "raceCondition" },
  { title: "Async-iteration bugs", desc: "forEach(async ...) — errors swallowed, events processed out of order. Also catches .filter(async) returning Promise-truthy nonsense.", tag: "asyncIteration" },
  { title: "CI supply-chain", desc: "Unpinned GitHub Actions + write-scope GITHUB_TOKEN + ${{ github.event }} shell injection. The attack chain that hits unattended CI.", tag: "ciSecurity" },
  { title: "N+1 queries", desc: "Database calls inside map/forEach/for loops across Prisma, TypeORM, Sequelize, Mongoose, Drizzle. Understands Promise.all batching.", tag: "nPlusOne" },
  { title: "Circular imports", desc: "Tarjan SCC across your full import graph. Finds the cycle that reproduces randomly depending on module-cache warmth.", tag: "importCycle" },
  { title: "Session security", desc: "httpOnly:false, secure:false, placeholder secrets. Turns XSS into session takeover. Django / Express / FastAPI all covered.", tag: "cookieSecurity" },
  { title: "Error swallowing", desc: "Empty catch blocks, .catch(noop), fire-and-forget .save() with no await. Failure becomes invisible success.", tag: "errorSwallow" },
  { title: "SSRF vectors", desc: "User input flowing into fetch() without hostname validation. Taint-tracks across assignments — not just inline calls.", tag: "ssrf" },
  { title: "ReDoS patterns", desc: "Nested quantifiers, overlapping alternation, user-controlled regex construction. Catastrophic backtracking before it hits prod.", tag: "redos" },
  { title: "Cron expression bugs", desc: "Invalid field ranges, impossible dates (Feb 30), typo aliases (@weely). The silent-failure class nobody checks.", tag: "cronExpression" },
];

const TERMINAL_LINES = [
  { t: "cmd",  text: "$ gatetest scan --suite quick --diff" },
  { t: "info", text: `  GateTest v${siteStats.version} — ${siteStats.modules.total} modules loaded` },
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

// Colour by v2 status token, not a Tailwind palette shade, so the terminal
// reads correctly in both themes without its own overrides.
const T_STYLE: Record<string, CSSProperties | undefined> = {
  cmd:  { color: "var(--v2-fg)", fontWeight: 600 },
  info: { color: "var(--v2-muted)" },
  pass: { color: "var(--v2-ok)" },
  fail: { color: "var(--v2-bad)" },
  err:  { color: "var(--v2-bad)" },
  warn: { color: "var(--v2-warn)" },
  dim:  undefined, // .term-body's own dimmed default colour
  sum:  { color: "var(--v2-fg)", fontWeight: 600 },
};

const CMD_ROW = "rounded-[var(--v2-radius-sm)] bg-[var(--v2-bg-alt)] border border-[var(--v2-line-strong)] px-4 py-3 font-mono text-xs flex items-center justify-between gap-3";

export default function DevelopersPage() {
  const modules = siteStats.modules.total;
  const stats = defaultStats();
  return (
    <main>
      <Section wrap={false}>
        <div className="v2-wrap">
          <Hero
            kicker={`${modules} modules · 6 tiers · pay per scan or subscribe`}
            title={<>The QA gate your CI is missing.</>}
            lede="GateTest catches the bug patterns that slip through code review — race conditions, money stored in floats, secrets past rotation, async-iteration footguns, CI supply-chain vectors. One gate. Real findings. Auto-fix PR on every failure."
            actions={
              <>
                <Link href="/scan/preview" className="v2-btn v2-btn-primary">Free preview scan</Link>
                <Link href="/github/setup" className="v2-btn">Install on GitHub</Link>
              </>
            }
          >
            <div className="mt-10 max-w-2xl">
              <Terminal label="gatetest scan --suite quick --diff" status={<span style={{ color: "var(--v2-bad)" }}>2 issues</span>}>
                {TERMINAL_LINES.map((l, i) =>
                  l.t === "sep" ? <div key={i} className="h-2" /> : (
                    <div key={i} style={T_STYLE[l.t]}>{l.text}</div>
                  )
                )}
              </Terminal>
            </div>
          </Hero>
        </div>
      </Section>

      <Section tight>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-8 gap-y-10">
          {stats.map((s) => (
            <div key={s.label} className="v2-stat">
              <div className="v2-stat-value v2-mono">{s.value}</div>
              <div className="v2-stat-label">{s.label}</div>
              {s.note && <div className="v2-stat-source v2-kicker">{s.note}</div>}
            </div>
          ))}
        </div>
      </Section>

      <Section>
        <div className="v2-kicker mb-3">what it catches</div>
        <h2 className="v2-h2 max-w-2xl">The patterns code review misses because they&apos;re invisible in a diff.</h2>
        <div className="mt-10 grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {CATCHES.map((c) => (
            <Card key={c.tag}>
              <div className="flex items-center gap-2 mb-3">
                <span className="font-semibold text-sm text-[var(--v2-fg)]">{c.title}</span>
                <span className="ml-auto v2-mono text-[10px] text-[var(--v2-accent)]">{c.tag}</span>
              </div>
              <p className="text-xs text-[var(--v2-muted)] leading-relaxed">{c.desc}</p>
            </Card>
          ))}
        </div>
        <p className="mt-6 v2-kicker">
          + {modules - CATCHES.length} more modules across security, CI/CD, TypeScript, async patterns, and runtime correctness.
        </p>
      </Section>

      <Section>
        <div className="v2-kicker mb-3">10 seconds, no signup</div>
        <h2 className="v2-h2 mb-10">Try it on your own repo</h2>
        <div className="grid gap-6 lg:grid-cols-2">
          <Card className="space-y-5">
            <div>
              <p className="text-sm text-[var(--v2-muted)] mb-3">
                Public repos: paste your GitHub URL into the free preview scan.
              </p>
              <Link href="/scan/preview" className="v2-btn v2-btn-primary">Open free preview</Link>
            </div>
            <div className="border-t border-[var(--v2-line)] pt-5">
              <p className="text-sm text-[var(--v2-muted)] mb-3">
                Any repo (public or private): install the CLI once, then scan locally.
              </p>
              <div className="space-y-2">
                <div className={CMD_ROW} style={{ color: "var(--v2-ok)" }}>
                  <span className="break-all"><span className="text-[var(--v2-muted)]">$ </span>{CLI_INSTALL_CMD}</span>
                  <CopyButton text={CLI_INSTALL_CMD} label="Copy" />
                </div>
                <div className={CMD_ROW} style={{ color: "var(--v2-accent)" }}>
                  <span><span className="text-[var(--v2-muted)]">$ </span>{SCAN_CMD}</span>
                  <CopyButton text={SCAN_CMD} label="Copy" />
                </div>
              </div>
              <p className="mt-2 v2-kicker">
                Requires Node 20+. Scans in memory — code never leaves your machine.
              </p>
            </div>
          </Card>

          <Card className="space-y-5">
            <div className="flex items-center justify-between gap-3">
              <span className="v2-kicker">add to CI — 30 seconds</span>
              <span className="v2-mono text-xs text-[var(--v2-accent)]">drops workflow + pre-push hook</span>
            </div>
            <p className="text-sm text-[var(--v2-muted)]">
              One command adds a GitHub Actions workflow, pre-push hook, and protection marker. Works on any public or private repo.
            </p>
            <div className={CMD_ROW} style={{ color: "var(--v2-ok)", alignItems: "flex-start" }}>
              <span className="break-all">{INSTALL_CMD}</span>
              <CopyButton text={INSTALL_CMD} />
            </div>
            <div className="grid sm:grid-cols-3 gap-3 v2-kicker">
              {[
                { label: "Workflow added", desc: ".github/workflows/gatetest-gate.yml — runs quick scan on every PR" },
                { label: "Pre-push hook", desc: ".husky/pre-push — advisory output before you push, CI is the gate" },
                { label: "Protection marker", desc: ".gatetest.json — tells AI coding agents this repo is protected" },
              ].map((item) => (
                <div key={item.label} className="rounded-[var(--v2-radius-sm)] border border-[var(--v2-line)] p-3">
                  <div className="font-semibold text-[var(--v2-fg)] mb-1 normal-case">{item.label}</div>
                  <div>{item.desc}</div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </Section>

      <Section>
        <Card className="flex flex-col sm:flex-row items-start sm:items-center gap-6">
          <div className="flex-1">
            <h3 className="font-semibold text-[var(--v2-fg)] mb-1">Private repos — install the GitHub App</h3>
            <p className="text-sm text-[var(--v2-muted)]">
              One click. Auto-scans every push and PR. Results posted as commit statuses and PR comments.
              The App is in private beta today — the curl | bash workflow above and the GitHub Action on the Marketplace run the same gate in your own CI now.
            </p>
          </div>
          <Link href="/github/setup" className="v2-btn shrink-0 whitespace-nowrap">Install GitHub App</Link>
        </Card>
        <p className="text-center mt-12">
          <Link href="/precision" className="text-sm text-[var(--v2-accent)] hover:underline">
            Measured on real repositories — see the precision numbers →
          </Link>
        </p>
      </Section>
    </main>
  );
}
