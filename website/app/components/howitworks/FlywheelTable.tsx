/**
 * The four fix-pipeline stages, side-by-side. Each stage is a column on
 * desktop, stacks on mobile. Matches what ships: recipe playback
 * (src/core/flywheel-playback-engine.js) ahead of the Claude surgical-fix
 * path, with the syntax and scanner gates every candidate patch must clear
 * (cross-fix-syntax-gate / cross-fix-scanner-gate on the hosted route,
 * syntax + test ranking in cli-fix-orchestrator.js on the CI path).
 */

type Layer = {
  number: string;
  name: string;
  cost: string;
  description: string;
  wins: string;
  example: { before: string; after: string };
  accent: string;
  border: string;
  bg: string;
};

const LAYERS: Layer[] = [
  {
    number: "1",
    name: "Recipe",
    cost: "$0.00",
    description: "Deterministic replay of fixes Claude has already proven. A recipe is distilled from a small, templatey Claude diff and replays only after it has been confirmed enough times to be promoted to stable — an unproven patch never auto-applies.",
    wins: "Repeat shapes Claude has solved before, once their recipe has earned promotion. Zero cost, zero model call.",
    example: {
      before: "// match by ruleKey + file ext\n// hit: js-reject-unauthorized\n// recipe status: stable",
      after:  "// recipe applied, zero cost\n// Claude never called",
    },
    accent: "text-amber-700",
    border: "border-amber-500/30",
    bg: "bg-amber-500/[0.04]",
  },
  {
    number: "2",
    name: "Claude",
    cost: "paid",
    description: "Claude proposes a minimal, surgical diff for the finding — model chosen per tier. On the CI path it generates three competing hypotheses in a single call and the best-ranked candidate wins. Capped per tier so spend never exceeds margin.",
    wins: "First-time-seen patterns. Bespoke business-logic bugs. Anything a template can't model.",
    example: {
      before: "// novel pattern: ad-hoc auth check\n// mixed with feature-flag rollout\n// no canonical shape",
      after:  "// Claude reasons from your code\n// three hypotheses, best wins\n// smallest diff that fixes it",
    },
    accent: "text-pink-700",
    border: "border-pink-500/30",
    bg: "bg-pink-500/[0.04]",
  },
  {
    number: "3",
    name: "Syntax gate",
    cost: "$0.00",
    description: "Every candidate patch must parse. A patch that breaks the file's syntax is discarded on the spot, a crash falls through to the next candidate, and a no-op diff is rejected outright.",
    wins: "Stops a bad patch before it can touch your branch — nothing that fails to parse ever reaches a PR.",
    example: {
      before: "// candidate patch B\n// parse → SyntaxError",
      after:  "// discarded, never applied\n// candidate A carries on",
    },
    accent: "text-indigo-700",
    border: "border-indigo-500/30",
    bg: "bg-indigo-500/[0.04]",
  },
  {
    number: "4",
    name: "Scanner gate",
    cost: "$0.00",
    description: "The fixed file is re-scanned by the same engine that raised the finding. The fix must make the original finding disappear without raising anything new — on the CI path your own test suite is run as the final judge.",
    wins: "Proves the fix is real. A patch that silences the symptom but fails the re-scan or the tests never ships.",
    example: {
      before: "// re-scan: finding gone?\n// new findings introduced?\n// tests still green?",
      after:  "// all three yes → patch lands\n// any no → rejected",
    },
    accent: "text-accent",
    border: "border-teal-500/30",
    bg: "bg-teal-500/[0.04]",
  },
];

export default function FlywheelTable() {
  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {LAYERS.map((layer) => (
        <div
          key={layer.number}
          className={`rounded-xl border ${layer.border} ${layer.bg} p-5 flex flex-col`}
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-muted">{layer.number}</span>
              <span className={`font-mono font-bold text-base ${layer.accent}`}>{layer.name}</span>
            </div>
            <span className="text-xs font-mono text-muted px-2 py-0.5 rounded-full border border-border bg-surface-light">
              {layer.cost}
            </span>
          </div>

          <p className="text-sm text-foreground-secondary leading-relaxed mb-4">{layer.description}</p>

          <div className="mb-4">
            <div className="text-[10px] uppercase tracking-wider text-muted font-semibold mb-1.5">
              When it wins
            </div>
            <p className="text-sm text-foreground-secondary leading-relaxed">{layer.wins}</p>
          </div>

          <div className="mt-auto pt-3 border-t border-border">
            <div className="text-[10px] uppercase tracking-wider text-muted font-semibold mb-1.5">
              Example
            </div>
            <pre className="text-[11px] text-danger font-mono whitespace-pre-wrap leading-snug bg-red-500/[0.06] rounded-md p-2 mb-1.5 border border-red-500/15">
{layer.example.before}
            </pre>
            <pre className="text-[11px] text-success font-mono whitespace-pre-wrap leading-snug bg-emerald-500/[0.06] rounded-md p-2 border border-emerald-500/15">
{layer.example.after}
            </pre>
          </div>
        </div>
      ))}
    </div>
  );
}
