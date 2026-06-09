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
 *   - Honesty preserved: every number is real (110 modules, 4,600+ tests,
 *     self-scan green, pay-per-scan). No fabricated logos or customers.
 *
 * The `UrlScanFlow` component is the same one used by /web — it runs the real
 * free scan, paywall, health score, and result rendering.
 */

import { useState } from "react";
import Link from "next/link";
import { UrlScanFlow } from "./UrlScanFlow";
import CountUp from "./CountUp";

const SAMPLE_URLS = [
  { label: "example.com", url: "https://example.com" },
  { label: "nextjs.org", url: "https://nextjs.org" },
  { label: "vercel.com", url: "https://vercel.com" },
];

// Honest positioning: the fragmented tools one GateTest gate replaces.
const REPLACES = ["SonarQube", "Snyk", "ESLint", "Semgrep", "CodeQL", "DeepSource"];

export default function Hero() {
  const [seed, setSeed] = useState<{ url: string; nonce: number }>({ url: "", nonce: 0 });

  function prefill(url: string) {
    setSeed((s) => ({ url, nonce: s.nonce + 1 }));
    requestAnimationFrame(() => {
      const el = document.getElementById("url-scan-input") as HTMLInputElement | null;
      if (el) el.focus();
    });
  }

  return (
    <section className="hero-warm relative overflow-hidden pt-20">
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
              <span>Launching today &middot; 110 modules live</span>
            </div>

            <h1 className="font-display text-[2.7rem] leading-[1.04] sm:text-6xl lg:text-[4.1rem] font-extrabold text-gray-900 mb-6 fade-up">
              Your CI just went red.
              <br />
              Minutes later, there&apos;s{" "}
              <span className="text-[#0f766e]">a PR with the fix.</span>
            </h1>

            <p className="text-lg sm:text-xl text-gray-600 leading-relaxed mb-3 fade-up">
              110 checks. One gate. We catch the bug, security hole, or CI rot
              that crashes your deploy &mdash; then open a pull request with the
              fix already written, tested, and pair-reviewed by a second AI.
            </p>
            <p className="text-base text-gray-500 mb-8 fade-up">
              Pay per scan &mdash; no subscription, no minimum. Built on{" "}
              <span className="font-semibold text-gray-700">Claude Sonnet 4.6</span>.
            </p>

            {/* Live URL scan — the real product, in-hero */}
            <div className="fade-up">
              <UrlScanFlow
                key={seed.nonce}
                suite="web"
                endpoint="/api/web/scan"
                streamEndpoint="/api/web/scan/stream"
                recommendEndpoint="/api/scan/recommend"
                placeholderUrl="https://yoursite.com — free preview, no signup"
                brandLabel="GateTest"
                initialUrl={seed.url}
              />

              <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
                <span className="text-gray-400 uppercase tracking-wider font-semibold">
                  Try a sample
                </span>
                {SAMPLE_URLS.map((s) => (
                  <button
                    key={s.url}
                    type="button"
                    onClick={() => prefill(s.url)}
                    className="replace-pill px-3 py-1.5 rounded-full text-gray-600 hover:text-gray-900 hover:border-[#0f766e]/30 transition-colors font-mono"
                  >
                    {s.label}
                  </button>
                ))}
                <Link
                  href="/github/setup"
                  className="replace-pill px-3 py-1.5 rounded-full text-gray-600 hover:text-gray-900 hover:border-[#0f766e]/30 transition-colors"
                >
                  Scan a repo &rarr;
                </Link>
              </div>
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
                <div className="url-bar flex-1 flex items-center gap-2 rounded-md px-3 py-1.5 text-[11px] font-mono text-white/45 truncate">
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

            {/* floating KPI chip for depth */}
            <div className="product-chip hidden sm:flex items-center gap-2.5 absolute -bottom-5 -left-5 px-4 py-3 rounded-xl">
              <div className="text-2xl font-extrabold text-[#0f766e] tabular-nums leading-none">
                <CountUp value="102" duration={1400} />/110
              </div>
              <div className="text-[11px] text-gray-500 leading-tight">
                modules green<br />on our own repo
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

      {/* ── Bold full-bleed stats band — our answer to Klaviyo's green band ── */}
      <div className="stats-band relative z-10">
        <div className="mx-auto max-w-7xl px-6 py-8 grid grid-cols-2 md:grid-cols-4 gap-y-7 gap-x-6">
          <BandStat num="4,600+" label="tests passing, every commit" />
          <BandStat num="110" label="modules in one gate" />
          <BandStat num="102/110" label="green on our own repo" />
          <BandStat num="$29+" label="per scan · no subscription" />
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
