"use client";

import { useEffect, useState } from "react";

/**
 * The rail: five stages of one push, fixed at the left edge on desktop.
 * Each section on the page carries data-stage="<id>"; the stage whose section
 * is nearest the viewport centre is active, everything above it is done, and
 * the line between them fills to match. Reads the DOM once per scroll frame;
 * no layout thrash, no library.
 */
export const STAGES = [
  { id: "push", label: "push" },
  { id: "gate", label: "gate" },
  { id: "findings", label: "findings" },
  { id: "fix", label: "fix" },
  { id: "merge", label: "merge" },
] as const;

export function Rail() {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const sections = STAGES.map((s) => document.querySelector<HTMLElement>(`[data-stage="${s.id}"]`));
    let raf = 0;
    const measure = () => {
      raf = 0;
      const mid = window.innerHeight * 0.45;
      let best = 0;
      let bestDist = Infinity;
      sections.forEach((el, i) => {
        if (!el) return;
        const r = el.getBoundingClientRect();
        // distance from the viewport's focus line to the section's band
        const dist = r.top > mid ? r.top - mid : r.bottom < mid ? mid - r.bottom : 0;
        if (dist < bestDist) { bestDist = dist; best = i; }
      });
      setActive(best);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  const fill = STAGES.length > 1 ? (active / (STAGES.length - 1)) * 100 : 0;

  return (
    <nav className="v2-rail" aria-label="Stages of a push">
      <div className="v2-rail-line" aria-hidden="true">
        <div className="v2-rail-fill" style={{ height: `${fill}%` }} />
      </div>
      {STAGES.map((s, i) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          className="v2-rail-stage"
          data-state={i < active ? "done" : i === active ? "active" : "todo"}
          aria-current={i === active ? "step" : undefined}
        >
          <span className="v2-rail-dot" aria-hidden="true" />
          <span>{s.label}</span>
        </a>
      ))}
    </nav>
  );
}
