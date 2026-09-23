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

// Restyled to the v2 stat-tile look (issue #686) — a hairline top border and
// a mono display number, matching website/app/preview's <Numbers>, instead
// of the old bordered-card-with-display-font treatment.
export default function StatTiles({ items = defaultStats() }: { items?: Stat[] }) {
  return (
    <dl className="grid grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-8">
      {items.map((s) => (
        <div key={s.label} className="v2-stat">
          <dd className="v2-stat-value v2-mono">{s.value}</dd>
          <dt className="v2-stat-label">{s.label}</dt>
          {s.note && <p className="v2-stat-source v2-kicker">{s.note}</p>}
        </div>
      ))}
    </dl>
  );
}
