import precision from "../../data/precision.json";

/**
 * The corpus, drawn from website/app/data/precision.json — the same file
 * /precision renders and the nightly job regenerates. One bar per pinned
 * third-party repository: the filled bar is blocking findings on the pinned
 * commit, the tick is that repo's ceiling, which only ever ratchets down.
 * Server-rendered SVG; no chart library.
 */
interface Repo {
  name: string;
  url: string;
  sha: string;
  why: string;
  blocking: number;
  ceiling: number | null;
}

const ROW = 26;
const LABEL_W = 150;
const CHART_W = 620;
const PAD_R = 44;

export function PrecisionChart() {
  const repos = (precision.repos as Repo[]).filter((r) => typeof r.ceiling === "number");
  const sorted = [...repos].sort((a, b) => (b.ceiling ?? 0) - (a.ceiling ?? 0) || a.name.localeCompare(b.name));
  const max = Math.max(1, ...sorted.map((r) => Math.max(r.blocking, r.ceiling ?? 0)));
  const scale = (n: number) => (n / max) * (CHART_W - LABEL_W - PAD_R);
  const height = sorted.length * ROW + 8;
  const clean = sorted.filter((r) => r.blocking === 0).length;
  const measured = new Date(precision.generatedAt).toISOString().slice(0, 10);

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${CHART_W} ${height}`}
        width="100%"
        role="img"
        aria-label={`Blocking findings versus ceiling for ${sorted.length} pinned repositories`}
        className="block"
      >
        {sorted.map((r, i) => {
          const y = i * ROW + 4;
          const bar = scale(r.blocking);
          const cap = scale(r.ceiling ?? 0);
          const colour = r.blocking === 0 ? "var(--v2-ok)" : r.blocking <= (r.ceiling ?? 0) ? "var(--v2-accent)" : "var(--v2-bad)";
          return (
            <g key={r.name} transform={`translate(0 ${y})`}>
              <title>{`${r.name}: ${r.blocking} blocking, ceiling ${r.ceiling} — ${r.why}`}</title>
              <text x={LABEL_W - 10} y={ROW / 2 + 4} textAnchor="end" fontSize="12" fontFamily="var(--v2-mono)" fill="var(--v2-fg)">
                {r.name}
              </text>
              <line x1={LABEL_W} x2={CHART_W - PAD_R} y1={ROW / 2} y2={ROW / 2} stroke="var(--v2-line)" strokeWidth="1" />
              <rect x={LABEL_W} y={ROW / 2 - 5} width={Math.max(bar, r.blocking ? 2 : 0)} height="10" rx="2" fill={colour} />
              <line x1={LABEL_W + cap} x2={LABEL_W + cap} y1={ROW / 2 - 8} y2={ROW / 2 + 8} stroke="var(--v2-fg)" strokeWidth="1.5" />
              <text x={CHART_W - PAD_R + 8} y={ROW / 2 + 4} fontSize="11" fontFamily="var(--v2-mono)" fill="var(--v2-muted)">
                {r.blocking}/{r.ceiling}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-4 flex flex-wrap gap-x-6 gap-y-2 v2-kicker">
        <span><span className="inline-block w-3 h-2 align-middle rounded-sm mr-2" style={{ background: "var(--v2-ok)" }} />0 blocking</span>
        <span><span className="inline-block w-3 h-2 align-middle rounded-sm mr-2" style={{ background: "var(--v2-accent)" }} />blocking at or under the ceiling</span>
        <span><span className="inline-block w-px h-3 align-middle mr-2" style={{ background: "var(--v2-fg)" }} />ceiling</span>
        <span className="ml-auto">
          {clean} of {sorted.length} clean · measured {measured} · engine {precision.engineVersion}
        </span>
      </figcaption>
    </figure>
  );
}
