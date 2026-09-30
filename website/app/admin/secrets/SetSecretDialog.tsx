"use client";

/**
 * Set / Replace / Add custom secret dialog.
 *
 * Value handling (owner rule): the value lives only in this dialog's state,
 * is never logged, never written to a URL or to browser storage, is cleared
 * on success and on unmount. The input is password-type with autocomplete
 * and spellcheck off; "Show" is for the owner's own eyes only.
 */

import { useEffect, useId, useState } from "react";
import { Modal } from "./Modal";
import { setSecret, type SetResult } from "./api";
import { errorCopy, generateSecretValue, nameProblem } from "./logic";
import { messageFor, type Guarded } from "./errors";

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
