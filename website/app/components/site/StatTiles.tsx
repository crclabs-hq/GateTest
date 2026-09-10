import siteStats from "../../data/site-stats.json";

export type Stat = { value: string; label: string; note?: string };

/**
 * Numbers about the product come from the generated site stats, never typed
 * into a page. A stale, hand-typed module count on /developers (one behind
 * the engine) is how this rule was learned (2026-09-10).
 */
export function defaultStats(): Stat[] {
  const m = siteStats.modules;
  const t = siteStats.tests;
  return [
    { value: String(m.total), label: "modules in one gate" },
    { value: t.displayPassing, label: "tests passing on main" },
    { value: m.displayGreen, label: "modules green on our own repo", note: `measured ${m.greenMeasuredAt.slice(0, 10)}` },
    { value: "<30s", label: "quick scan" },
  ];
}

export default function StatTiles({ items = defaultStats() }: { items?: Stat[] }) {
  return (
    <dl className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
      {items.map((s) => (
        <div key={s.label} className="card p-5 sm:p-6">
          <dd className="font-display text-3xl sm:text-4xl font-bold text-accent tabular-nums leading-none">{s.value}</dd>
          <dt className="mt-2 text-xs sm:text-sm text-muted">{s.label}</dt>
          {s.note && <p className="mt-1 text-[11px] text-muted/80">{s.note}</p>}
        </div>
      ))}
    </dl>
  );
}
