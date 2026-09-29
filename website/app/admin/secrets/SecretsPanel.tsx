"use client";

/**
 * /admin/secrets — the infra-secrets panel (owner directive 2026-09-30).
 *
 * Layout after Tallrig's platform-secrets page: a status header (store,
 * apply, "Apply to service"), a table grouped by tier, per-row actions, and
 * an audit drawer. Everything the panel decides lives in ./logic.js; this
 * file only renders it.
 *
 * Values never live in this component — only in the dialog that needs one
 * (SecretDialogs.tsx), and only for as long as that dialog is open.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  SecretsApiError,
  applySecrets,
  listSecrets,
  verifySecret,
  type SecretItem,
  type SecretsList,
  type SetResult,
  type DeleteResult,
} from "./api";
import {
  applyResultCopy,
  applyStateCopy,
  clockTime,
  errorCopy,
  groupByTier,
  livenessDetail,
  livenessMark,
  relativeTime,
  runWithStepUp,
  shadowCopy,
  shortFingerprint,
  sourceLabel,
  stateMark,
  warningCopy,
} from "./logic";
import { AuditDrawer, DeleteDialog, RevealDialog, SetSecretDialog, StepUpDialog, type Guarded } from "./SecretDialogs";

type Notice = { id: number; tone: "ok" | "attention" | "neutral"; text: string };

type DialogState =
  | { kind: "set"; mode: "set" | "replace" | "add"; name: string }
  | { kind: "reveal"; name: string }
  | { kind: "delete"; name: string }
  | { kind: "audit" }
  | null;

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; data: SecretsList }
  | { phase: "error"; status: number; code: string };

const COLUMNS = 7;
const FIX_DOC = "docs/ops/secrets-panel.md";

function Mark({ shape, ink }: { shape: "dot" | "ring"; ink: "accent" | "ink" | "muted" }) {
  return <span className={`gs-mark ${shape} ${ink}`} aria-hidden="true" />;
}

export default function SecretsPanel() {
  const [load, setLoad] = useState<LoadState>({ phase: "loading" });
  const [dialog, setDialog] = useState<DialogState>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [freshUntil, setFreshUntil] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const stepUpResolver = useRef<((ok: boolean) => void) | null>(null);
  const noticeId = useRef(0);

  const refresh = useCallback(async () => {
    setLoad(await fetchLoadState());
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchLoadState().then((s) => {
      if (!cancelled) setLoad(s);
    });
    const t = setInterval(() => setNow(Date.now()), 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  // Any pending step-up promise is resolved "cancelled" if the page goes away.
  useEffect(
    () => () => {
      stepUpResolver.current?.(false);
      stepUpResolver.current = null;
    },
    [],
  );

  const requestStepUp = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        stepUpResolver.current?.(false);
        stepUpResolver.current = resolve;
        setStepUpOpen(true);
      }),
    [],
  );

  const guarded: Guarded = useCallback(<T,>(fn: () => Promise<T>) => runWithStepUp(fn, requestStepUp), [requestStepUp]);

  function finishStepUp(ok: boolean) {
    setStepUpOpen(false);
    const resolve = stepUpResolver.current;
    stepUpResolver.current = null;
    resolve?.(ok);
  }

  function pushNotices(list: Omit<Notice, "id">[]) {
    setNotices(list.map((n) => ({ ...n, id: ++noticeId.current })));
  }

  function onSaved(name: string, result: SetResult) {
    setDialog(null);
    const apply = applyResultCopy(result.apply);
    const out: Omit<Notice, "id">[] = [
      { tone: "ok", text: `${name} saved. Fingerprint ${shortFingerprint(result.fingerprint) || "not reported"}.` },
      { tone: apply.ok ? "ok" : "attention", text: apply.text },
    ];
    for (const w of result.warnings ?? []) {
      const text = warningCopy(w);
      if (text) out.push({ tone: "neutral", text });
    }
    pushNotices(out);
    void refresh();
  }

  function onDeleted(name: string, result: DeleteResult) {
    setDialog(null);
    const apply = applyResultCopy(result.apply);
    pushNotices([
      { tone: "ok", text: `${name} deleted from the store.` },
      {
        tone: apply.ok ? "ok" : "attention",
        text: apply.ok ? apply.text : apply.text.replace(/^Saved to the store, but/, "Deleted, but"),
      },
    ]);
    void refresh();
  }

  async function onVerify(name: string) {
    setBusy(`verify:${name}`);
    try {
      const r = await guarded(() => verifySecret(name));
      const mark = livenessMark(r.liveness);
      pushNotices([{ tone: r.liveness === "dead" ? "attention" : "neutral", text: `${name}: ${mark.label.toLowerCase()} (checked just now).` }]);
      void refresh();
    } catch (err) {
      pushNotices([{ tone: "attention", text: `${name}: ${errMessage(err)}` }]);
    } finally {
      setBusy(null);
    }
  }

  async function onApply() {
    setBusy("apply");
    try {
      const r = await guarded(() => applySecrets());
      if (r.applied) {
        pushNotices([
          {
            tone: "ok",
            text: `Applied ${r.count} secret${r.count === 1 ? "" : "s"} to ${r.path} — the service restarts automatically when the env file changes.`,
          },
        ]);
      } else {
        pushNotices([{ tone: "attention", text: applyResultCopy({ applied: false, reason: r.reason }).text.replace(/^Saved to the store, but the/, "The") }]);
      }
      void refresh();
    } catch (err) {
      pushNotices([{ tone: "attention", text: errMessage(err) }]);
    } finally {
      setBusy(null);
    }
  }

  const freshLabel = freshUntil && Date.parse(freshUntil) > now ? `Fresh until ${clockTime(freshUntil)}` : null;

  // ---- top-level states ---------------------------------------------------
  if (load.phase === "loading") {
    return (
      <div className="gs-wrap">
        <Header />
        <p className="gs-loading" role="status">
          Loading secrets…
        </p>
      </div>
    );
  }

  if (load.phase === "error") {
    const storeDown = load.code === "store_unavailable" || load.status === 503;
    return (
      <div className="gs-wrap">
        <Header />
        <div className="gs-empty" role="alert">
          <p className="gs-strong gs-ink-ink">{storeDown ? "Secrets store unavailable" : "Could not load secrets"}</p>
          <p>{errorCopy(load.code, load.status)}</p>
          {storeDown ? (
            <p className="gs-small">
              Owner fix: set the master key on the box, then reload. Steps in <code className="gs-mono">{FIX_DOC}</code>.
            </p>
          ) : null}
          <p>
            <button type="button" className="gs-btn" onClick={() => void refresh()}>
              Try again
            </button>
          </p>
        </div>
      </div>
    );
  }

  const data = load.data;
  const groups = groupByTier(data.items);
  const applyLine = applyStateCopy(data.applyState, now);
  const storeReady = data.storeReady;

  return (
    <div className="gs-wrap">
      <Header>
        <button type="button" className="gs-btn" onClick={() => setDialog({ kind: "audit" })}>
          Audit log
        </button>
        <button
          type="button"
          className="gs-btn"
          disabled={!storeReady}
          onClick={() => setDialog({ kind: "set", mode: "add", name: "" })}
        >
          Add custom secret
        </button>
        <button type="button" className="gs-btn primary" disabled={!storeReady || busy === "apply"} onClick={() => void onApply()}>
          {busy === "apply" ? "Applying…" : "Apply to service"}
        </button>
      </Header>

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
          <p className={`gs-status-line${applyLine.ok ? "" : " gs-strong"}`}>
            <Mark shape={applyLine.ok ? "dot" : "ring"} ink={applyLine.ok ? "accent" : "ink"} /> {applyLine.text}
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

      <div className="gs-notices" role="status" aria-live="polite">
        {notices.map((n) => (
          <p key={n.id} className={`gs-notice${n.tone === "attention" ? " attention" : n.tone === "neutral" ? " neutral" : ""}`}>
            {n.text}
          </p>
        ))}
      </div>

      {groups.length === 0 ? (
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
                    verifying={busy === `verify:${item.name}`}
                    onSet={() =>
                      setDialog({ kind: "set", mode: item.state === "set" ? "replace" : "set", name: item.name })
                    }
                    onReveal={() => setDialog({ kind: "reveal", name: item.name })}
                    onDelete={() => setDialog({ kind: "delete", name: item.name })}
                    onVerify={() => void onVerify(item.name)}
                  />
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}

      {dialog?.kind === "set" ? (
        <SetSecretDialog
          mode={dialog.mode}
          initialName={dialog.name}
          guarded={guarded}
          onClose={() => setDialog(null)}
          onSaved={onSaved}
        />
      ) : null}
      {dialog?.kind === "reveal" ? (
        <RevealDialog name={dialog.name} guarded={guarded} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "delete" ? (
        <DeleteDialog name={dialog.name} guarded={guarded} onClose={() => setDialog(null)} onDeleted={onDeleted} />
      ) : null}
      {dialog?.kind === "audit" ? <AuditDrawer onClose={() => setDialog(null)} /> : null}
      {stepUpOpen ? (
        <StepUpDialog
          onClose={() => finishStepUp(false)}
          onSuccess={(until) => {
            setFreshUntil(until);
            setNow(Date.now());
            finishStepUp(true);
          }}
        />
      ) : null}
    </div>
  );
}

async function fetchLoadState(): Promise<LoadState> {
  try {
    return { phase: "ready", data: await listSecrets() };
  } catch (err) {
    if (err instanceof SecretsApiError) return { phase: "error", status: err.status, code: err.code };
    return { phase: "error", status: 0, code: "network" };
  }
}

function errMessage(err: unknown): string {
  if (err instanceof SecretsApiError) return errorCopy(err.code, err.status);
  return errorCopy("network");
}

function Header({ children }: { children?: React.ReactNode }) {
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
