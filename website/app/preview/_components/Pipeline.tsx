"use client";

import { useEffect, useState } from "react";
import { I } from "../_lib/icons";
import { Reveal } from "./Reveal";

const STAGES = [
  {
    key: "scan",
    icon: I.eye,
    label: "Scan initiated",
    sub: "Repo hooked. 110 modules fan out across every file in parallel.",
    metric: "12,480 files",
    metricLabel: "indexed",
  },
  {
    key: "detect",
    icon: I.bug,
    label: "Issues detected",
    sub: "Findings clustered to root causes, ranked by blast radius.",
    metric: "37 root causes",
    metricLabel: "from 912 findings",
  },
  {
    key: "fix",
    icon: I.branch,
    label: "Auto-fix PR generated",
    sub: "Validated fixes + regression tests, opened straight to your branch.",
    metric: "PR #1284",
    metricLabel: "ready to merge",
  },
];

export function Pipeline() {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      const raf = requestAnimationFrame(() => setActive(STAGES.length - 1));
      return () => cancelAnimationFrame(raf);
    }
    const id = setInterval(
      () => setActive((a) => (a + 1) % STAGES.length),
      2200,
    );
    return () => clearInterval(id);
  }, [paused]);

  return (
    <section id="pipeline" className="px-4 py-24">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <div className="mx-auto max-w-2xl text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-teal-300">
              The Scan-to-PR engine
            </p>
            <h2 className="mt-3 font-display text-[clamp(2rem,4vw,3rem)] font-bold tracking-tight text-white">
              From red flag to merged fix — without leaving the PR
            </h2>
            <p className="mt-4 text-lg text-zinc-400">
              Most tools stop at the alert. GateTest closes the loop: detect,
              diagnose, fix, and prove the fix with a generated test.
            </p>
          </div>
        </Reveal>

        <Reveal delay={100}>
          <div
            className="mt-14"
            onMouseEnter={() => setPaused(true)}
            onMouseLeave={() => setPaused(false)}
          >
            <div className="grid gap-4 md:grid-cols-3 md:gap-0">
              {STAGES.map((s, i) => {
                const on = i <= active;
                const current = i === active;
                return (
                  <div key={s.key} className="relative flex flex-col">
                    {/* connector */}
                    {i < STAGES.length - 1 && (
                      <div className="absolute left-1/2 top-7 hidden h-px w-full md:block">
                        <div className="h-px w-full bg-white/10" />
                        <div
                          className="absolute inset-0 h-px bg-gradient-to-r from-teal-300 to-emerald-300 transition-all duration-700"
                          style={{ width: i < active ? "100%" : "0%" }}
                        />
                        {i < active && (
                          <span className="absolute right-0 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-emerald-300 shadow-[0_0_10px_2px_rgba(110,231,183,0.7)]" />
                        )}
                      </div>
                    )}

                    {/* node */}
                    <button
                      onClick={() => setActive(i)}
                      className="relative z-10 mx-auto grid h-14 w-14 place-items-center rounded-2xl border transition-all duration-500"
                      style={{
                        borderColor: on
                          ? "rgba(45,212,191,0.4)"
                          : "rgba(255,255,255,0.1)",
                        background: on
                          ? "linear-gradient(135deg, rgba(45,212,191,0.18), rgba(16,185,129,0.06))"
                          : "rgba(255,255,255,0.02)",
                        boxShadow: current
                          ? "0 0 0 6px rgba(45,212,191,0.10), 0 0 40px -6px rgba(45,212,191,0.6)"
                          : "none",
                      }}
                      aria-label={s.label}
                    >
                      <s.icon
                        className={`h-6 w-6 transition-colors ${
                          on ? "text-teal-200" : "text-zinc-500"
                        }`}
                      />
                      {current && (
                        <span className="absolute inset-0 rounded-2xl border border-teal-300/40 gt-ping" />
                      )}
                    </button>

                    {/* card */}
                    <div
                      className={`mx-2 mt-5 rounded-2xl border p-5 text-center transition-all duration-500 md:mx-3 ${
                        current
                          ? "border-teal-300/25 bg-white/[0.04]"
                          : "border-white/[0.06] bg-white/[0.015]"
                      }`}
                    >
                      <h3 className="text-base font-semibold text-white">
                        {s.label}
                      </h3>
                      <p className="mt-2 text-sm leading-snug text-zinc-400">
                        {s.sub}
                      </p>
                      <div className="mt-4 rounded-lg border border-white/[0.06] bg-[#070910] px-3 py-2">
                        <div className="font-mono text-sm font-semibold text-teal-200">
                          {s.metric}
                        </div>
                        <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                          {s.metricLabel}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
