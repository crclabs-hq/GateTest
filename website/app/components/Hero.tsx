"use client";

/**
 * <Hero> — premium editorial landing hero (Klaviyo-tier prototype).
 *
 * Design language:
 *   - Warm cream canvas (.hero-warm) instead of the old dark slab.
 *   - Editorial display type (.font-display, Bricolage Grotesque) for the
 *     headline — the single biggest "premium brand" lever.
 *   - Two columns on desktop: outcome-first headline + live URL-scan CTA on
 *     the left, a polished dark product card (the auto-fix PR moment) on the
 *     right. Stacks on mobile.
 *   - Honesty preserved: every number is real (module count, tests passing,
 *     self-scan green, pay-per-scan). No fabricated logos or customers.
 *     The numbers are NOT hardcoded — they're read from
 *     website/app/data/site-stats.json, which scripts/generate-site-stats.js
 *     regenerates from a real `node --test` run + `gatetest --list` + the
 *     flywheel telemetry. Displayed counts are rounded DOWN, so the public
 *     "N+" claim is always an under-statement. The dogfood-nightly workflow
 *     re-runs the generator every night and opens a PR with the diff.
 *
 * The `UrlScanFlow` component is the same one used by /web — it runs the real
 * free scan, paywall, health score, and result rendering.
 */

import Link from "next/link";
import HeroScanTabs from "./HeroScanTabs";
import CountUp from "./CountUp";
import LiveStats from "./LiveStats";
import siteStats from "../data/site-stats.json";
import precision from "../data/precision.json";

// The corpus size in the headline is READ from the same file /precision
// renders — never typed (doctrine §7). Repos with a ceiling are the precision
// set; the recall floor (NodeGoat) is not a "real repository we scan clean".
const CORPUS_SIZE = precision.repos.filter((r) => typeof r.ceiling === "number").length;

// Honest positioning: the fragmented tools one GateTest gate replaces.
const REPLACES = ["SonarQube", "Snyk", "ESLint", "Semgrep", "CodeQL", "DeepSource"];

export default function Hero() {
  return (
    <section className="hero-warm relative overflow-hidden">

      <div className="relative z-10 mx-auto max-w-7xl px-6 pb-12 pt-14">
        <div className="grid lg:grid-cols-[1.05fr_0.95fr] gap-12 lg:gap-10 items-center">

          {/* ── LEFT: editorial headline + live CTA ───────────────────── */}
          <div className="max-w-2xl">
            <div className="inline-flex items-center gap-2.5 text-[13px] font-mono text-gray-600 mb-7 fade-up">
              <span className="relative flex h-2 w-2" aria-hidden="true">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
              <span>Live in beta &middot; {siteStats.modules.total} modules in the gate</span>
            </div>

            <h1 className="font-display text-[2.4rem] leading-[1.06] sm:text-5xl lg:text-[3.5rem] font-semibold text-gray-900 mb-6 fade-up" style={{ textWrap: "balance" }}>
              The gate that{" "}
              <span className="text-[#0f766e]">doesn&apos;t cry wolf.</span>
            </h1>

            <p className="text-lg sm:text-xl text-gray-600 leading-relaxed mb-3 fade-up">
              Measured on {CORPUS_SIZE} real repositories, the bad numbers published.{" "}
              {siteStats.modules.total} checks in one gate: it blocks on your new code, not your
              backlog, says what it didn&apos;t check, and opens the pull request with the fix
              already written, tested, and pair-reviewed by a second AI.
            </p>
            <p className="text-base text-gray-500 mb-8 fade-up">
              Pay per scan &mdash; no seat licences, no minimum. AI-powered fixes &mdash;{" "}
              <span className="font-semibold text-gray-700">deeper analysis on the fix tiers</span>, the deterministic engine everywhere else.
            </p>

            {/* One action, three audiences: repository, website, WordPress. */}
            <div className="fade-up">
              <HeroScanTabs />
            </div>
          </div>

          {/* ── RIGHT: real scanner output. Captured 2026-09-22 from
              `gatetest --suite quick --project reliability-corpus/known-bad/sqli-string-concat`
              (exit 1). Trimmed to the lines that decide the gate; nothing invented. */}
          <div className="relative fade-up">
            <div className="product-card p-0 overflow-hidden">
              <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-white/[0.08]">
                <span className="font-mono text-[12px] text-white/60 truncate">
                  $ npx -p @gatetest/cli gatetest --suite quick
                </span>
                <span className="font-mono text-[11px] text-red-300/90 shrink-0">exit 1</span>
              </div>
              <pre className="px-4 py-4 font-mono text-[12.5px] leading-[1.55] text-white/80 overflow-x-auto whitespace-pre">
{`  [RUN] crossFileTaint  [FAIL]  (2 errors, 18ms)
  ----------------------------------------
  GATE: BLOCKED
  Checks:   62/67 passed
  Errors:   2
  Warnings: 3
  Time:     1608ms

  What's blocking you
  ✗ src/handler.js:12
      Taint: \`q\` (from request input) reaches
      \`sql-query\` sink without sanitisation
      wrong? add to .gatetestignore:
      crossFileTaint@src/handler.js`}
              </pre>
              <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 py-2.5 border-t border-white/[0.08] font-mono text-[11px] text-white/45">
                <span>67 checks · 42 modules · quick suite</span>
                <span>SARIF, JUnit, JSON via --format</span>
              </div>
            </div>
            <p className="mt-3 font-mono text-[11px] text-gray-500 leading-relaxed">
              Real run, 2026-09-22, on reliability-corpus/known-bad/sqli-string-concat. Exit code 1 fails the CI job; the same finding is posted as a commit status and PR comment by the App.
            </p>
          </div>
        </div>

        {/* ── "Replaces" strip — honest social proof in lieu of logos ── */}
        <div className="mt-12 fade-up">
          <div className="flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-6">
            <span className="text-xs uppercase tracking-[0.18em] text-gray-400 font-semibold shrink-0">
              One gate replaces
            </span>
            <div className="flex flex-wrap items-center gap-2.5">
              {REPLACES.map((tool) => (
                <span key={tool} className="font-mono text-[13px] text-gray-600">
                  {tool}
                </span>
              ))}
              <span className="text-sm text-gray-400">+ 6 more</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Live social proof — only renders when DB has real data ── */}
      <div className="mx-auto max-w-7xl px-6 pb-4">
        <LiveStats />
      </div>

      {/* ── Bold full-bleed stats band — our answer to Klaviyo's green band ── */}
      <div className="stats-band relative z-10">
        <div className="mx-auto max-w-7xl px-6 py-8 grid grid-cols-2 md:grid-cols-4 gap-y-7 gap-x-6">
          <BandStat num={siteStats.tests.displayPassing} label="tests passing, every commit" />
          <BandStat num={String(siteStats.modules.total)} label="modules in the engine" />
          {siteStats.modules.greenSource === "measured"
            ? <BandStat num={siteStats.modules.displayGreen} label="green on our own repo · nightly full suite" />
            : <BandStat num="1" label="gate · one decision per push" />}
          <BandStat num="$29+" label="per scan · no seat licences" />
        </div>
      </div>
    </section>
  );
}

function BandStat({ num, label }: { num: string; label: string }) {
  return (
    <div>
      <div className="stat-num text-3xl sm:text-4xl lg:text-5xl font-extrabold tabular-nums leading-none text-white">
        <CountUp value={num} duration={1400} />
      </div>
      <div className="text-[13px] sm:text-sm font-medium text-teal-300/75 mt-2">{label}</div>
    </div>
  );
}
