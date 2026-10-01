"use client";

import { useLiveRefresh, secondsAgo } from "./useLiveRefresh";

interface BuildStatus {
  deployedShortCommit: string;
  buildAgeSeconds: number | null;
  buildStale: boolean | null;
  main: {
    status: "ahead" | "behind" | "identical" | "diverged" | "unknown";
    behindBy: number | null;
    checked: boolean;
  };
}

function formatAge(seconds: number | null): string {
  if (seconds === null) return "unknown";
  if (seconds < 90) return `${seconds}s ago`;
  const mins = Math.round(seconds / 60);
  if (mins < 90) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function mainLabel(main: BuildStatus["main"]): { label: string; tone: "ok" | "warn" | "bad" } {
  if (!main.checked) return { label: "vs main: not checked", tone: "warn" };
  if (main.status === "identical") return { label: "up to date with main", tone: "ok" };
  if (main.status === "ahead") return { label: "ahead of main", tone: "ok" };
  if (main.status === "behind") return { label: `${main.behindBy ?? "?"} behind main`, tone: "bad" };
  if (main.status === "diverged") return { label: "diverged from main", tone: "warn" };
  return { label: "vs main: unknown", tone: "warn" };
}

/**
 * Top-bar fact strip — live deployed commit vs origin/main, deploy freshness.
 * Re-reads every 30s while the tab is visible; a failed refresh keeps the
 * last reading and marks it stale rather than blanking the bar.
 */
export function BuildStatusBar() {
  const live = useLiveRefresh<BuildStatus>("/api/admin/build-status");
  const status = live.data;

  if (!status && live.error) {
    return <div className="gt-admin-topbar-facts"><span className="gt-admin-fact"><span className="gt-admin-dot warn" /> build status not checked — {live.error}</span></div>;
  }
  if (!status) {
    return <div className="gt-admin-topbar-facts"><span className="gt-admin-fact">loading build status…</span></div>;
  }

  const main = mainLabel(status.main);
  const staleTone = status.buildStale ? "bad" : status.buildStale === false ? "ok" : "warn";

  return (
    <div className="gt-admin-topbar-facts">
      <span className="gt-admin-fact" title={`Deployed commit ${status.deployedShortCommit}`}>
        <span className="gt-admin-dot" /> <code>{status.deployedShortCommit}</code>
      </span>
      <span className="gt-admin-fact">
        <span className={`gt-admin-dot ${main.tone}`} /> {main.label}
      </span>
      <span
        className="gt-admin-fact"
        title={status.buildStale === null ? "Build is old and main could not be compared" : "Age only counts against a build when main has moved past it"}
      >
        <span className={`gt-admin-dot ${staleTone}`} /> deployed {formatAge(status.buildAgeSeconds)}
      </span>
      <span className="gt-admin-fact" title={live.error ?? "Re-read every 30s while this tab is visible"}>
        {live.error ? <span className="gt-admin-dot warn" /> : null}
        {live.error ? "stale · " : ""}checked {secondsAgo(live.lastOkAt, live.now)}
      </span>
    </div>
  );
}
