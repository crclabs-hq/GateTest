"use client";

/**
 * /admin/secrets — the panel's title bar, status cards (store, env file,
 * step-up) and the "not applied yet" notice. Presentational only; the panel
 * owns the state.
 */

import type { ReactNode } from "react";
import type { SecretsList } from "./api";
import { applyStateCopy } from "./logic";

export const FIX_DOC = "docs/ops/secrets-panel.md";

export function Mark({ shape, ink }: { shape: "dot" | "ring"; ink: "accent" | "ink" | "muted" }) {
  return <span className={`gs-mark ${shape} ${ink}`} aria-hidden="true" />;
}

export function Header({ children }: { children?: ReactNode }) {
  return (
    <div className="gs-head">
      <div>
        <h1 className="gs-title">Secrets</h1>
        <p className="gs-sub">
          Infrastructure secrets for this service. Values are typed here by the owner, encrypted at rest, written to the
          service env file on Apply, and never shown back — only an 8-character fingerprint.
        </p>
      </div>
      {children ? <div className="gs-head-actions">{children}</div> : null}
    </div>
  );
}

export function StatusCards({ data, now, freshLabel }: { data: SecretsList; now: number; freshLabel: string | null }) {
  const storeReady = data.storeReady;
  const applyLine = applyStateCopy(data.applyState, now);
  // Pending (store changed, not applied yet) is the normal state between a
  // save and Apply: a hollow muted ring and regular weight, never the
  // semibold "problem" treatment.
  const problem = !applyLine.ok && !applyLine.pending;
  return (
    <section className="gs-status" aria-label="Status">
      <div className="gs-status-card">
        <h2>Store</h2>
        {storeReady ? (
          <p className="gs-status-line">
            <Mark shape="dot" ink="accent" /> Ready
            {data.keyVersion !== null && data.keyVersion !== undefined ? (
              <span className="gs-small">· key v{String(data.keyVersion)}</span>
            ) : null}
          </p>
        ) : (
          <>
            <p className="gs-status-line gs-strong">
              <Mark shape="dot" ink="ink" /> Master key not configured
            </p>
            {data.storeError ? <p className="gs-status-fix">{data.storeError}</p> : null}
            <p className="gs-status-fix">
              Owner fix: set the master key on the box and restart — see <code>{FIX_DOC}</code>.
            </p>
          </>
        )}
      </div>
      <div className="gs-status-card">
        <h2>Env file</h2>
        <p className={`gs-status-line${problem ? " gs-strong" : ""}`}>
          <Mark shape={applyLine.ok ? "dot" : "ring"} ink={applyLine.ok ? "accent" : applyLine.pending ? "muted" : "ink"} />{" "}
          {applyLine.text}
        </p>
        {data.unitEnvPath ? (
          <p className="gs-status-fix">
            Writes <code>{data.unitEnvPath}</code>
          </p>
        ) : null}
      </div>
      <div className="gs-status-card">
        <h2>Step-up</h2>
        <p className="gs-status-line">
          {freshLabel ? (
            <>
              <Mark shape="dot" ink="accent" /> {freshLabel}
            </>
          ) : (
            <>
              <Mark shape="ring" ink="muted" /> Password asked on the next change or reveal
            </>
          )}
        </p>
      </div>
    </section>
  );
}

/**
 * Shown while the store holds changes the env file does not have yet
 * (listing reason `out_of_sync`). Neutral: this is the expected state after a
 * save whose own apply did not run, not a failure.
 */
export function PendingApplyNotice({
  storeReady,
  applying,
  onApply,
}: {
  storeReady: boolean;
  applying: boolean;
  onApply: () => void;
}) {
  return (
    <div className="gs-notice neutral gs-notice-row" role="status">
      <span>
        The store has changes the env file does not have yet. Apply to service writes them; the service then restarts
        itself.
      </span>
      <button type="button" className="gs-btn small primary" disabled={!storeReady || applying} onClick={onApply}>
        {applying ? "Applying…" : "Apply to service"}
      </button>
    </div>
  );
}
