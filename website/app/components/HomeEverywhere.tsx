/**
 * <HomeEverywhere> — every channel GateTest ships on, with the real link.
 *
 * Craig, 2026-09-16: "the website should also state or show that we have it
 * on Visual Studio and everywhere else." Until tonight the site said the
 * opposite ("No published VS Code extension yet").
 *
 * Rules baked in:
 * - The list is imported from lib/distribution.ts — one definition, and only
 *   channels that are live and verified. Nothing here is a roadmap item.
 * - Counts come from TOTAL_MODULES (sync rule).
 * - Every "free" line is literally true for that channel.
 */

import Link from "next/link";
import { TOTAL_MODULES } from "@/app/lib/module-count";
import { SURFACES } from "@/app/lib/distribution";

const ICONS: Record<string, React.ReactNode> = {
  vscode: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M16 3l5 2.5v13L16 21l-9-7.5L4 16l-1-1V9l1-1 3 2.5L16 3z" strokeLinejoin="round" />
      <path d="M16 3v18M7 13.5L16 6M7 10.5L16 18" strokeLinejoin="round" />
    </svg>
  ),
  openvsx: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" strokeLinejoin="round" />
      <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" strokeLinejoin="round" />
    </svg>
  ),
  cli: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 9l3 3-3 3M12 15h5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  action: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 12l2.5 2.5 4.5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  mcp: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="4" y="7" width="16" height="12" rx="3" />
      <path d="M12 7V4M9 13h.01M15 13h.01" strokeLinecap="round" />
    </svg>
  ),
  web: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9S14.5 18.3 12 21c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z" />
    </svg>
  ),
  wordpress: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M6.5 8.5l3 8 2.5-6 2.5 6 3-8M9.5 8.5h-1M15.5 8.5h-1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

// The heading counts the list it renders (Doctrine §7) — the typed number it
// replaced went stale the day Open VSX went live.
const COUNT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const placesWord = (n: number): string => {
  const word = COUNT_WORDS[n] ?? String(n);
  return word.charAt(0).toUpperCase() + word.slice(1);
};

export default function HomeEverywhere() {
  const places = placesWord(SURFACES.length);
  return (
    <section
      id="everywhere"
      aria-labelledby="everywhere-heading"
      className="py-24 px-6 border-t border-border bg-background"
    >
      <div className="mx-auto max-w-6xl">
        <div className="max-w-2xl mb-14">
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-foreground/[0.03] px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-muted mb-5">
            Available everywhere you work
          </span>
          <h2
            id="everywhere-heading"
            className="text-3xl sm:text-4xl font-bold text-foreground mb-4 tracking-tight"
          >
            One engine. {places} places to run it.
          </h2>
          <p className="text-muted text-lg leading-relaxed">
            Editor, terminal, CI, AI agent, browser. The same {TOTAL_MODULES}-module
            engine and the same verdict, wherever you already are. Every one of
            these is live today.
          </p>
        </div>

        <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 list-none p-0 m-0">
          {SURFACES.map((s) => {
            const Cta = s.cta.external ? "a" : Link;
            const ctaProps = s.cta.external
              ? { href: s.cta.href, target: "_blank", rel: "noopener noreferrer" }
              : { href: s.cta.href };
            return (
              <li key={s.id} className="group relative flex">
                <div className="relative flex flex-col w-full rounded-2xl border border-border bg-foreground/[0.02] p-6 transition-colors duration-200 group-hover:border-foreground/20">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-9 h-9 text-teal-400">{ICONS[s.id]}</div>
                    <span className="text-[11px] font-bold uppercase tracking-wider text-muted">{s.where}</span>
                  </div>
                  <h3 className="text-lg font-bold text-foreground mb-2">{s.title}</h3>
                  <p className="text-sm text-muted leading-relaxed mb-4">{s.pitch}</p>
                  {s.snippet && (
                    <pre className="rounded-lg bg-panel text-emerald-300 border border-panel-border px-3 py-2 text-xs font-mono overflow-x-auto mb-4">
                      <code>{s.snippet}</code>
                    </pre>
                  )}
                  <div className="mt-auto">
                    <p className="text-xs text-muted/80 mb-3">{s.free}</p>
                    <Cta
                      {...ctaProps}
                      className="inline-flex w-full items-center justify-center rounded-xl border border-foreground/15 bg-foreground/[0.06] px-4 py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-foreground/10 hover:border-foreground/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-400"
                    >
                      {s.cta.label}
                      {s.cta.external && <span aria-hidden="true" className="ml-1.5 text-muted">↗</span>}
                    </Cta>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
