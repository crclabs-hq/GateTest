"use client";

/**
 * Reveal dialog: masked by default, cleared from state after REVEAL_MS (30 s).
 *
 * Value handling (owner rule): the value lives only in this dialog's state,
 * is never logged, never written to a URL or to browser storage, and is
 * cleared when the timer fires and on unmount.
 */

import { useEffect, useId, useState } from "react";
import { Modal } from "./Modal";
import { revealSecret } from "./api";
import { REVEAL_MS, scheduleRevealClear } from "./logic";
import { messageFor, type Guarded } from "./errors";

// ---------------------------------------------------------------------------
// Reveal — 30 seconds, masked by default, then cleared from state
// ---------------------------------------------------------------------------
export function RevealDialog({ name, guarded, onClose }: { name: string; guarded: Guarded; onClose: () => void }) {
  const titleId = useId();
  const valueId = useId();
  const [value, setValue] = useState<string | null>(null);
  const [showValue, setShowValue] = useState(false);
  const [phase, setPhase] = useState<"loading" | "shown" | "cleared" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(Math.round(REVEAL_MS / 1000));
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let cancelClear: (() => void) | null = null;
    let tick: ReturnType<typeof setInterval> | null = null;
    guarded(() => revealSecret(name))
      .then((r) => {
        if (cancelled) return;
        setValue(r.value);
        setPhase("shown");
        const started = Date.now();
        tick = setInterval(() => {
          setSecondsLeft(Math.max(0, Math.round((REVEAL_MS - (Date.now() - started)) / 1000)));
        }, 1000);
        cancelClear = scheduleRevealClear(() => {
          setValue(null);
          setShowValue(false);
          setPhase("cleared");
          if (tick) clearInterval(tick);
        }, REVEAL_MS);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(messageFor(err));
        setPhase("error");
      });
    return () => {
      cancelled = true;
      cancelClear?.();
      if (tick) clearInterval(tick);
      setValue(null);
    };
  }, [guarded, name]);

  async function onCopy() {
    if (value === null) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setError("Copy failed — the browser blocked clipboard access.");
    }
  }

  return (
    <Modal labelledBy={titleId} onClose={onClose}>
      <div className="gs-dialog-body">
        <h2 id={titleId}>
          Reveal <span className="gs-mono">{name}</span>
        </h2>
        <p>
          Shown for {Math.round(REVEAL_MS / 1000)} seconds, masked until you choose Show, then cleared from this page.
          Every reveal is recorded in the audit log.
        </p>
        {/* Fixed-height row whatever the phase, so nothing shifts on reveal. */}
        <label className="gs-field" htmlFor={valueId}>
          Value
          <span className="gs-field-row">
            <input
              id={valueId}
              className="gs-input"
              type={showValue ? "text" : "password"}
              value={value ?? ""}
              readOnly
              autoComplete="off"
              spellCheck={false}
              data-lpignore="true"
              data-1p-ignore
              placeholder={phase === "loading" ? "Loading…" : phase === "cleared" ? "Cleared" : ""}
            />
            <button
              type="button"
              className="gs-btn small"
              aria-pressed={showValue}
              disabled={value === null}
              onClick={() => setShowValue((s) => !s)}
            >
              {showValue ? "Hide" : "Show"}
            </button>
            <button type="button" className="gs-btn small" disabled={value === null} onClick={onCopy}>
              {copied ? "Copied" : "Copy"}
            </button>
          </span>
        </label>
        <p className="gs-countdown" aria-live="polite">
          {phase === "shown"
            ? `Clears in ${secondsLeft} s`
            : phase === "cleared"
              ? `Cleared after ${Math.round(REVEAL_MS / 1000)} seconds.`
              : phase === "loading"
                ? "Fetching…"
                : " "}
        </p>
        {error ? (
          <p className="gs-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="gs-dialog-foot">
          <button type="button" className="gs-btn" onClick={onClose} data-autofocus>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
