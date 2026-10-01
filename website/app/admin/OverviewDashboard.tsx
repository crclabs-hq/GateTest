"use client";

import { useLiveRefresh, LiveStamp } from "./useLiveRefresh";

type Checked<T> = { checked: true; value: T } | { checked: false; reason: string };

interface WorkerHeartbeat {
  state: "active" | "stale" | "no_activity";
  reason: string;
  lastActivityAt: string | null;
  ageSeconds: number | null;
  stale: boolean;
}
interface ScanVolume {
  today: number;
  thisWeek: number;
  totalScans: number;
  totalRevenueUsd: number;
  avgScore: number;
  totalCustomers: number;
}
interface IntegrationStatus {
  githubApp: { configured: boolean; lastDeliveryAt: string | null; note: string | null };
  marketplaceWebhook: { activeInstalls: number | null; lastEventAt: string | null; note: string | null };
  tallrig: { lastEventType: string | null; lastEventAt: string | null };
}
interface SecretsChecklistItem {
  name: string;
  tier: "required" | "important";
  present: boolean;
  placeholder: boolean;
}
interface OverviewFacts {
  generatedAt: string;
  readiness: Checked<{ ready: boolean; stripeMode: string | null; queue: Record<string, unknown> | null }>;
  worker: Checked<WorkerHeartbeat>;
  scans: Checked<ScanVolume>;
  integrations: Checked<IntegrationStatus>;
  secrets: Checked<SecretsChecklistItem[]>;
}

function NotChecked({ reason }: { reason: string }) {
  return <p className="gt-admin-note">Not checked — {reason}.</p>;
}

function relTime(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "unknown";
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const WORKER_BADGE: Record<WorkerHeartbeat["state"], { cls: string; label: string }> = {
  active: { cls: "ok", label: "Active" },
  stale: { cls: "bad", label: "Stale" },
  no_activity: { cls: "muted", label: "No activity yet" },
};

/** "queued: N · running: M" from the readiness probe's queue block, or null if it carried none. */
function queueLine(queue: Record<string, unknown> | null): string | null {
  if (!queue) return null;
  const parts = Object.entries(queue)
    .filter(([, v]) => typeof v === "number" || typeof v === "string" || typeof v === "boolean")
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${String(v)}`);
  return parts.length ? parts.join(" · ") : null;
}

function TimestampRow({ label, at, note, empty }: { label: string; at: string | null; note: string | null; empty: string }) {
  return (
    <div className="gt-admin-checklist-item">
      <span>{label}</span>
      <span className={`gt-admin-badge ${note ? "warn" : at ? "ok" : "muted"}`} title={note ?? at ?? undefined}>
        {note ? "not read" : at ? relTime(at) : empty}
      </span>
    </div>
  );
}

export function OverviewDashboard() {
  const live = useLiveRefresh<OverviewFacts>("/api/admin/overview");
  const facts = live.data;

  if (!facts) {
    return (
      <div className="gt-admin-card" style={{ marginBottom: "1.25rem" }}>
        <h3>Overview</h3>
        {live.error ? <NotChecked reason={live.error} /> : <p className="gt-admin-note">Loading…</p>}
      </div>
    );
  }

  const queue = facts.readiness.checked ? queueLine(facts.readiness.value.queue) : null;

  return (
    <>
    <div className="gt-admin-liveops-head">
      <h2>Overview</h2>
      <LiveStamp state={live} />
    </div>
    <div className="gt-admin-grid" style={{ marginBottom: "1.25rem" }}>
      <div className="gt-admin-card">
        <h3>Readiness</h3>
        {facts.readiness.checked ? (
          <>
            <div className="gt-admin-card-value">
              <span className={`gt-admin-badge ${facts.readiness.value.ready ? "ok" : "bad"}`}>
                {facts.readiness.value.ready ? "Ready" : "Not ready"}
              </span>
            </div>
            {facts.readiness.value.stripeMode && (
              <p className="gt-admin-note">Stripe: {facts.readiness.value.stripeMode}</p>
            )}
            <p className="gt-admin-note">
              Queue: {queue ?? "the readiness probe reported no queue block"}
            </p>
          </>
        ) : (
          <NotChecked reason={facts.readiness.reason} />
        )}
      </div>

      <div className="gt-admin-card">
        <h3>Scan worker</h3>
        {facts.worker.checked ? (
          <>
            <div className="gt-admin-card-value">
              <span className={`gt-admin-badge ${WORKER_BADGE[facts.worker.value.state].cls}`}>
                {WORKER_BADGE[facts.worker.value.state].label}
              </span>
            </div>
            <p className="gt-admin-note">
              {facts.worker.value.lastActivityAt
                ? `Last activity ${relTime(facts.worker.value.lastActivityAt)} — ${facts.worker.value.reason}`
                : facts.worker.value.reason}
            </p>
          </>
        ) : (
          <NotChecked reason={facts.worker.reason} />
        )}
      </div>

      <div className="gt-admin-card">
        <h3>Scans</h3>
        {facts.scans.checked ? (
          <>
            <div className="gt-admin-card-value">{facts.scans.value.today} today</div>
            <p className="gt-admin-note">
              {facts.scans.value.thisWeek} this week &middot; {facts.scans.value.totalScans} total &middot; avg score{" "}
              {facts.scans.value.avgScore}
            </p>
            <p className="gt-admin-note">
              ${facts.scans.value.totalRevenueUsd.toFixed(0)} revenue &middot; {facts.scans.value.totalCustomers} customers
            </p>
          </>
        ) : (
          <NotChecked reason={facts.scans.reason} />
        )}
      </div>

      <div className="gt-admin-card">
        <h3>Integrations</h3>
        {facts.integrations.checked ? (
          <div className="gt-admin-checklist">
            <div className="gt-admin-checklist-item">
              <span>GitHub App</span>
              <span className={`gt-admin-badge ${facts.integrations.value.githubApp.configured ? "ok" : "muted"}`}>
                {facts.integrations.value.githubApp.configured ? "configured" : "not configured"}
              </span>
            </div>
            <TimestampRow
              label="Last GitHub delivery"
              at={facts.integrations.value.githubApp.lastDeliveryAt}
              note={facts.integrations.value.githubApp.note}
              empty="none received"
            />
            <div className="gt-admin-checklist-item">
              <span>Marketplace webhook</span>
              <span className="gt-admin-badge muted">
                {facts.integrations.value.marketplaceWebhook.activeInstalls ?? "—"} installs
              </span>
            </div>
            <TimestampRow
              label="Last Marketplace event"
              at={facts.integrations.value.marketplaceWebhook.lastEventAt}
              note={facts.integrations.value.marketplaceWebhook.note}
              empty="none received"
            />
            <div className="gt-admin-checklist-item">
              <span>Tallrig push</span>
              <span className="gt-admin-badge muted">
                {facts.integrations.value.tallrig.lastEventAt
                  ? relTime(facts.integrations.value.tallrig.lastEventAt)
                  : "no events"}
              </span>
            </div>
          </div>
        ) : (
          <NotChecked reason={facts.integrations.reason} />
        )}
      </div>

      <div className="gt-admin-card" style={{ gridColumn: "1 / -1" }}>
        <h3>Secrets presence (names only)</h3>
        {facts.secrets.checked ? (
          <div className="gt-admin-checklist">
            {facts.secrets.value.map((item) => (
              <div className="gt-admin-checklist-item" key={item.name}>
                <span>
                  {item.name} <span className="gt-admin-note">({item.tier})</span>
                </span>
                <span className={`gt-admin-badge ${item.present && !item.placeholder ? "ok" : item.placeholder ? "warn" : "bad"}`}>
                  {item.placeholder ? "placeholder" : item.present ? "present" : "missing"}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <NotChecked reason={facts.secrets.reason} />
        )}
      </div>
    </div>
    </>
  );
}
