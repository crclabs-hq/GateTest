"use client";

/**
 * <ScanFeedback> — one question under every hosted scan result.
 *
 *   Was this scan useful?  [Yes] [No]  ×
 *
 * "No" opens one optional line ("What was wrong or missing?") and Send.
 * Quiet by design: inline, no modal, shown once per scan — the answer or
 * the dismissal is remembered in localStorage per scan id (per page when a
 * surface has no id), so a returning customer is never asked twice.
 *
 * POSTs to /api/feedback, which stores the event and, when the rating is
 * down and text is present, opens a GitHub issue on our repository so the
 * complaint reaches us before it reaches a review site.
 */

import { useEffect, useId, useState } from "react";

interface Props {
  /** Where the customer is: "repo" | "web" | "wp" | "preview" | … */
  surface: string;
  scanId?: string | null;
  tier?: string | null;
  /** Storage key when there is no scan id (the free preview) — e.g. the repo URL. */
  contextKey?: string | null;
  className?: string;
}

type Stage = "hidden" | "ask" | "why" | "sending" | "done" | "failed";

function storageKey(surface: string, scanId?: string | null, contextKey?: string | null): string {
  return `gt-feedback:${surface}:${scanId || contextKey || "page"}`;
}

function remember(key: string): void {
  try { window.localStorage.setItem(key, String(Date.now())); } catch { /* error-ok — storage blocked; the prompt simply shows again next time */ }
}

function remembered(key: string): boolean {
  try { return Boolean(window.localStorage.getItem(key)); } catch { return false; }
}

const BUTTON = "px-3 py-1.5 rounded-lg border border-border bg-white text-sm font-medium text-foreground hover:border-accent hover:text-accent transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60";

export function ScanFeedback({ surface, scanId, tier, contextKey, className = "" }: Props) {
  const key = storageKey(surface, scanId, contextKey);
  const inputId = useId();
  const [stage, setStage] = useState<Stage>("hidden");
  const [text, setText] = useState("");

  useEffect(() => {
    // Start hidden, reveal on the client — avoids a server/client mismatch
    // and never re-asks about a scan this browser already answered.
    setStage(remembered(key) ? "hidden" : "ask");
    setText("");
  }, [key]);

  async function send(rating: "up" | "down", why?: string) {
    setStage("sending");
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scanId: scanId || undefined,
          surface,
          tier: tier || undefined,
          rating,
          text: why && why.trim() ? why.trim() : undefined,
          page: window.location.pathname,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      remember(key);
      setStage("done");
    } catch {
      setStage("failed");
    }
  }

  function dismiss() {
    remember(key);
    setStage("hidden");
  }

  if (stage === "hidden") return null;

  return (
    <div
      className={`rounded-xl border border-border bg-white px-4 py-3 text-sm ${className}`}
      role="group"
      aria-label="Scan feedback"
      aria-live="polite"
    >
      {stage === "ask" && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-medium text-foreground">Was this scan useful?</span>
          <button type="button" onClick={() => void send("up")} className={BUTTON}>Yes</button>
          <button type="button" onClick={() => setStage("why")} className={BUTTON}>No</button>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss"
            className="ml-auto px-2 text-muted hover:text-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded"
          >
            ×
          </button>
        </div>
      )}

      {stage === "why" && (
        <form
          onSubmit={(e) => { e.preventDefault(); void send("down", text); }}
          className="flex flex-wrap items-center gap-2"
        >
          <label htmlFor={inputId} className="sr-only">What was wrong or missing?</label>
          <input
            id={inputId}
            type="text"
            maxLength={1000}
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="What was wrong or missing? (optional)"
            className="flex-1 min-w-[200px] px-3 py-1.5 rounded-lg border border-border bg-white text-sm placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
          />
          <button type="submit" className={BUTTON}>Send</button>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss"
            className="px-2 text-muted hover:text-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded"
          >
            ×
          </button>
        </form>
      )}

      {stage === "sending" && <span className="text-muted">Sending…</span>}
      {stage === "done" && <span className="text-foreground">Thanks — recorded.</span>}
      {stage === "failed" && (
        <span className="text-muted">
          Could not record that.{" "}
          <button type="button" onClick={() => setStage("ask")} className="text-accent hover:underline font-medium">
            Try again
          </button>
        </span>
      )}
    </div>
  );
}
