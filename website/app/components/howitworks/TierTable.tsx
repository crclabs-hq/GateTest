/**
 * The four-tier comparison table — Quick / Full / Scan+Fix / Forensic.
 * Be honest about what's in and what's NOT. Engineers respect honesty.
 */

type Row = {
  feature: string;
  quick: boolean | string;
  full: boolean | string;
  scanFix: boolean | string;
  nuclear: boolean | string;
};

const ROWS: Row[] = [
  { feature: "Price",                                       quick: "$29",   full: "$99",  scanFix: "$199", nuclear: "$399" },
  { feature: "Modules run (every module that applies to a repo)", quick: "4", full: "All", scanFix: "All", nuclear: "All + nuclear suite" },
  { feature: "Findings clustering by root cause",           quick: true,    full: true,   scanFix: true,   nuclear: true   },
  { feature: "Health score / verdict",                      quick: true,    full: true,   scanFix: true,   nuclear: true   },
  { feature: "Detailed report (file, line, advisory)",      quick: true,    full: true,   scanFix: true,   nuclear: true   },
  { feature: "AI code review (Claude reads your code)",     quick: false,   full: true,   scanFix: true,   nuclear: true   },
  { feature: "Auto-PR with working fixes",                  quick: false,   full: false,  scanFix: true,   nuclear: true   },
  { feature: "Iterative fix loop with retry",               quick: false,   full: false,  scanFix: true,   nuclear: true   },
  { feature: "Cross-fix syntax + scanner gate",             quick: false,   full: false,  scanFix: true,   nuclear: true   },
  { feature: "Regression test generated per fix",           quick: false,   full: false,  scanFix: true,   nuclear: true   },
  { feature: "Pair-review (second Claude critiques fixes)", quick: false,   full: false,  scanFix: true,   nuclear: true   },
  { feature: "Architecture annotations",                    quick: false,   full: false,  scanFix: true,   nuclear: true   },
  { feature: "Per-finding Claude diagnosis",                quick: false,   full: false,  scanFix: false,  nuclear: true   },
  { feature: "Cross-finding attack-chain correlation",      quick: false,   full: false,  scanFix: false,  nuclear: true   },
  { feature: "Mutation testing (via GitHub Action)",        quick: false,   full: false,  scanFix: false,  nuclear: "Action"  },
  { feature: "Chaos / fuzz pass (via GitHub Action)",       quick: false,   full: false,  scanFix: false,  nuclear: "Action"  },
  { feature: "CTO-readable executive summary",              quick: false,   full: false,  scanFix: false,  nuclear: true   },
];

function Cell({ value }: { value: boolean | string }) {
  if (typeof value === "string") {
    return <span className="font-mono text-foreground">{value}</span>;
  }
  if (value) {
    return <span className="text-success font-bold text-base" aria-label="yes">&#10003;</span>;
  }
  return <span className="text-muted/70" aria-label="no">no</span>;
}

export default function TierTable() {
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-border overflow-x-auto">
        <table className="w-full text-sm min-w-[640px]">
          <thead>
            <tr className="border-b border-border bg-surface-light">
              <th className="text-left px-5 py-4 text-muted font-medium">What you get</th>
              <th className="text-center px-4 py-4 text-foreground font-semibold">Quick</th>
              <th className="text-center px-4 py-4 text-foreground font-semibold">Full</th>
              <th className="text-center px-4 py-4 text-accent font-semibold">Scan + Fix</th>
              <th className="text-center px-4 py-4 text-pink-700 font-semibold">Forensic</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr
                key={row.feature}
                className="border-b border-border last:border-0 hover:bg-surface-light transition-colors"
              >
                <td className="px-5 py-3 text-foreground-secondary">{row.feature}</td>
                <td className="px-4 py-3 text-center"><Cell value={row.quick} /></td>
                <td className="px-4 py-3 text-center"><Cell value={row.full} /></td>
                <td className="px-4 py-3 text-center"><Cell value={row.scanFix} /></td>
                <td className="px-4 py-3 text-center"><Cell value={row.nuclear} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted px-1">
        <span className="font-mono text-foreground">Action</span> = available via the GitHub Action with{" "}
        <span className="font-mono text-foreground">mutation: true</span> /{" "}
        <span className="font-mono text-foreground">chaos: true</span>. These two checks need a CI runner
        (your test suite for mutation, a headless browser for chaos) so they run wherever your CI runs,
        not on the website-only scan flow.
      </p>
    </div>
  );
}
