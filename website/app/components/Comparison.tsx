"use client";

import { useEffect, useRef, useState } from "react";

const competitors = [
  { name: "Cypress", categories: 1, scope: "Browser E2E only" },
  { name: "Jest", categories: 1, scope: "Unit tests only" },
  { name: "ESLint", categories: 1, scope: "Linting only" },
  { name: "Lighthouse", categories: 4, scope: "Perf + SEO + A11y + Best Practices" },
  { name: "Snyk", categories: 1, scope: "Security scanning only" },
  { name: "Percy", categories: 1, scope: "Visual regression only" },
  { name: "axe", categories: 1, scope: "Accessibility only" },
  { name: "SonarQube", categories: 3, scope: "Code quality + some security" },
];

const features = [
  "Syntax validation",
  "Linting",
  "Secret detection",
  "Code quality",
  "Unit tests",
  "Integration tests",
  "E2E tests",
  "Visual regression",
  "Accessibility (AAA)",
  "Performance / Vitals",
  "Security / OWASP",
  "SEO & metadata",
  "Broken links",
  "Browser compat",
  "Data integrity",
  "Documentation",
];

export default function Comparison() {
  const sectionRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = sectionRef.current;
    if (!node) return;
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <section id="comparison" className="py-24 px-6 border-t border-border/30">
      <div className="mx-auto max-w-6xl">
        <div className="text-center mb-16">
          <span className="text-sm font-semibold text-accent-light uppercase tracking-wider">
            Competitive Analysis
          </span>
          <h2 className="text-3xl sm:text-4xl font-bold mt-4 mb-4">
            They test <span className="text-muted">one thing</span>.{" "}
            We test <span className="gradient-text">everything</span>.
          </h2>
          <p className="text-muted text-lg max-w-2xl mx-auto">
            No single competitor covers more than 4 categories. GateTest covers 16.
            That&apos;s not incremental improvement — it&apos;s a different product category.
          </p>
        </div>

        {/* Competitor bars — fill animates in when section scrolls into view */}
        <div ref={sectionRef} className="space-y-3 mb-16">
          {competitors.map((comp, i) => {
            const pct = (comp.categories / 16) * 100;
            return (
              <div key={comp.name} className="flex items-center gap-4">
                <div className="w-28 text-sm text-muted text-right shrink-0">{comp.name}</div>
                <div className="flex-1 relative">
                  <div className="h-8 rounded-md bg-surface border border-border/50 overflow-hidden">
                    <div
                      className="h-full bg-muted/20 rounded-md flex items-center px-3 transition-[width] ease-out"
                      style={{
                        width: visible ? `${pct}%` : "0%",
                        minWidth: visible ? "80px" : "0px",
                        transitionDuration: `${700 + i * 60}ms`,
                        transitionDelay: visible ? `${i * 40}ms` : "0ms",
                      }}
                    >
                      <span
                        className="text-xs text-muted whitespace-nowrap transition-opacity duration-300"
                        style={{ opacity: visible ? 1 : 0 }}
                      >
                        {comp.categories}/16 — {comp.scope}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}

          {/* GateTest row — fills last with a dramatic full-width sweep */}
          <div className="flex items-center gap-4">
            <div className="w-28 text-sm text-accent-light text-right shrink-0 font-bold">GateTest</div>
            <div className="flex-1 relative">
              <div className="h-10 rounded-md glow-border overflow-hidden">
                <div
                  className="h-full bg-accent/20 rounded-md flex items-center px-3 transition-[width] ease-out"
                  style={{
                    width: visible ? "100%" : "0%",
                    transitionDuration: "900ms",
                    transitionDelay: visible ? `${competitors.length * 40 + 80}ms` : "0ms",
                  }}
                >
                  <span
                    className="text-sm text-accent-light font-semibold transition-opacity duration-300"
                    style={{
                      opacity: visible ? 1 : 0,
                      transitionDelay: visible ? `${competitors.length * 40 + 400}ms` : "0ms",
                    }}
                  >
                    120/120 — Everything. All of it. One gate.
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Feature checklist */}
        <div className="glow-border rounded-xl p-8 bg-surface">
          <h3 className="font-bold text-lg mb-6 text-center">What&apos;s included in every GateTest run</h3>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {features.map((feature) => (
              <div key={feature} className="flex items-center gap-2 text-sm">
                <span className="text-success text-lg">&#10003;</span>
                <span className="text-foreground">{feature}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
