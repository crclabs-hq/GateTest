"use client";

import { useEffect, useRef, useState } from "react";

interface CountUpProps {
  value: string;
  duration?: number;
  className?: string;
}

export default function CountUp({ value, duration = 1600, className = "" }: CountUpProps) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [display, setDisplay] = useState(value);
  const [animated, setAnimated] = useState(false);

  // Strip commas before parsing so "4,600+" works correctly.
  const stripped = value.replace(/,/g, "");
  const match = stripped.match(/^(\$?)(\d+(?:\.\d+)?)(.*)$/);
  const prefix = match ? match[1] : "";
  const target = match ? parseFloat(match[2]) : NaN;
  const suffix = match ? match[3] : "";
  const useLocale = value.includes(",");

  useEffect(() => {
    if (!ref.current || isNaN(target) || animated) {
      return;
    }
    // Respect prefers-reduced-motion — skip the count-up animation entirely
    // and just render the final value. WCAG 2.3.3 (Animation from Interactions).
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) {
      setDisplay(value);
      setAnimated(true);
      return;
    }
    const node = ref.current;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !animated) {
          setAnimated(true);
          const start = performance.now();
          const tick = (now: number) => {
            const elapsed = now - start;
            const progress = Math.min(elapsed / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            const current = target * eased;
            const n = Math.round(current);
            const rounded = target < 10 ? current.toFixed(0)
              : useLocale ? n.toLocaleString("en-US")
              : n.toString();
            setDisplay(`${prefix}${rounded}${suffix}`);
            if (progress < 1) {
              requestAnimationFrame(tick);
            } else {
              setDisplay(value);
            }
          };
          requestAnimationFrame(tick);
        }
      },
      { threshold: 0.35 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [target, duration, prefix, suffix, value, animated]);

  if (isNaN(target)) {
    return <span className={className}>{value}</span>;
  }

  return (
    <span ref={ref} className={className}>
      {display}
    </span>
  );
}
