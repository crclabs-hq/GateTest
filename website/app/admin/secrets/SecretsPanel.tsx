"use client";

/**
 * /admin/secrets — the infra-secrets panel (owner directive 2026-09-30).
 *
 * Layout after Tallrig's platform-secrets page: a status header (store,
 * apply, "Apply to service"), a table grouped by tier, per-row actions, and
 * an audit drawer. Everything the panel decides lives in ./logic.js and
 * ./audit-logic.js; this file holds the state and wires the pieces together.
 *
 * Values never live in this component — only in the dialog that needs one
 * (SetSecretDialog.tsx, RevealDialog.tsx), and only for as long as that
 * dialog is open.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  SecretsApiError,
  applySecrets,
  listSecrets,
  verifySecret,
  type ApplyResult,
  type SecretsList,
  type SetResult,
  type DeleteResult,
} from "./api";
import {
  applyResultCopy,
  clockTime,
  groupByTier,
  livenessMark,
  namesToDrop,
  shortFingerprint,
  warningCopy,
} from "./logic";
import { messageFor } from "./errors";
import { useStepUp } from "./useStepUp";
import {
  Header,
  LoadErrorScreen,
  LoadingScreen,
  NoticeList,
  PendingApplyNotice,
  StatusCards,
  type Notice,
} from "./PanelHeader";
import { SecretsTable } from "./SecretsTable";
import { SetSecretDialog } from "./SetSecretDialog";
import { RevealDialog } from "./RevealDialog";
import { DeleteDialog } from "./DeleteDialog";
import { StepUpDialog } from "./StepUpDialog";
import { AuditDrawer } from "./AuditDrawer";
import { DropKeysDialog } from "./DropKeysDialog";

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

export default function SecretsPanel() {
  const [load, setLoad] = useState<LoadState>({ phase: "loading" });
  const [dialog, setDialog] = useState<DialogState>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [freshUntil, setFreshUntil] = useState<string | null>(null);
  // Names an apply refused to drop (would_drop_keys), awaiting the owner's confirm.
  const [dropNames, setDropNames] = useState<string[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const noticeId = useRef(0);
  const stepUp = useStepUp();
  const guarded = stepUp.guarded;

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
    askToDrop(result.apply);
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
    askToDrop(result.apply);
    void refresh();
  }

  /** would_drop_keys: list the names and let the owner confirm removing them. */
  function askToDrop(apply: { applied?: boolean; reason?: string; dropped?: string[] } | undefined) {
    const names = namesToDrop(apply);
    if (names.length > 0) setDropNames(names);
  }

  async function onVerify(name: string) {
    setBusy(`verify:${name}`);
    try {
      const r = await guarded(() => verifySecret(name));
      const mark = livenessMark(r.liveness);
      pushNotices([{ tone: r.liveness === "dead" ? "attention" : "neutral", text: `${name}: ${mark.label.toLowerCase()} (checked just now).` }]);
      void refresh();
    } catch (err) {
      pushNotices([{ tone: "attention", text: `${name}: ${messageFor(err)}` }]);
    } finally {
      setBusy(null);
    }
  }

  function onApplyAnswer(r: ApplyResult) {
    const drop = namesToDrop(r);
    if (r.applied) {
      pushNotices([
        {
          tone: "ok",
          text: `Applied ${r.count} secret${r.count === 1 ? "" : "s"} to ${r.path} — the service restarts automatically when the env file changes.`,
        },
      ]);
    } else if (drop.length > 0) {
      setDropNames(drop);
      pushNotices([
        {
          tone: "neutral",
          text: `Not applied yet: the env file holds ${drop.length === 1 ? "a name" : `${drop.length} names`} the store no longer has. Confirm removing ${drop.length === 1 ? "it" : "them"} to apply.`,
        },
      ]);
    } else {
      pushNotices([{ tone: "attention", text: applyResultCopy({ applied: false, reason: r.reason }).text.replace(/^Saved to the store, but the/, "The") }]);
    }
    void refresh();
  }

  async function onApply() {
    setBusy("apply");
    try {
      onApplyAnswer(await guarded(() => applySecrets()));
    } catch (err) {
      pushNotices([{ tone: "attention", text: messageFor(err) }]);
    } finally {
      setBusy(null);
    }
  }

  const freshLabel = freshUntil && Date.parse(freshUntil) > now ? `Fresh until ${clockTime(freshUntil)}` : null;

  // ---- top-level states ---------------------------------------------------
  if (load.phase === "loading") return <LoadingScreen />;
  if (load.phase === "error") return <LoadErrorScreen status={load.status} code={load.code} onRetry={() => void refresh()} />;

  const data = load.data;
  const groups = groupByTier(data.items);
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

      <StatusCards data={data} now={now} freshLabel={freshLabel} />

      {data.applyState?.applied === false && data.applyState.reason === "out_of_sync" ? (
        <PendingApplyNotice storeReady={storeReady} applying={busy === "apply"} onApply={() => void onApply()} />
      ) : null}

      <NoticeList notices={notices} />

      <SecretsTable
        groups={groups}
        now={now}
        storeReady={storeReady}
        verifyingName={busy?.startsWith("verify:") ? busy.slice("verify:".length) : null}
        onSet={(item) => setDialog({ kind: "set", mode: item.state === "set" ? "replace" : "set", name: item.name })}
        onReveal={(name) => setDialog({ kind: "reveal", name })}
        onDelete={(name) => setDialog({ kind: "delete", name })}
        onVerify={(name) => void onVerify(name)}
      />

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
      {dropNames && dropNames.length > 0 ? (
        <DropKeysDialog
          names={dropNames}
          guarded={guarded}
          onClose={() => setDropNames(null)}
          onApplied={(r) => {
            // Close, unless the retry names further keys (then it reopens with those).
            setDropNames(null);
            onApplyAnswer(r);
          }}
        />
      ) : null}
      {stepUp.open ? (
        <StepUpDialog
          onClose={() => stepUp.finish(false)}
          onSuccess={(until) => {
            setFreshUntil(until);
            setNow(Date.now());
            stepUp.finish(true);
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
