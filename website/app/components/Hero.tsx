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
      <div className="hero-aurora" aria-hidden="true" />
      <div className="hero-warm-grid" aria-hidden="true" />

      <div className="relative z-10 mx-auto max-w-7xl px-6 pb-12 pt-14">
        <div className="grid lg:grid-cols-[1.05fr_0.95fr] gap-12 lg:gap-10 items-center">

          {/* ── LEFT: editorial headline + live CTA ───────────────────── */}
          <div className="max-w-2xl">
            <div className="inline-flex items-center gap-2.5 px-3.5 py-1.5 rounded-full bg-white/70 border border-black/5 text-sm font-medium text-gray-700 mb-7 fade-up shadow-sm">
              <span className="relative flex h-2 w-2" aria-hidden="true">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
              <span>Live in beta &middot; {siteStats.modules.total} modules in the gate</span>
            </div>

            <h1 className="font-display text-[2.7rem] leading-[1.04] sm:text-6xl lg:text-[4.1rem] font-extrabold text-gray-900 mb-6 fade-up" style={{ textWrap: "balance" }}>
              The gate that{" "}
              <span className="text-[#0f766e]">doesn&apos;t cry wolf.</span>
            </h1>

            <p className="text-lg sm:text-xl text-gray-600 leading-relaxed mb-3 fade-up">
              Measured on {CORPUS_SIZE} real repositories, the bad numbers published.
              {siteStats.modules.total} checks in one gate: it blocks on your new code, not your
              backlog, says what it didn&apos;t check, and opens the pull request with the fix
              already written, tested, and pair-reviewed by a second AI.
            </p>
            <p className="text-base text-gray-500 mb-8 fade-up">
              Pay per scan &mdash; no seat licences, no minimum. Built on{" "}
              <span className="font-semibold text-gray-700">Claude</span> &mdash; Fable 5 on the fix tiers, Sonnet 5 everywhere else.
            </p>

            {/* One action, three audiences: repository, website, WordPress. */}
            <div className="fade-up">
              <HeroScanTabs />
            </div>
          </div>

          {/* ── RIGHT: polished auto-fix PR product card ──────────────── */}
          <div className="relative fade-up">
            <div className="product-card browser-frame card-float p-1.5">
              {/* browser chrome with URL bar — reads as a real screenshot */}
              <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.06]">
                <div className="flex items-center gap-2 shrink-0">
                  <span className="h-3 w-3 rounded-full bg-red-400/80" />
                  <span className="h-3 w-3 rounded-full bg-amber-400/80" />
                  <span className="h-3 w-3 rounded-full bg-emerald-400/80" />
                </div>
                {/* min-w-0: without it this flex item's minimum width is the full URL text,
                    which made the whole hero column 487px on a 390px phone — the section's
                    overflow-hidden hid it from the page-width check (2026-09-10). */}
                <div className="url-bar flex-1 w-0 min-w-0 flex items-center gap-2 rounded-md px-3 py-1.5 text-[11px] font-mono text-white/45 truncate">
                  <span className="text-emerald-400/70" aria-hidden="true">&#128274;</span>
                  github.com/your-org/your-repo
                  <span className="text-white/25">/pull/248</span>
                </div>
                <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/25 shrink-0">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  Gate green
                </span>
              </div>

              {/* PR body */}
              <div className="px-5 py-5">
                <div className="text-xs font-mono text-white/40 mb-1">pull request #248</div>
                <div className="text-[15px] font-semibold text-white mb-4">
                  fix: define <span className="text-teal-300">resolveTenantCapForHotPath</span>
                </div>

                <div className="rounded-lg bg-black/40 border border-white/[0.06] p-4 font-mono text-[12.5px] leading-relaxed overflow-hidden">
                  <div className="text-white/30">apps/api/src/cdn/handler.ts</div>
                  <div className="mt-2 text-red-300/90">
                    <span className="text-red-400/60">- </span>ReferenceError: not defined
                  </div>
                  <div className="text-emerald-300/90">
                    <span className="text-emerald-400/60">+ </span>import {"{ resolveTenantCapForHotPath }"}
                  </div>
                  <div className="text-emerald-300/90">
                    <span className="text-emerald-400/60">+ </span>&nbsp;&nbsp;from &quot;./quotas&quot;;
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 text-[11.5px] text-white/55">
                  <span>✓ 1 regression test added</span>
                  <span>✓ pair-reviewed</span>
                  <span>✓ 38s · ~$0.02</span>
                </div>
              </div>
            </div>

            {/* floating KPI chip for depth — the green count is shown ONLY when
                the nightly self-scan measured it (greenSource "measured");
                a carried number is not a stat (2026-08-18 audit). */}
            <div className="product-chip hidden sm:flex items-center gap-2.5 absolute -bottom-5 -left-5 px-4 py-3 rounded-xl">
              <div className="text-2xl font-extrabold text-[#0f766e] tabular-nums leading-none">
                {siteStats.modules.greenSource === "measured"
                  ? <><CountUp value={String(siteStats.modules.green)} duration={1400} />/{siteStats.modules.scanned}</>
                  : <><CountUp value={String(siteStats.modules.total)} duration={1400} /></>}
              </div>
              <div className="text-[11px] text-gray-500 leading-tight">
                {siteStats.modules.greenSource === "measured" ? <>modules green<br />on our own repo</> : <>modules loaded<br />every commit</>}
              </div>
            </div>
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
                <span
                  key={tool}
                  className="replace-pill px-3.5 py-1.5 rounded-full text-sm font-medium text-gray-600"
                >
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
          <BandStat num={String(siteStats.modules.total)} label="modules in one gate" />
          {siteStats.modules.greenSource === "measured"
            ? <BandStat num={siteStats.modules.displayGreen} label="green on our own repo" />
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
