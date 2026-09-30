"use client";

/**
 * /admin/secrets — the secrets table: one tbody per tier, one row per
 * secret, a shadow callout under a shadowed row. Presentational only.
 */

import type { SecretItem } from "./api";
import {
  livenessDetail,
  livenessMark,
  relativeTime,
  shadowCopy,
  shortFingerprint,
  sourceLabel,
  stateMark,
  type groupByTier,
} from "./logic";
import { Mark } from "./PanelHeader";

const COLUMNS = 7;

export function SecretsTable({
  groups,
  now,
  storeReady,
  verifyingName,
  onSet,
  onReveal,
  onDelete,
  onVerify,
}: {
  groups: ReturnType<typeof groupByTier<SecretItem>>;
  now: number;
  storeReady: boolean;
  verifyingName: string | null;
  onSet: (item: SecretItem) => void;
  onReveal: (name: string) => void;
  onDelete: (name: string) => void;
  onVerify: (name: string) => void;
}) {
  return groups.length === 0 ? (
    <div className="gs-empty">
      <p>No secrets are declared yet.</p>
      <p className="gs-small">Add a custom secret, or declare required ones in the server&apos;s secrets catalogue.</p>
    </div>
  ) : (
    <div className="gs-table-wrap">
      <table className="gs-table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">State</th>
            <th scope="col">Source</th>
            <th scope="col">Fingerprint</th>
            <th scope="col">Updated</th>
            <th scope="col">Liveness</th>
            <th scope="col">
              <span className="gs-sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        {groups.map((g) => (
          <tbody key={g.tier}>
            <tr className="gs-tier-row">
              <th scope="colgroup" colSpan={COLUMNS}>
                {g.label} <span className="gs-small">({g.items.length})</span>
              </th>
            </tr>
            {g.items.map((item) => (
              <SecretRow
                key={item.name}
                item={item}
                now={now}
                storeReady={storeReady}
                verifying={verifyingName === item.name}
                onSet={() => onSet(item)}
                onReveal={() => onReveal(item.name)}
                onDelete={() => onDelete(item.name)}
                onVerify={() => onVerify(item.name)}
              />
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

function SecretRow({
  item,
  now,
  storeReady,
  verifying,
  onSet,
  onReveal,
  onDelete,
  onVerify,
}: {
  item: SecretItem;
  now: number;
  storeReady: boolean;
  verifying: boolean;
  onSet: () => void;
  onReveal: () => void;
  onDelete: () => void;
  onVerify: () => void;
}) {
  const mark = stateMark(item.state);
  const live = livenessMark(item.liveness);
  const fp = shortFingerprint(item.fingerprint);
  const inStore = item.source === "store" || item.source === "both";
  const updated = item.updatedAt ? relativeTime(item.updatedAt, now) : "";

  return (
    <>
      <tr className="gs-row">
        <td data-label="Name">
          <div className="gs-name">{item.name}</div>
          {item.why ? <div className="gs-why">{item.why}</div> : null}
        </td>
        <td data-label="State">
          <span className={`gs-cell-line${mark.strong ? " gs-strong gs-ink-ink" : ""}`}>
            <Mark shape={mark.shape} ink={mark.ink} />
            {mark.label}
          </span>
        </td>
        <td data-label="Source">{sourceLabel(item.source)}</td>
        <td data-label="Fingerprint">
          {fp ? (
            <span>
              <span className="gs-sr-only">fingerprint </span>
              <span className="gs-small" aria-hidden="true">
                fingerprint{" "}
              </span>
              <span className="gs-fp">{fp}</span>
            </span>
          ) : (
            <span className="gs-small">—</span>
          )}
        </td>
        <td data-label="Updated">
          {item.updatedAt ? (
            <span>
              <time dateTime={item.updatedAt} title={item.updatedAt}>
                {updated || item.updatedAt}
              </time>
              {item.updatedBy ? <span className="gs-small"> by {item.updatedBy}</span> : null}
            </span>
          ) : (
            <span className="gs-small">—</span>
          )}
        </td>
        <td data-label="Liveness">
          <span className={`gs-ink-${live.ink}${live.strong ? " gs-strong" : ""}`}>{live.label}</span>
          <div className="gs-small">{livenessDetail(item.liveness, item.lastVerifiedAt, now)}</div>
        </td>
        <td data-label="Actions">
          {item.reserved ? (
            <span className="gs-reserved">Reserved — set in the box env file only</span>
          ) : (
            <div className="gs-actions">
              <button type="button" className="gs-btn small" disabled={!storeReady} onClick={onSet}>
                {item.state === "set" ? "Replace" : "Set"}
              </button>
              <button type="button" className="gs-btn small" disabled={verifying || item.state !== "set"} onClick={onVerify}>
                {verifying ? "Verifying…" : "Verify"}
              </button>
              <button type="button" className="gs-btn small" disabled={!storeReady || !inStore} onClick={onReveal}>
                Reveal
              </button>
              <button type="button" className="gs-btn small destructive" disabled={!storeReady || !inStore} onClick={onDelete}>
                Delete
              </button>
            </div>
          )}
        </td>
      </tr>
      {item.shadowed ? (
        <tr className="gs-callout-row">
          <td colSpan={COLUMNS}>
            <p className="gs-callout">
              <Mark shape="ring" ink="ink" />
              {shadowCopy(item.shadowWinner)}
            </p>
          </td>
        </tr>
      ) : null}
    </>
  );
}
