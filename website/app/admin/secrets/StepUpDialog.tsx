"use client";

/**
 * Step-up dialog: re-enter the admin password; the caller retries the
 * original action once on success.
 */

import { useEffect, useId, useState } from "react";
import { Modal } from "./Modal";
import { stepUp } from "./api";
import { messageFor } from "./errors";

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
