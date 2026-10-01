"use client";

import { useLiveRefresh, LiveStamp } from "./useLiveRefresh";

/**
 * Live operations — the first thing on /admin. One tile per signal the
 * server already computed and nothing used to show: queue depth, push-to-
 * result latency, dead letters, the box's pull-deploy result, and server-
 * key AI spend against the daily ceiling. Each tile is coloured by its own
 * state from GET /api/admin/ops and carries the one-line reason, so a grey
 * "not checked" tile says WHY it could not be read instead of showing 0.
 */

type OpsState = "ok" | "warn" | "fail" | "not_checked";

interface Section {
  state: OpsState;
  reason: string;
}
interface DeadLetter {
  id: string | null;
  repo: string | null;
  terminal: boolean;
  reason: string;
  at: string | null;
}
interface OpsSnapshot {
  generatedAt: string;
  overall: OpsState;
  queue: Section & { queued?: number; running?: number; dead?: number; oldestQueuedAgeSec?: number | null };
  latency: Section & {
    p95WaitSec?: number | null;
    p95TotalSec?: number | null;
    completed24h?: number;
    recentDead?: DeadLetter[] | null;
  };
  deadLetters: Section & { total?: number; last24h?: number; recent?: DeadLetter[] };
  deploy: Section & { result?: string; at?: string | null; to?: string | null; consecutiveFailures?: number | null };
  spend: Section & { todayUsd?: number; ceilingUsd?: number | null; pctOfCeiling?: number | null };
}

const STATE_LABEL: Record<OpsState, string> = {
  ok: "ok",
  warn: "warn",
  fail: "fail",
  not_checked: "not checked",
};
const BADGE_CLASS: Record<OpsState, string> = { ok: "ok", warn: "warn", fail: "bad", not_checked: "muted" };

function dur(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const m = Math.round(seconds / 60);
  if (m < 90) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

function Tile({ title, section, value }: { title: string; section: Section; value: string | null }) {
  return (
    <div className="gt-admin-ops-tile" data-state={section.state}>
      <div className="gt-admin-ops-tile-head">
        <h3>{title}</h3>
        <span className={`gt-admin-badge ${BADGE_CLASS[section.state]}`}>{STATE_LABEL[section.state]}</span>
      </div>
      <div className="gt-admin-ops-value">{value ?? "—"}</div>
      <p className="gt-admin-ops-reason" title={section.reason}>
        {section.reason}
      </p>
    </div>
  );
}

function values(s: OpsSnapshot) {
  const q = s.queue;
  const l = s.latency;
  const d = s.deadLetters;
  const dep = s.deploy;
  const sp = s.spend;
  return {
    queue: q.queued !== undefined ? `${q.queued} queued · ${q.running ?? 0} running` : null,
    latency: l.p95TotalSec !== undefined && l.p95TotalSec !== null ? `p95 ${dur(l.p95TotalSec)}` : null,
    dead: d.last24h !== undefined ? `${d.last24h} in 24h · ${d.total ?? 0} total` : null,
    deploy: dep.result ? `${dep.result}${dep.to ? ` · ${dep.to.slice(0, 7)}` : ""}` : null,
    spend:
      sp.todayUsd !== undefined
        ? `$${sp.todayUsd.toFixed(2)}${sp.ceilingUsd ? ` / $${sp.ceilingUsd.toFixed(2)}` : " / no ceiling"}`
        : null,
  };
}

export function LiveOps() {
  const live = useLiveRefresh<OpsSnapshot>("/api/admin/ops");
  const snap = live.data;
  const dead = snap?.deadLetters.recent ?? [];
  const v = snap ? values(snap) : null;

  return (
    <section className="gt-admin-liveops" aria-labelledby="gt-liveops-title">
      <div className="gt-admin-liveops-head">
        <h2 id="gt-liveops-title">
          Live operations
          {snap && (
            <span className={`gt-admin-badge ${BADGE_CLASS[snap.overall]}`} style={{ marginLeft: "0.5rem" }}>
              {STATE_LABEL[snap.overall]}
            </span>
          )}
        </h2>
        <LiveStamp state={live} />
      </div>

      {!snap && !live.error && <p className="gt-admin-note">Loading live operations…</p>}
      {!snap && live.error && <p className="gt-admin-note">Not checked — {live.error}.</p>}

      {snap && (
        <>
          <div className="gt-admin-ops-grid">
            <Tile title="Queue" section={snap.queue} value={v ? v.queue : null} />
            <Tile title="Latency (24h)" section={snap.latency} value={v ? v.latency : null} />
            <Tile title="Dead letters" section={snap.deadLetters} value={v ? v.dead : null} />
            <Tile title="Deploy (box)" section={snap.deploy} value={v ? v.deploy : null} />
            <Tile title="AI spend today" section={snap.spend} value={v ? v.spend : null} />
          </div>
          {dead.length > 0 && (
            <div className="gt-admin-ops-dead">
              <h3>Recent dead letters</h3>
              <ul>
                {dead.map((d) => (
                  <li key={d.id ?? `${d.repo}-${d.at}`}>
                    <code>#{d.id ?? "?"}</code> <strong>{d.repo ?? "unknown repo"}</strong>{" "}
                    <span className={`gt-admin-badge ${d.terminal ? "bad" : "warn"}`}>
                      {d.terminal ? "terminal" : "retries exhausted"}
                    </span>{" "}
                    <span className="gt-admin-ops-reason">{d.reason}</span>{" "}
                    <span className="gt-admin-note">{d.at ?? ""}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
