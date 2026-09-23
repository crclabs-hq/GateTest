"use client";

import { useEffect, useState } from "react";

type Checked<T> = { checked: true; value: T } | { checked: false; reason: string };

interface WorkerHeartbeat {
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
  githubApp: { configured: boolean; lastDeliveryAt: string | null };
  marketplaceWebhook: { activeInstalls: number | null; lastEventAt: string | null };
  tallrig: { lastEventType: string | null; lastEventAt: string | null };
}
interface SecretsChecklistItem {
  name: string;
  tier: "required" | "important";
  present: boolean;
  placeholder: boolean;
}
interface OverviewFacts {
  readiness: Checked<{ ready: boolean; stripeMode: string | null }>;
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

export function OverviewDashboard() {
  const [facts, setFacts] = useState<OverviewFacts | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/overview", { credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: OverviewFacts) => {
        if (!cancelled) setFacts(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "overview request failed");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="gt-admin-card" style={{ marginBottom: "1.25rem" }}>
        <h3>Overview</h3>
        <NotChecked reason={error} />
      </div>
    );
  }
  if (!facts) {
    return (
      <div className="gt-admin-card" style={{ marginBottom: "1.25rem" }}>
        <h3>Overview</h3>
        <p className="gt-admin-note">Loading…</p>
      </div>
    );
  }

  return (
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
              <span className={`gt-admin-badge ${facts.worker.value.stale ? "bad" : "ok"}`}>
                {facts.worker.value.stale ? "Stale" : "Healthy"}
              </span>
            </div>
            <p className="gt-admin-note">Last activity {relTime(facts.worker.value.lastActivityAt)} (24h staleness rule)</p>
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
            <div className="gt-admin-checklist-item">
              <span>Marketplace webhook</span>
              <span className="gt-admin-badge muted">
                {facts.integrations.value.marketplaceWebhook.activeInstalls ?? "—"} installs
              </span>
            </div>
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
  );
}
