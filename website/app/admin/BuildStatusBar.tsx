"use client";

import { useEffect, useState } from "react";

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

/** Top-bar fact strip — live deployed commit vs origin/main, deploy freshness. */
export function BuildStatusBar() {
  const [status, setStatus] = useState<BuildStatus | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/build-status", { credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: BuildStatus) => {
        if (!cancelled) setStatus(data);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return <div className="gt-admin-topbar-facts"><span className="gt-admin-fact"><span className="gt-admin-dot warn" /> build status not checked</span></div>;
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
      <span className="gt-admin-fact" title="Time since this build was produced">
        <span className={`gt-admin-dot ${staleTone}`} /> deployed {formatAge(status.buildAgeSeconds)}
      </span>
    </div>
  );
}
