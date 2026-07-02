"use client";

/**
 * <Hero> — GateTest landing hero.
 *
 * Design: Linear/Stripe B2B tone. Solid charcoal background, thin 1px
 * borders, teal-only accent. No neon, no heavy gradient blobs.
 *
 * Two CTA tracks:
 *   1. Website URL scan — free preview via UrlScanFlow (inline result render)
 *   2. Repo scan — routes to #pricing where tier selection begins checkout
 *
 * CLI snippet visible for developers who landed here from a search.
 */

import { useState } from "react";
import Link from "next/link";
import { UrlScanFlow } from "./UrlScanFlow";
import { OPEN_AUTH_EVENT } from "./Navbar";
import LiveStats from "./LiveStats";

const SAMPLE_URLS = [
  { label: "example.com", url: "https://example.com" },
  { label: "nextjs.org",  url: "https://nextjs.org"  },
  { label: "vercel.com",  url: "https://vercel.com"  },
];

// Honest positioning: the fragmented tools one GateTest gate replaces.
const REPLACES = ["SonarQube", "Snyk", "ESLint", "Semgrep", "CodeQL", "DeepSource"];

export default function Hero() {
  const [seed, setSeed] = useState<{ url: string; nonce: number }>({ url: "", nonce: 0 });
  const [track, setTrack] = useState<"website" | "repo">("website");

  function prefill(url: string) {
    setSeed((s) => ({ url, nonce: s.nonce + 1 }));
    requestAnimationFrame(() => {
      const el = document.getElementById("url-scan-input") as HTMLInputElement | null;
      if (el) el.focus();
    });
  }

  return (
    <section className="relative overflow-hidden pt-20">
      <div className="hero-dark px-6 pb-24 pt-16 relative">
        <div className="hero-grid" aria-hidden="true" />

        <div className="relative z-10 mx-auto max-w-4xl">

          {/* Status badge */}
          <div className="flex justify-center mb-10 fade-up">
            <div className="glass-card inline-flex items-center gap-2.5 px-4 py-2 rounded-full text-sm text-white/80 font-medium">
              <span className="relative flex h-2 w-2" aria-hidden="true">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
              <span>v1.42 &middot; 102 modules &middot; self-scan green</span>
            </div>

          {/* Headline */}
          <h1 className="text-center text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight leading-[1.08] mb-5 fade-up text-white">
            The Autonomous
            <br />
            <span className="hero-accent-text">Testing &amp; Repair Engine.</span>
          </h1>

          {/* Sub-headline */}
          <p className="text-center text-base sm:text-lg text-white/55 max-w-2xl mx-auto mb-2 leading-relaxed fade-up">
            Intercept flaws. Speculatively execute patches.
            Mathematically certify production-ready code blocks before you deploy.
          </p>
          <p className="text-center text-sm text-teal-300/75 max-w-xl mx-auto mb-10 fade-up font-medium">
            102 modules · bidirectional gate · certified PR — per scan, no subscription.
          </p>

          {/* Track switcher */}
          <div className="flex justify-center mb-8 fade-up">
            <div className="inline-flex rounded-lg border border-zinc-700 overflow-hidden text-sm font-medium">
              <button
                type="button"
                onClick={() => setTrack("website")}
                className={`px-5 py-2.5 transition-colors ${
                  track === "website"
                    ? "bg-zinc-700 text-white"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
                }`}
              >
                Scan a website
              </button>
              <button
                type="button"
                onClick={() => setTrack("repo")}
                className={`px-5 py-2.5 border-l border-zinc-700 transition-colors ${
                  track === "repo"
                    ? "bg-zinc-700 text-white"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
                }`}
              >
                Scan a repo
              </button>
            </div>
          </div>

          {/* CTA area */}
          <div className="max-w-2xl mx-auto fade-up">
            {track === "website" ? (
              <>
                {/* Website scan track */}
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
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-xs">
                  <span className="text-white/40 uppercase tracking-wider font-medium">Try</span>
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
                    WordPress? &rarr;
                  </Link>
                </div>
              </>
            ) : (
              /* Repo scan track */
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-6">
                <p className="text-sm text-zinc-300 mb-4">
                  Select a tier to start your repo scan — you provide the GitHub
                  URL at checkout. No GitHub App install required.
                </p>
                <button
                  type="button"
                  className="btn-primary inline-block w-full text-center"
                  onClick={() =>
                    window.dispatchEvent(new CustomEvent(OPEN_AUTH_EVENT))
                  }
                >
                  Get Automated Fixes &rarr;
                </button>
                <p className="text-[11px] text-zinc-600 mt-3 text-center">
                  Quick Scan is $29 · Full 102-module scan is $99 · Pay on completion
                </p>

                {/* CLI snippet for developers */}
                <div className="mt-6 pt-5 border-t border-zinc-800">
                  <p className="text-[11px] text-zinc-500 font-mono uppercase tracking-widest mb-2">
                    Or run locally
                  </p>
                  <div className="terminal rounded-lg px-4 py-3 flex items-center gap-3 overflow-x-auto">
                    <span className="text-zinc-500 select-none shrink-0">$</span>
                    <code className="text-teal-300 text-sm whitespace-nowrap">
                      npx @gatetest/cli --suite full
                    </code>
                  </div>
                  <p className="text-[11px] text-zinc-600 mt-2">
                    Zero install · reads your repo locally · exits 1 on any error finding
                  </p>
                </div>
              </div>
            )}

            {/* Honest status row */}
            <div className="mt-8 grid grid-cols-3 gap-3">
              <StatusCell label="Self-scan"     value="GREEN"  tone="ok"    detail="102/102 modules" />
              <StatusCell label="Tests passing" value="3,500+" tone="ok"    detail="every commit" />
              <StatusCell label="Payment"       value="$29+"   tone="muted" detail="one-time per scan" />
            </div>
          </div>

            <p className="text-center text-xs text-white/35 mt-5">
              Install the GitHub App for scan-on-every-push —{" "}
              <Link href="/github/setup" className="text-teal-300 hover:text-teal-200 underline-offset-2 hover:underline">
                set up Continuous for $49/mo &rarr;
              </Link>
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

    </section>
  );
}

function StatusCell({
  label, value, tone, detail,
}: {
  label: string;
  value: string;
  tone: "ok" | "muted";
  detail: string;
}) {
  const valueColor = tone === "ok" ? "text-emerald-300" : "text-white/80";
  return (
    <div className="glass-card status-pulse rounded-xl px-4 py-3 text-left">
      <div className="text-[10px] uppercase tracking-wider text-white/40 font-semibold">{label}</div>
      <div className={`text-lg font-bold mt-1 tabular-nums ${valueColor}`}>{value}</div>
      <div className="text-[11px] text-white/40 mt-0.5">{detail}</div>
    </div>
  );
}
