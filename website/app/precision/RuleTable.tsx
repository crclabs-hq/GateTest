"use client";

import { useState } from "react";
import { sortRules } from "../lib/precision-rules";

type RuleSortKey = "findings" | "onZeroCeilingRepos" | "controlPairs";

type PrecisionRule = {
  rule: string;
  module: string | null;
  findings: number;
  onZeroCeilingRepos: number;
  controlPairs: number;
  repos: Array<{ name: string; sha: string }>;
};

const columns: Array<{ key: RuleSortKey; label: string }> = [
  { key: "findings", label: "Findings on the corpus" },
  { key: "onZeroCeilingRepos", label: "On zero-ceiling repos" },
  { key: "controlPairs", label: "Control pairs" },
];

const numCell = "v2-mono text-right";

export default function RuleTable({ rules }: { rules: PrecisionRule[] }) {
  const [sortKey, setSortKey] = useState<RuleSortKey>("findings");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const rows = sortRules(rules, sortKey, dir);

  const toggle = (key: RuleSortKey) => {
    if (key === sortKey) setDir(dir === "desc" ? "asc" : "desc");
    else {
      setSortKey(key);
      setDir("desc");
    }
  };

  return (
    <div className="overflow-x-auto">
      <table className="v2-table min-w-[760px]">
        <thead>
          <tr>
            <th>Rule</th>
            <th>Module</th>
            {columns.map((c) => (
              <th key={c.key} className="text-right">
                <button
                  type="button"
                  onClick={() => toggle(c.key)}
                  className="v2-mono inline-flex items-center gap-1 hover:text-[var(--v2-accent)] transition-colors"
                  aria-label={`Sort by ${c.label}`}
                >
                  {c.label}
                  {sortKey === c.key ? <span aria-hidden="true">{dir === "desc" ? "↓" : "↑"}</span> : null}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.rule}>
              <td className="font-medium v2-mono">{r.rule}</td>
              <td className="text-[var(--v2-muted)]">{r.module ?? "unknown"}</td>
              <td className={numCell}>{r.findings}</td>
              <td className={`${numCell} ${r.onZeroCeilingRepos > 0 ? "text-[var(--v2-warn)]" : "text-[var(--v2-muted)]"}`}>
                {r.onZeroCeilingRepos}
              </td>
              <td className={`${numCell} ${r.controlPairs > 0 ? "text-[var(--v2-ok)]" : "text-[var(--v2-bad)]"}`}>
                {r.controlPairs}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
