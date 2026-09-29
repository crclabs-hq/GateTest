"use client";

/**
 * Audit drawer: the last 50 panel actions. Names and outcomes only, never values.
 *
 * The header says whether the hash chain over the whole trail still verifies
 * (intact / broken at entry N / cannot tell). It is intact only when the
 * server says so; loading, an error or a missing `chain` never read as intact.
 */

import { useEffect, useId, useState } from "react";
import { Modal } from "./Modal";
import { listAudit, type AuditChain, type AuditEntry } from "./api";
import { auditOutcomeMark, chainStatus, clockTime, middleTruncate, relativeTime } from "./logic";
import { messageFor } from "./errors";
import { Mark } from "./PanelHeader";

const IP_MAX = 20;

export function AuditDrawer({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [chain, setChain] = useState<AuditChain | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    listAudit(50)
      .then((r) => {
        if (cancelled) return;
        setEntries(Array.isArray(r.entries) ? r.entries : []);
        setChain(r.chain);
      })
      .catch((err) => {
        if (!cancelled) setError(messageFor(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loading = entries === null && error === null;
  const status = chainStatus(chain);

  return (
    <Modal labelledBy={titleId} onClose={onClose} className="gs-drawer">
      <div className="gs-dialog-body">
        <div className="gs-head">
          <h2 id={titleId}>Audit log</h2>
          <button type="button" className="gs-btn small" onClick={onClose} data-autofocus>
            Close
          </button>
        </div>
        <p className={`gs-status-line gs-chain${status.strong && !loading ? " gs-strong" : ""}`} aria-live="polite">
          {loading ? (
            <>
              <Mark shape="ring" ink="muted" /> Checking the chain…
            </>
          ) : (
            <>
              <Mark shape={status.shape} ink={status.ink} /> {status.text}
            </>
          )}
        </p>
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
            {entries.map((e, i) => {
              const mark = auditOutcomeMark(e);
              return (
                <li key={`${e.at}-${i}`}>
                  <span className="gs-audit-what">
                    <strong>{e.action}</strong> <span className="gs-mono">{e.name}</span>
                  </span>
                  <span className={`gs-ink-${mark.ink}${mark.strong ? " gs-strong" : ""}`}>{mark.label}</span>
                  <span>
                    {e.actor}
                    {e.ip ? (
                      <>
                        {" · "}
                        <span className="gs-mono" title={e.ip}>
                          {middleTruncate(e.ip, IP_MAX)}
                        </span>
                      </>
                    ) : null}
                  </span>
                  <time dateTime={e.at} title={e.at}>
                    {relativeTime(e.at, now) || e.at} · {clockTime(e.at)}
                  </time>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}
