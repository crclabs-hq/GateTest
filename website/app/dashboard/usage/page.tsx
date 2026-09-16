"use client";

/**
 * /dashboard/usage — the signed-in customer's usage meter.
 *
 * Same sign-in gate as /dashboard (GET /api/auth/me → GitHub OAuth), then
 * GET /api/dashboard/usage for the window the customer picks. Three honest
 * states after sign-in and never a fourth:
 *   - a report        → <UsageMeter> (which itself says "No usage recorded
 *                       yet" when the window is empty)
 *   - not checked     → the ledger answered 5xx or could not be reached;
 *                       says so, shows no numbers
 *   - not signed in   → the sign-in card
 * The CLI (`gatetest usage`) prints the same report from the same ledger.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import UsageMeter, { type UsageReport } from "@/app/components/UsageMeter";

interface CustomerInfo {
  login: string;
  email: string;
}

type WindowDays = 7 | 30 | 90;
const WINDOWS: WindowDays[] = [7, 30, 90];

type LoadState =
  | { kind: "loading" }
  | { kind: "report"; report: UsageReport }
  | { kind: "unavailable"; status: number | null; message: string };

function fromParam(days: WindowDays): string {
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (days - 1) * 24 * 60 * 60 * 1000;
  return new Date(start).toISOString();
}

/**
 * One read of the meter. Resolves to the next page state, or "signed-out"
 * when the session has lapsed. Never throws — a network failure is the
 * "unavailable" state, with the reason, not a blank page.
 */
async function fetchUsage(days: WindowDays): Promise<LoadState | "signed-out"> {
  try {
    const res = await fetch(`/api/dashboard/usage?from=${encodeURIComponent(fromParam(days))}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    const body = await res.json().catch(() => null);
    if (res.ok && body && body.summary) return { kind: "report", report: body as UsageReport };
    if (res.status === 401) return "signed-out";
    return {
      kind: "unavailable",
      status: res.status,
      message:
        (body && typeof body.error === "string" && body.error) ||
        (res.status === 503 ? "The usage ledger is not reachable right now." : `The usage API answered ${res.status}.`),
    };
  } catch (err) {
    return {
      kind: "unavailable",
      status: null,
      message: err instanceof Error ? err.message : "The usage API could not be reached.",
    };
  }
}

export default function UsagePage() {
  const [customer, setCustomer] = useState<CustomerInfo | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [days, setDays] = useState<WindowDays>(30);
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.login) setCustomer(d);
        setAuthChecked(true);
      })
      .catch(() => setAuthChecked(true));
  }, []);

  // The loading state is set by the handlers that change `days` / `reload`
  // (and is the initial state), so the effect only subscribes to the result.
  useEffect(() => {
    if (!customer) return undefined;
    let cancelled = false;
    fetchUsage(days).then((next) => {
      if (cancelled) return;
      if (next === "signed-out") setCustomer(null);
      else setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [customer, days, reload]);

  if (!authChecked) {
    return (
      <div className="flex-1 flex items-center justify-center bg-background py-24">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!customer) {
    return (
      <div className="flex-1 flex items-center justify-center bg-background px-6 py-16 sm:py-24">
        <div className="max-w-sm w-full text-center">
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-foreground mb-2">
            Sign in to see your usage
          </h1>
          <p className="text-muted text-sm mb-8">
            Scans, fixes, AI tokens and estimated cost across every surface — BYOK and metered runs listed separately.
          </p>
          <a href="/api/auth/github" className="btn-cta w-full py-3.5 text-sm block text-center rounded-xl font-semibold">
            Sign in with GitHub
          </a>
          <div className="mt-6">
            <Link href="/dashboard" className="text-sm text-muted hover:text-foreground">
              &larr; Back to the dashboard
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 bg-background px-6 py-12 sm:py-16">
      <div className="max-w-4xl mx-auto">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-8">
          <div>
            <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-foreground">Usage</h1>
            <p className="text-sm text-muted">
              Signed in as <span className="font-mono font-medium">{customer.login}</span> · every surface, one meter
            </p>
          </div>
          <div className="flex items-center gap-4">
            <div className="inline-flex rounded-lg border border-border overflow-hidden" role="group" aria-label="Window">
              {WINDOWS.map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => {
                    if (w === days) return;
                    setState({ kind: "loading" });
                    setDays(w);
                  }}
                  aria-pressed={days === w}
                  className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                    days === w ? "bg-accent text-white" : "text-muted hover:text-foreground hover:bg-[var(--background-alt)]"
                  }`}
                >
                  {w}d
                </button>
              ))}
            </div>
            <Link href="/dashboard" className="text-sm text-muted hover:text-foreground">
              Scans
            </Link>
          </div>
        </div>

        {state.kind === "loading" && (
          <div className="flex items-center justify-center py-24">
            <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {state.kind === "unavailable" && (
          <div className="card p-8 border-warning/40">
            <p className="text-xs font-semibold uppercase tracking-wide text-warning mb-2">Not checked</p>
            <p className="text-lg font-bold mb-1">Your usage could not be read</p>
            <p className="text-sm text-muted mb-4">
              {state.message}
              {state.status != null ? ` (HTTP ${state.status})` : ""} No numbers are shown because none were verified.
            </p>
            <button
              type="button"
              onClick={() => {
                setState({ kind: "loading" });
                setReload((n) => n + 1);
              }}
              className="btn-primary px-5 py-2.5 text-sm"
            >
              Try again
            </button>
          </div>
        )}

        {state.kind === "report" && <UsageMeter report={state.report} />}

        <p className="mt-10 text-xs text-muted">
          The same report on the command line:{" "}
          <code className="font-mono text-foreground">gatetest usage</code> (reads your{" "}
          <code className="font-mono">GATETEST_API_KEY</code>; add <code className="font-mono">--json</code> for the raw report).
        </p>
      </div>
    </div>
  );
}
