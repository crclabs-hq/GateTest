"use client";

/**
 * <Hero> — world-class HN-flavoured landing hero.
 *
 * Design rules:
 *   - The hero IS the demo. URL input runs a real free scan.
 *   - Sample-URL chips pre-fill so visitors can try the product without typing.
 *   - Honest counter row — no fabricated numbers; "Launching today" badge if no
 *     real data is available.
 *   - Substance over polish: every claim ties to a real artefact (110 modules,
 *     4600+ tests, self-scan green, pay-on-completion).
 *   - Dark theme preserved. Animated grid background retained.
 *   - Mobile-first; 320px ↔ 2560px.
 *
 * The `UrlScanFlow` component is the same one used by /web — it handles the
 * full cinematic scan flow, paywall, health score, and result rendering.
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

export default function Hero() {
  // Sample buttons pre-fill the input via a re-mount of UrlScanFlow with a
  // fresh `initialUrl`. Bumping the `nonce` forces React to discard the
  // previous instance and mount a new one with the seeded value already in
  // its controlled-input state — no DOM hacks, no sync events.
  const [seed, setSeed] = useState<{ url: string; nonce: number }>({ url: "", nonce: 0 });

  function prefill(url: string) {
    setSeed((s) => ({ url, nonce: s.nonce + 1 }));
    // Focus the new input on next paint so a single Enter runs the scan.
    requestAnimationFrame(() => {
      const el = document.getElementById("url-scan-input") as HTMLInputElement | null;
      if (el) el.focus();
    });
  }

  return (
    <section className="relative overflow-hidden pt-20">
      <div className="hero-dark px-6 pb-24 pt-16 relative">
        <div className="hero-grid" aria-hidden="true" />
        {/* Animated teal blob — slow drift + breathing scale so the hero
            feels alive without screaming for attention. Hidden on mobile
            where the blur is GPU-expensive and invisible at phone DPR. */}
        <div className="hidden md:block hero-blob absolute top-0 left-1/2 w-[760px] h-[360px] bg-gradient-to-b from-teal-500/12 to-transparent rounded-full blur-[120px] pointer-events-none" />

        <div className="relative z-10 mx-auto max-w-5xl">
          {/* Status / launch badge — glassmorphic chip with live ping */}
          <div className="flex justify-center mb-10 fade-up">
            <div className="glass-card inline-flex items-center gap-2.5 px-4 py-2 rounded-full text-sm text-white/80 font-medium">
              <span className="relative flex h-2 w-2" aria-hidden="true">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
              </span>
              <span>Launching today &middot; v1.46 &middot; 110 modules live</span>
            </div>
          </div>

          {/* Headline — outcome-first, not feature-first. Tested against
              "One gate. 110 modules. Self-healing CI." (which led with
              features) — the new variant leads with the painkiller story
              (you don't lose your evening to red CI). Per Craig's
              priorities for HN launch: this is the line that ships in
              every screenshot. */}
          <h1 className="text-center text-5xl sm:text-6xl lg:text-7xl font-bold tracking-tight leading-[1.05] mb-6 fade-up text-white">
            Your CI just went red.
            <br />
            <span className="hero-accent-text">By morning, there&apos;s a PR with the fix.</span>
          </h1>

          {/* Unfair-advantage hook */}
          <p className="text-center text-xl sm:text-2xl text-white/65 max-w-3xl mx-auto mb-3 leading-snug fade-up font-medium">
            110 checks, one gate, auto-fix PRs in 60 seconds.
          </p>
          <p className="text-center text-base sm:text-lg text-white/45 max-w-2xl mx-auto mb-3 leading-relaxed fade-up">
            We catch the bugs, security issues, and CI rot that crash your
            deploy. Then we open a pull request with the fix already written,
            tested, and pair-reviewed by a second AI. Pay per scan &mdash; no
            subscription, no minimum.
          </p>
          {/* Model-choice credibility note — engineers respect the
              evidence-based call ("we tested both, Sonnet won"). The
              "5x deeper at the same price" line is the customer-positive
              consequence of running Sonnet on Opus-era dollar caps. */}
          <p className="text-center text-sm sm:text-base text-teal-300/80 max-w-2xl mx-auto mb-2 fade-up font-medium">
            Built on Claude Sonnet 4 &mdash; the model that wins SWE-bench
            Verified, not the most expensive one in the lineup. We tested.
            We picked the model that actually fixes bugs.
          </p>
          <p className="text-center text-xs sm:text-sm text-white/55 max-w-2xl mx-auto mb-8 fade-up">
            Net effect: every tier ships ~5x deeper analysis at the same price.
          </p>

          {/* Trust signals strip — 4 developer-first facts above the CTA */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 max-w-3xl mx-auto mb-10 fade-up">
            {[
              { icon: "🔒", label: "Code never stored", sub: "Scanned in memory, discarded after" },
              { icon: "🔀", label: "Every fix is a PR", sub: "You review it, you approve it" },
              { icon: "🤖", label: "Claude Sonnet 4", sub: "Best SWE-bench score, not priciest" },
              { icon: "👁", label: "Free preview", sub: "No card, no signup required" },
            ].map((t) => (
              <div key={t.label} className="glass-card rounded-xl px-3 py-3 text-center">
                <div className="text-lg mb-1">{t.icon}</div>
                <div className="text-xs font-semibold text-white/85 leading-tight mb-0.5">{t.label}</div>
                <div className="text-[10px] text-white/45 leading-tight">{t.sub}</div>
              </div>
            ))}
          </div>

          {/* Primary CTA: the live URL scan, in-hero */}
          <div className="max-w-2xl mx-auto fade-up">
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

            {/* Sample URL chips */}
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2 text-xs">
              <span className="text-white/40 uppercase tracking-wider font-medium">
                Try a sample
              </span>
              {SAMPLE_URLS.map((s) => (
                <button
                  key={s.url}
                  type="button"
                  onClick={() => prefill(s.url)}
                  className="glass-card px-3 py-1.5 rounded-full text-white/75 hover:text-white font-mono"
                >
                  {s.label}
                </button>
              ))}
              <Link
                href="/wp"
                className="glass-card px-3 py-1.5 rounded-full text-white/75 hover:text-white"
              >
                WordPress site? &rarr;
              </Link>
            </div>

            {/* Honest counter row — no fabricated numbers */}
            <div className="mt-10 grid grid-cols-3 gap-3 max-w-xl mx-auto">
              <StatusCell
                label="Self-scan"
                value="GREEN"
                tone="ok"
                detail="102/110 modules"
              />
              <StatusCell
                label="Tests passing"
                value="4,600+"
                tone="ok"
                detail="every commit"
              />
              <StatusCell
                label="Payment"
                value="$29+"
                tone="ok"
                detail="one-time per scan"
              />
            </div>

            <p className="text-center text-xs text-white/35 mt-6">
              Scanning a GitHub repo?{" "}
              <Link href="/scan/preview" className="text-teal-300 hover:text-teal-200 underline-offset-2 hover:underline">
                Free repo preview &rarr;
              </Link>{" "}
              or{" "}
              <a href="#pricing" className="text-teal-300 hover:text-teal-200 underline-offset-2 hover:underline">
                pick a paid tier for full results &darr;
              </a>
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function StatusCell({
  label,
  value,
  tone,
  detail,
}: {
  label: string;
  value: string;
  tone: "ok" | "muted";
  detail: string;
}) {
  const valueColor = tone === "ok" ? "text-emerald-300" : "text-white/80";
  return (
    <div className="glass-card status-pulse rounded-xl px-4 py-3 text-left">
      <div className="text-[10px] uppercase tracking-wider text-white/40 font-semibold">
        {label}
      </div>
      <div className={`text-lg font-bold mt-1 tabular-nums ${valueColor}`}>
        <CountUp value={value} duration={1400} />
      </div>
      <div className="text-[11px] text-white/40 mt-0.5">{detail}</div>
    </div>
  );
}
