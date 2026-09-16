"use client";

/**
 * <FindingWrong> — the web equivalent of the CLI's "wrong? add to
 * .gatetestignore" hint. One small link on a finding row; a click POSTs a
 * down rating on surface "finding" with the rule id and file path only —
 * never the finding text or code — and shows "Thanks — recorded" inline.
 *
 * The API opens (or comments on) a "Possible false positive: <rule>" issue
 * on our repository, so a wrong rule reaches the engineers the same day.
 */

import { useState } from "react";

interface Props {
  /** `module` or `module:rule` — the .gatetestignore identity of the finding. */
  rule: string;
  file?: string | null;
  scanId?: string | null;
  tier?: string | null;
  className?: string;
}

type Stage = "idle" | "sending" | "done" | "failed";

export function FindingWrong({ rule, file, scanId, tier, className = "" }: Props) {
  const [stage, setStage] = useState<Stage>("idle");

  async function report(e: React.MouseEvent<HTMLButtonElement>) {
    // Rows live inside <summary> / clickable containers — the click must not
    // toggle or navigate the row it sits on.
    e.preventDefault();
    e.stopPropagation();
    if (stage === "sending" || stage === "done") return;
    setStage("sending");
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          surface: "finding",
          rating: "down",
          rule,
          text: `${rule} reported wrong on ${file || "this scan"}`,
          scanId: scanId || undefined,
          tier: tier || undefined,
          page: window.location.pathname,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStage("done");
    } catch {
      setStage("failed");
    }
  }

  if (stage === "done") {
    return <span className={`text-[11px] text-muted whitespace-nowrap ${className}`} aria-live="polite">Thanks — recorded</span>;
  }

  return (
    <button
      type="button"
      onClick={report}
      disabled={stage === "sending"}
      title="Tell us this finding is wrong"
      className={`text-[11px] font-medium text-muted hover:text-accent underline-offset-2 hover:underline whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded disabled:opacity-60 ${className}`}
    >
      {stage === "sending" ? "Sending…" : stage === "failed" ? "Wrong? (retry)" : "Wrong?"}
    </button>
  );
}
