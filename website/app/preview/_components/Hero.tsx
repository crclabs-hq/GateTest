"use client";

import { useEffect, useState } from "react";
import { I } from "../_lib/icons";
import { Reveal } from "./Reveal";

const REVIEW_COMMENTS = [
  {
    sev: "critical",
    line: "L42",
    rule: "moneyFloat",
    text: "parseFloat() on a currency value — IEEE-754 drift. Use Decimal.",
  },
  {
    sev: "high",
    line: "L57",
    rule: "ssrf",
    text: "req.body.url reaches fetch() with no allowlist. SSRF vector.",
  },
  {
    sev: "medium",
    line: "L88",
    rule: "raceCondition",
    text: "findUnique → create with no transaction. Lost-update risk.",
  },
];

const sevColor: Record<string, string> = {
  critical: "text-rose-400 bg-rose-500/10 border-rose-500/20",
  high: "text-amber-400 bg-amber-500/10 border-amber-500/20",
  medium: "text-sky-400 bg-sky-500/10 border-sky-500/20",
};

function HeroMock() {
  const [visible, setVisible] = useState(0);

  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      const raf = requestAnimationFrame(() =>
        setVisible(REVIEW_COMMENTS.length),
      );
      return () => cancelAnimationFrame(raf);
    }
    const id = setInterval(() => {
      setVisible((v) => {
        if (v >= REVIEW_COMMENTS.length) {
          clearInterval(id);
          return v;
        }
        return v + 1;
      });
    }, 900);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="gt-tilt relative rounded-2xl border border-white/10 bg-[#0a0c12]/70 shadow-[0_40px_120px_-40px_rgba(13,148,136,0.45)] backdrop-blur-xl">
      {/* window chrome */}
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-rose-400/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/70" />
        <span className="ml-2 font-mono text-[11px] text-zinc-500">
          checkout/route.ts · GateTest review
        </span>
        <span className="ml-auto flex items-center gap-1.5 rounded-full border border-teal-300/20 bg-teal-400/10 px-2 py-0.5 text-[10px] font-medium text-teal-300">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal-300" />
          scanning
        </span>
      </div>

      {/* code body */}
      <div className="grid gap-px bg-white/[0.04] sm:grid-cols-[1fr]">
        <pre className="overflow-hidden bg-[#070910] p-4 font-mono text-[12.5px] leading-relaxed text-zinc-300">
          <code>
            <span className="text-zinc-600">42 </span>
            <span className="text-sky-300">const</span> total ={" "}
            <span className="text-amber-300">parseFloat</span>
            (req.body.amount);{"\n"}
            <span className="text-zinc-600">57 </span>
            <span className="text-sky-300">const</span> res ={" "}
            <span className="text-sky-300">await</span>{" "}
            <span className="text-amber-300">fetch</span>(req.body.url);{"\n"}
            <span className="text-zinc-600">88 </span>
            <span className="text-sky-300">await</span> db.user.
            <span className="text-amber-300">create</span>({"{ "}data {"}"});
          </code>
        </pre>
      </div>

      {/* review thread */}
      <div className="space-y-2 p-4">
        {REVIEW_COMMENTS.map((c, i) => (
          <div
            key={c.rule}
            className={`flex items-start gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 transition-all duration-500 ${
              i < visible
                ? "translate-y-0 opacity-100"
                : "pointer-events-none translate-y-2 opacity-0"
            }`}
          >
            <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md border border-teal-300/20 bg-teal-400/10">
              <I.shield className="h-3.5 w-3.5 text-teal-300" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${sevColor[c.sev]}`}
                >
                  {c.sev}
                </span>
                <span className="font-mono text-[11px] text-zinc-500">
                  {c.line}
                </span>
                <span className="font-mono text-[11px] text-teal-300/80">
                  {c.rule}
                </span>
              </div>
              <p className="mt-1 text-[13px] leading-snug text-zinc-300">
                {c.text}
              </p>
            </div>
          </div>
        ))}

        {/* PR result */}
        <div
          className={`flex items-center gap-3 rounded-xl border border-emerald-400/20 bg-emerald-500/[0.07] p-3 transition-all duration-500 ${
            visible >= REVIEW_COMMENTS.length
              ? "translate-y-0 opacity-100"
              : "pointer-events-none translate-y-2 opacity-0"
          }`}
        >
          <span className="grid h-6 w-6 place-items-center rounded-md bg-emerald-400/15 text-emerald-300">
            <I.branch className="h-3.5 w-3.5" />
          </span>
          <p className="text-[13px] font-medium text-emerald-200">
            Auto-fix PR #1284 opened — 3 issues resolved, 2 regression tests
            added.
          </p>
        </div>
      </div>
    </div>
  );
}

export function Hero() {
  return (
    <section id="top" className="relative overflow-hidden px-4 pb-24 pt-36 sm:pt-40">
      {/* ambient glows */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "radial-gradient(60% 50% at 50% -8%, rgba(13,148,136,0.20), transparent 60%), radial-gradient(40% 40% at 85% 20%, rgba(56,189,248,0.10), transparent 60%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 opacity-[0.18]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.6) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
          maskImage:
            "radial-gradient(70% 55% at 50% 0%, #000 30%, transparent 75%)",
          WebkitMaskImage:
            "radial-gradient(70% 55% at 50% 0%, #000 30%, transparent 75%)",
        }}
      />

      <div className="mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-[1.05fr_0.95fr]">
        {/* Left column */}
        <div>
          <Reveal>
            <a
              href="#bento"
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:border-teal-300/30 hover:text-white"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-teal-300" />
              120+ unified checks · auto-fix pull requests
              <I.arrow className="h-3.5 w-3.5 text-teal-300" />
            </a>
          </Reveal>

          <Reveal delay={60}>
            <h1 className="mt-6 font-display text-[clamp(2.6rem,6vw,4.4rem)] font-bold leading-[1.02] tracking-tight text-white">
              AI writes fast.
              <br />
              <span className="bg-gradient-to-r from-teal-200 via-teal-300 to-emerald-300 bg-clip-text text-transparent">
                GateTest keeps it honest.
              </span>
            </h1>
          </Reveal>

          <Reveal delay={120}>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-zinc-400">
              The enterprise QA guardrail for the AI-assisted era. Hook GateTest
              into your repo and ship every commit through{" "}
              <span className="text-zinc-200">120+ deep checks</span> — security,
              memory leaks, type safety, edge cases, architecture — in one
              unified scan. Every issue comes back as an{" "}
              <span className="text-zinc-200">auto-fix pull request</span>, not
              just another alert.
            </p>
          </Reveal>

          <Reveal delay={180}>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <a
                href="#cta"
                className="group flex items-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-semibold text-zinc-900 shadow-[0_8px_30px_-8px_rgba(255,255,255,0.4)] transition-transform hover:scale-[1.02]"
              >
                <I.github className="h-4.5 w-4.5" />
                Connect Repository
                <I.arrow className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </a>
              <a
                href="#pipeline"
                className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.02] px-5 py-3 text-sm font-medium text-zinc-200 transition-colors hover:border-white/20 hover:bg-white/[0.05]"
              >
                <I.eye className="h-4.5 w-4.5 text-teal-300" />
                Watch a live scan
              </a>
            </div>
          </Reveal>

          <Reveal delay={240}>
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-zinc-500">
              <span className="flex items-center gap-1.5">
                <I.check className="h-4 w-4 text-teal-300" />
                No subscription — pay per scan
              </span>
              <span className="flex items-center gap-1.5">
                <I.check className="h-4 w-4 text-teal-300" />
                Quick scan under 15s
              </span>
              <span className="flex items-center gap-1.5">
                <I.check className="h-4 w-4 text-teal-300" />
                SOC 2–aligned controls
              </span>
            </div>
          </Reveal>
        </div>

        {/* Right column — mock */}
        <Reveal delay={160} className="lg:pl-4">
          <HeroMock />
        </Reveal>
      </div>
    </section>
  );
}
