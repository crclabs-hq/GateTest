"use client";

/**
 * Delete dialog: confirmed by typing the exact name.
 */

import { useId, useState } from "react";
import { Modal } from "./Modal";
import { deleteSecret, type DeleteResult } from "./api";
import { deleteConfirmed } from "./logic";
import { messageFor, type Guarded } from "./errors";

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
