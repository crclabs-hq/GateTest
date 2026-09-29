"use client";

/**
 * The panel's dialogs: set / replace / add, reveal, delete, step-up, and the
 * audit drawer.
 *
 * Value handling (owner rule): a value lives in exactly one piece of React
 * state inside the dialog that needs it, is never logged, never written to
 * a URL or to browser storage, is cleared on success, and is cleared on
 * unmount. Value inputs are password-type with autocomplete and spellcheck
 * off; the owner can toggle "Show" for their own eyes only.
 */

import { useEffect, useId, useState } from "react";
import { Modal } from "./Modal";
import {
  SecretsApiError,
  deleteSecret,
  listAudit,
  revealSecret,
  setSecret,
  stepUp,
  type AuditEntry,
  type DeleteResult,
  type SetResult,
} from "./api";
import {
  REVEAL_MS,
  clockTime,
  deleteConfirmed,
  errorCopy,
  generateSecretValue,
  nameProblem,
  relativeTime,
  scheduleRevealClear,
} from "./logic";

/** Runs a call, asking for step-up and retrying once on step_up_required. */
export type Guarded = <T>(fn: () => Promise<T>) => Promise<T>;

function messageFor(err: unknown): string {
  if (err instanceof SecretsApiError) return errorCopy(err.code, err.status);
  return errorCopy("network");
}

// ---------------------------------------------------------------------------
// Set / Replace / Add custom
// ---------------------------------------------------------------------------
export function SetSecretDialog({
  mode,
  initialName,
  guarded,
  onClose,
  onSaved,
}: {
  mode: "set" | "replace" | "add";
  initialName: string;
  guarded: Guarded;
  onClose: () => void;
  onSaved: (name: string, result: SetResult) => void;
}) {
  const titleId = useId();
  const nameId = useId();
  const valueId = useId();
  const [name, setName] = useState(initialName);
  const [value, setValue] = useState("");
  const [showValue, setShowValue] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Clear the value from state when the dialog goes away, however it goes.
  useEffect(() => () => setValue(""), []);

  const title = mode === "add" ? "Add custom secret" : mode === "replace" ? `Replace ${initialName}` : `Set ${initialName}`;

  function onGenerate() {
    try {
      setValue(generateSecretValue(48));
      setShowValue(false);
      setError(null);
    } catch {
      setError("This browser has no secure random source, so a value cannot be generated here.");
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const n = name.trim();
    const problem = mode === "add" ? nameProblem(n) : null;
    if (problem) {
      setError(problem);
      return;
    }
    if (value.length === 0) {
      setError(errorCopy("value_empty"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await guarded(() => setSecret(n, value));
      setValue("");
      setShowValue(false);
      onSaved(n, result);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal labelledBy={titleId} onClose={onClose}>
      <form className="gs-dialog-body" onSubmit={onSubmit} autoComplete="off">
        <h2 id={titleId}>{title}</h2>
        <p>
          The value goes straight to the encrypted store. It is never shown back after saving — only its
          fingerprint.
        </p>
        {mode === "add" ? (
          <label className="gs-field" htmlFor={nameId}>
            Name
            <input
              id={nameId}
              className="gs-input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value.toUpperCase())}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="characters"
              placeholder="MY_SERVICE_TOKEN"
              data-autofocus
            />
          </label>
        ) : null}
        <label className="gs-field" htmlFor={valueId}>
          Value
          <span className="gs-field-row">
            <input
              id={valueId}
              className="gs-input"
              type={showValue ? "text" : "password"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              data-lpignore="true"
              data-1p-ignore
              data-autofocus={mode === "add" ? undefined : true}
            />
            <button
              type="button"
              className="gs-btn small"
              aria-pressed={showValue}
              onClick={() => setShowValue((s) => !s)}
            >
              {showValue ? "Hide" : "Show"}
            </button>
          </span>
        </label>
        {error ? (
          <p className="gs-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="gs-dialog-foot">
          <button type="button" className="gs-btn" onClick={onGenerate} disabled={busy}>
            Generate
          </button>
          <button type="button" className="gs-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="gs-btn primary" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

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

// ---------------------------------------------------------------------------
// Delete — confirm by typing the name
// ---------------------------------------------------------------------------
export function DeleteDialog({
  name,
  guarded,
  onClose,
  onDeleted,
}: {
  name: string;
  guarded: Guarded;
  onClose: () => void;
  onDeleted: (name: string, result: DeleteResult) => void;
}) {
  const titleId = useId();
  const confirmId = useId();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = deleteConfirmed(typed, name);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await guarded(() => deleteSecret(name));
      onDeleted(name, result);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal labelledBy={titleId} onClose={onClose}>
      <form className="gs-dialog-body" onSubmit={onSubmit} autoComplete="off">
        <h2 id={titleId}>
          Delete <span className="gs-mono">{name}</span>
        </h2>
        <p>
          This removes the value from the store and rewrites the env file. Services that read it lose it on their next
          restart. Type the name to confirm.
        </p>
        <label className="gs-field" htmlFor={confirmId}>
          Name
          <input
            id={confirmId}
            className="gs-input"
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            data-autofocus
          />
        </label>
        {error ? (
          <p className="gs-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="gs-dialog-foot">
          <button type="button" className="gs-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="gs-btn destructive solid" disabled={!ok || busy}>
            {busy ? "Deleting…" : "Delete"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Step-up — re-enter the admin password
// ---------------------------------------------------------------------------
export function StepUpDialog({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: (freshUntil: string) => void;
}) {
  const titleId = useId();
  const pwId = useId();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => setPassword(""), []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || password.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const r = await stepUp(password);
      setPassword("");
      onSuccess(r.freshUntil);
    } catch (err) {
      setPassword("");
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal labelledBy={titleId} onClose={onClose}>
      <form className="gs-dialog-body" onSubmit={onSubmit}>
        <h2 id={titleId}>Confirm it is you</h2>
        <p>Changing or revealing a secret needs your admin password again. It stays fresh for a few minutes.</p>
        <label className="gs-field" htmlFor={pwId}>
          Admin password
          <input
            id={pwId}
            className="gs-input"
            type="password"
            autoComplete="current-password"
            spellCheck={false}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-autofocus
          />
        </label>
        {error ? (
          <p className="gs-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="gs-dialog-foot">
          <button type="button" className="gs-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="gs-btn primary" disabled={busy || password.length === 0}>
            {busy ? "Checking…" : "Continue"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Audit drawer — last 50 entries, never values
// ---------------------------------------------------------------------------
export function AuditDrawer({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    listAudit(50)
      .then((r) => {
        if (!cancelled) setEntries(Array.isArray(r.entries) ? r.entries : []);
      })
      .catch((err) => {
        if (!cancelled) setError(messageFor(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Modal labelledBy={titleId} onClose={onClose} className="gs-drawer">
      <div className="gs-dialog-body">
        <div className="gs-head">
          <h2 id={titleId}>Audit log</h2>
          <button type="button" className="gs-btn small" onClick={onClose} data-autofocus>
            Close
          </button>
        </div>
        <p>The last 50 actions on this panel. Names and outcomes only — values are never recorded.</p>
        {error ? (
          <p className="gs-error" role="alert">
            {error}
          </p>
        ) : entries === null ? (
          <p className="gs-small">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="gs-small">No actions recorded yet.</p>
        ) : (
          <ul className="gs-audit">
            {entries.map((e, i) => (
              <li key={`${e.at}-${i}`}>
                <span className="gs-audit-what">
                  <strong>{e.action}</strong> <span className="gs-mono">{e.name}</span>
                </span>
                <span className={e.outcome === "ok" || e.outcome === "success" ? "gs-ink-accent" : "gs-ink-ink gs-strong"}>
                  {e.outcome}
                </span>
                <span>
                  {e.actor}
                  {e.ip ? ` · ${e.ip}` : ""}
                </span>
                <time dateTime={e.at} title={e.at}>
                  {relativeTime(e.at, now) || e.at} · {clockTime(e.at)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
