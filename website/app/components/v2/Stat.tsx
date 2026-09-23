/**
 * A single display-size number with its label and source, e.g. a page that
 * wants to drop one figure inline rather than the full <Numbers> count-up
 * grid. Static — no animation — deliberately, so it can sit inline in copy
 * without an IntersectionObserver per instance.
 */
export function Stat({
  value,
  label,
  source,
}: {
  value: string | number;
  label: string;
  source?: string;
}) {
  return (
    <div className="v2-stat">
      <div className="v2-stat-value v2-mono">{value}</div>
      <div className="v2-stat-label">{label}</div>
      {source && <div className="v2-stat-source v2-kicker">{source}</div>}
    </div>
  );
}
