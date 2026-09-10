/**
 * Hand-rolled SVG architecture diagram. No external dependencies.
 *
 * Renders the full GateTest scan pipeline as a vertical flow with labelled
 * boxes and arrows. Designed to be scannable in ~5 seconds.
 */

import { TOTAL_MODULES } from "@/app/lib/module-count";
type Node = {
  id: string;
  label: string;
  detail?: string;
  y: number;
  variant?: "input" | "queue" | "engine" | "fix" | "review" | "nuclear" | "output";
};

const NODES: Node[] = [
  { id: "push", label: "Customer push", detail: "git push / merge", y: 40, variant: "input" },
  { id: "host", label: "GitHub App webhook  OR  Gluecron Signal Bus", detail: "HMAC-verified, fail-closed", y: 130, variant: "input" },
  { id: "queue", label: "scan_queue (Postgres)", detail: "idempotent via delivery id", y: 220, variant: "queue" },
  { id: "engine", label: "Worker fetches job  →  Gate runs 121 modules", detail: "deterministic, no AI by default", y: 310, variant: "engine" },
  { id: "cluster", label: "Findings clustered, ranked, capped per tier", detail: "root causes first, info-severity dropped", y: 410, variant: "engine" },
  { id: "fix", label: "Fix engine  ·  Recipe → Claude → Gates", detail: "patch must clear syntax + re-scan gates", y: 510, variant: "fix" },
  { id: "gate", label: "Test gen  +  syntax gate  +  scanner re-validation", detail: "broken fixes never reach the PR", y: 610, variant: "fix" },
  { id: "review", label: "Pair review  +  architecture annotation  ·  Tier 2+", detail: "second Claude critiques every fix", y: 700, variant: "review" },
  { id: "nuclear", label: "Correlation  +  Claude diagnosis  +  executive summary  ·  Forensic", detail: "attack chains across findings, per-finding diagnosis, CISO report (mutation + chaos run via GitHub Action)", y: 790, variant: "nuclear" },
  { id: "pr", label: "PR composed and opened", detail: "before/after table, advisory, regression tests", y: 890, variant: "output" },
];

const VARIANT_STYLES: Record<NonNullable<Node["variant"]>, { fill: string; stroke: string; label: string; detail: string }> = {
  input:   { fill: "rgba(20, 184, 166, 0.08)", stroke: "rgba(15, 118, 110, 0.45)", label: "var(--accent)", detail: "var(--muted)" },
  queue:   { fill: "rgba(99, 102, 241, 0.08)", stroke: "rgba(67, 56, 202, 0.45)", label: "#4338ca", detail: "var(--muted)" },
  engine:  { fill: "var(--background-alt)", stroke: "var(--border-strong)", label: "var(--foreground)", detail: "var(--muted)" },
  fix:     { fill: "rgba(245, 158, 11, 0.08)", stroke: "rgba(180, 83, 9, 0.45)", label: "#b45309", detail: "var(--muted)" },
  review:  { fill: "rgba(168, 85, 247, 0.08)", stroke: "rgba(126, 34, 206, 0.45)", label: "#7e22ce", detail: "var(--muted)" },
  nuclear: { fill: "rgba(236, 72, 153, 0.08)", stroke: "rgba(190, 24, 93, 0.45)", label: "#be185d", detail: "var(--muted)" },
  output:  { fill: "rgba(16, 185, 129, 0.08)", stroke: "rgba(5, 150, 105, 0.45)", label: "var(--success)", detail: "var(--muted)" },
};

const BOX_WIDTH = 720;
const BOX_HEIGHT = 64;
const CENTER_X = 400;
const SVG_WIDTH = 820;
const SVG_HEIGHT = 980;

export default function ArchitectureDiagram() {
  return (
    <div className="w-full overflow-x-auto -mx-2 px-2">
      <svg
        viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
        role="img"
        aria-label={`GateTest scan pipeline architecture: customer push enters via GitHub App or Gluecron Signal Bus, lands in a Postgres scan queue, runs through ${TOTAL_MODULES} deterministic modules, clusters and ranks findings, replays a promoted fix recipe or asks Claude for a fix, validates each fix through a syntax gate and scanner re-validation, adds pair review and architecture annotation for Tier 2 and up, adds cross-finding correlation, per-finding Claude diagnosis, and executive summary for Tier 3 (mutation testing and chaos / fuzz pass are available via the GitHub Action where a CI runner is present), and finally opens a pull request.`}
        className="w-full h-auto min-w-[640px]"
      >
        <defs>
          <marker
            id="arrow-head"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 Z" fill="var(--muted)" />
          </marker>
        </defs>

        {/* Arrows */}
        {NODES.map((node, index) => {
          if (index === NODES.length - 1) return null;
          const next = NODES[index + 1];
          const startY = node.y + BOX_HEIGHT;
          const endY = next.y;
          return (
            <line
              key={`arrow-${node.id}`}
              x1={CENTER_X}
              y1={startY}
              x2={CENTER_X}
              y2={endY - 2}
              stroke="var(--border-strong)"
              strokeWidth="2"
              markerEnd="url(#arrow-head)"
            />
          );
        })}

        {/* Nodes */}
        {NODES.map((node) => {
          const v = VARIANT_STYLES[node.variant ?? "engine"];
          const x = CENTER_X - BOX_WIDTH / 2;
          return (
            <g key={node.id}>
              <rect
                x={x}
                y={node.y}
                width={BOX_WIDTH}
                height={BOX_HEIGHT}
                rx={10}
                ry={10}
                fill={v.fill}
                stroke={v.stroke}
                strokeWidth="1.25"
              />
              <text
                x={CENTER_X}
                y={node.y + 26}
                textAnchor="middle"
                fontFamily="ui-monospace, 'SF Mono', Menlo, monospace"
                fontSize="14"
                fontWeight="600"
                fill={v.label}
              >
                {node.label}
              </text>
              {node.detail && (
                <text
                  x={CENTER_X}
                  y={node.y + 47}
                  textAnchor="middle"
                  fontFamily="ui-monospace, 'SF Mono', Menlo, monospace"
                  fontSize="11.5"
                  fill={v.detail}
                >
                  {node.detail}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
