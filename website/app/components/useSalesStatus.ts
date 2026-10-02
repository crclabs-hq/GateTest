"use client";

import { useEffect, useState } from "react";

/**
 * Whether paid plans can be bought right now (GET /api/sales-status).
 *
 * `null` while loading or if the status could not be read — callers then keep
 * their normal button, because POST /api/checkout enforces the pause on the
 * server and answers with the same message. This hook only lets a page SAY
 * "not on sale yet" up front instead of offering a button that would refuse.
 */
export interface SalesStatus {
  paused: boolean;
  message?: string;
}

export function useSalesStatus(): SalesStatus | null {
  const [status, setStatus] = useState<SalesStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/sales-status", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((s: SalesStatus | null) => {
        if (!cancelled && s && typeof s.paused === "boolean") setStatus(s);
      })
      .catch(() => { /* unknown: the server still refuses while paused */ });
    return () => { cancelled = true; };
  }, []);
  return status;
}
