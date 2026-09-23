"use client";

// Split out of page.tsx so the page itself can be a Server Component (#679
// item 5 — the install snippets below must be in the first HTML response;
// a page-wide "use client" directive was suppressing that for the whole
// tree, this button included). Behavior and markup are unchanged from the
// version that lived inline in page.tsx.

import { useState } from "react";

type CopyState = "idle" | "copied" | "failed";

export default function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<CopyState>("idle");

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
      setTimeout(() => setState("idle"), 2000);
    } catch (_err) {
      setState("failed");
      setTimeout(() => setState("idle"), 2000);
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="shrink-0 flex items-center gap-1.5 text-xs text-panel-muted hover:text-accent-light transition-colors"
    >
      {state === "copied" ? (
        <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>Copied</>
      ) : state === "failed" ? (
        <>&#x2715; Failed</>
      ) : (
        <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>{label}</>
      )}
    </button>
  );
}
