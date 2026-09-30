"use client";

/**
 * Confirm removing names from the env file.
 *
 * Apply refuses (`would_drop_keys`) when the env file holds names the store no
 * longer has, and says which ones in `dropped`. This dialog lists them and,
 * on confirm, re-runs apply with exactly those names in `allowRemoving`. It
 * never widens the list: a name the server did not report cannot be removed
 * from here.
 */

import { useId, useState } from "react";
import { Modal } from "./Modal";
import { applySecrets, type ApplyResult } from "./api";
import { messageFor, type Guarded } from "./errors";

export function DropKeysDialog({
  names,
  guarded,
  onClose,
  onApplied,
}: {
  names: string[];
  guarded: Guarded;
  onClose: () => void;
  onApplied: (result: ApplyResult) => void;
}) {
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const one = names.length === 1;

  async function onConfirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await guarded(() => applySecrets(names));
      onApplied(result);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal labelledBy={titleId} onClose={onClose}>
      <div className="gs-dialog-body">
        <h2 id={titleId}>Remove {one ? "a name" : `${names.length} names`} from the env file?</h2>
        <p>
          The env file still holds {one ? "this name" : "these names"}, but the store no longer has{" "}
          {one ? "it" : "them"}. Apply stopped rather than drop {one ? "it" : "them"} silently. Applying now removes{" "}
          {one ? "it" : "them"} from the env file; the service loses {one ? "it" : "them"} on its next restart.
        </p>
        <ul className="gs-drop-list">
          {names.map((n) => (
            <li key={n} className="gs-mono">
              {n}
            </li>
          ))}
        </ul>
        {error ? (
          <p className="gs-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="gs-dialog-foot">
          <button type="button" className="gs-btn" onClick={onClose} disabled={busy} data-autofocus>
            Cancel
          </button>
          <button type="button" className="gs-btn destructive solid" onClick={() => void onConfirm()} disabled={busy}>
            {busy ? "Applying…" : one ? "Remove it and apply" : "Remove them and apply"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
