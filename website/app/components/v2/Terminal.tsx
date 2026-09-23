import type { ReactNode } from "react";

export interface TerminalLine {
  text: string;
  /** "bad" (red) or "dim" (muted) — matches the .term line classes. */
  tone?: "bad" | "dim";
}

/**
 * The v2 terminal / code block. `max-width: 100%` and `overflow-x: auto`
 * live on the block itself (globals.css `.term` / `.term-body`), so this
 * component can never be the thing that scrolls a page sideways at 375px —
 * the defect #678 is fixing on the old preview-only copy. New pages should
 * use this one instead of hand-rolling a <pre>.
 */
export function Terminal({
  label,
  status,
  lines,
  children,
}: {
  label: string;
  /** Right-aligned header text, e.g. "exit 1" or "running". */
  status?: ReactNode;
  lines?: TerminalLine[];
  children?: ReactNode;
}) {
  return (
    <div className="term" aria-label={`Terminal output: ${label}`}>
      <div className="term-head">
        <span>{label}</span>
        {status && <span>{status}</span>}
      </div>
      <div className="term-body">
        {lines
          ? lines.map((l, i) => (
              <div key={i} className={l.tone}>{l.text || " "}</div>
            ))
          : children}
      </div>
    </div>
  );
}
