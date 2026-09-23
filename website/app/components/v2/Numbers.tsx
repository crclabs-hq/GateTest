"use client";

import { useEffect, useRef, useState } from "react";

interface NumberItem {
  value: number;
  /** Text after the number, e.g. "+" or "%". */
  suffix?: string;
  label: string;
  /** Where the number comes from — always shown. */
  source: string;
}

/**
 * Display-size numerals from real data files. The real value is the resting
 * state — it renders on the server and on first paint with no JavaScript,
 * no observer and no animation required, so a crawler, a screenshot tool, or
 * a scroll that outruns the observer never sees a placeholder zero (2026-09-22
 * buyer-walk: this section rendered "0 0 0 0" in a full-page capture because
 * the count-up started from zero and only reached the real figure once an
 * IntersectionObserver fired and a 900ms animation finished — a section of
 * this page's own dark background depended on the observer to show anything
 * meaningful). Once mounted, a count-up plays as a decorative enhancement on
 * top of the always-correct number; it never hides or replaces the resting
 * value, so a slow observer or a fast scroll degrades to "already correct"
 * instead of "still zero". Static under reduced motion. The source line
 * under each number is not decoration: every figure on this page names its
 * file.
 */
export function Numbers({ items }: { items: NumberItem[] }) {
  const ref = useRef<HTMLDivElement>(null);
  // 1 = resting state, i.e. the real value. This is the initial render on
  // both server and client, so there is no JS-less, pre-hydration or
  // pre-observer moment where the number reads zero.
  const [progress, setProgress] = useState(1);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      // Decorative replay: count up from 0 to the real value. The real value
      // was already on screen before this fired, so cutting the animation
      // short (slow device, fast scroll away) only ever shows a correct
      // number, never a placeholder.
      setProgress(0);
      const start = performance.now();
      const dur = 900;
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / dur);
        // ease-out cubic
        setProgress(1 - Math.pow(1 - t, 3));
        if (t < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    }, { threshold: 0.3 });
    io.observe(el);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, []);

  return (
    <div ref={ref} className="grid grid-cols-2 lg:grid-cols-4 gap-x-8 gap-y-10">
      {items.map((it) => (
        <div key={it.label} className="border-t border-[var(--v2-line-strong)] pt-4">
          <div className="v2-mono text-[2.6rem] leading-none font-medium tracking-tight">
            {Math.round(it.value * progress).toLocaleString()}{it.suffix ?? ""}
          </div>
          <div className="mt-3 text-sm">{it.label}</div>
          <div className="mt-1 v2-kicker">{it.source}</div>
        </div>
      ))}
    </div>
  );
}
