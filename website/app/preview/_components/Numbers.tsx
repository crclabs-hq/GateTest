"use client";

import { useEffect, useRef, useState } from "react";

export interface NumberItem {
  value: number;
  /** Text after the number, e.g. "+" or "%". */
  suffix?: string;
  label: string;
  /** Where the number comes from — always shown. */
  source: string;
}

/**
 * Display-size numerals from real data files, counted up once when they
 * scroll into view. Static under reduced motion. The source line under each
 * number is not decoration: every figure on this page names its file.
 */
export function Numbers({ items }: { items: NumberItem[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setProgress(1); return; }
    let raf = 0;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
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
