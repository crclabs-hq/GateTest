/**
 * <HomeModuleBreakdown> — "What the 120 modules actually check."
 *
 * "All 120 modules" means nothing to a buyer. This groups them into human
 * categories with real counts, pulled straight from the module registry
 * (MODULE_CATEGORIES) so the numbers can NEVER drift from the engine. The
 * coming-soon Live-Security category is flagged, consistent with the pentest
 * waitlist section and honest about what's live today.
 */

import Link from "next/link";
import { MODULE_CATEGORIES, totalModuleCount } from "./howitworks/modules-data";

// One glyph per category id — decorative, keeps the grid scannable.
const ICONS: Record<string, string> = {
  "source-quality": "◆",
  security: "🛡",
  reliability: "⚙",
  "web-ux": "🖥",
  infrastructure: "🏗",
  "developer-hygiene": "🧹",
  "ai-advanced": "🧠",
  "scanning-testing": "🧪",
  "language-coverage": "🌐",
  wordpress: "🅦",
  "pen-test": "🎯",
};

const TOTAL = totalModuleCount();

export default function HomeModuleBreakdown() {
  return (
    <section id="modules" className="py-24 px-6 border-t border-border bg-background">
      <div className="mx-auto max-w-6xl">
        <div className="text-center mb-14">
          <span className="text-sm font-semibold text-accent uppercase tracking-wider">
            The engine
          </span>
          <h2 className="text-3xl sm:text-4xl font-bold mt-4 mb-4 text-foreground">
            What the {TOTAL} modules{" "}
            <span className="gradient-text">actually check</span>
          </h2>
          <p className="text-muted text-lg max-w-3xl mx-auto">
            One command runs all {TOTAL} — deterministic, zero AI tokens, under a
            minute. One verdict at the end. Here&apos;s what&apos;s inside the gate.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-10">
          {MODULE_CATEGORIES.map((cat) => (
            <div
              key={cat.id}
              className="rounded-2xl border border-border bg-surface-solid p-6 flex flex-col"
            >
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2.5">
                  <span className="text-xl" aria-hidden="true">
                    {ICONS[cat.id] ?? "◆"}
                  </span>
                  <h3 className="text-base font-bold text-foreground">
                    {cat.title}
                  </h3>
                </div>
                {cat.comingSoon ? (
                  <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border bg-violet-500/10 text-violet-500 border-violet-500/25">
                    Soon
                  </span>
                ) : (
                  <span className="text-sm font-bold text-accent tabular-nums">
                    {cat.modules.length}
                  </span>
                )}
              </div>
              <p className="text-sm text-muted leading-relaxed">{cat.blurb}</p>
            </div>
          ))}
        </div>

        <div className="text-center">
          <Link
            href="/how-it-works"
            className="inline-flex items-center gap-1.5 text-sm text-accent hover:text-accent-hover font-semibold"
          >
            See every module, with real example findings
            <span aria-hidden="true">&rarr;</span>
          </Link>
        </div>
      </div>
    </section>
  );
}
