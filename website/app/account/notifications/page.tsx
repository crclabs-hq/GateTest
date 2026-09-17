"use client";

import { useEffect, useState } from "react";

interface CustomerInfo {
  login: string;
  email: string;
}

/**
 * Notification settings — currently one preference: "Email me release
 * notes" (customers.release_emails_opt_in, default off — opt-IN).
 *
 * Also handles the one-click unsubscribe link every release e-mail carries
 * (?token=...): that flow needs no sign-in, since the token itself proves
 * which address to update (see release-notifier.js verifyUnsubscribeToken).
 */
export default function NotificationSettings() {
  // The unsubscribe token is read from window.location on the client, the way
  // /playground reads its query string: useSearchParams() would force a Suspense
  // boundary and failed the static prerender of this page in CI.
  const [unsubscribeToken, setUnsubscribeToken] = useState<string | null>(null);
  useEffect(() => {
    setUnsubscribeToken(new URLSearchParams(window.location.search).get("token"));
  }, []);

  const [customer, setCustomer] = useState<CustomerInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [optIn, setOptIn] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Unsubscribe-link flow — independent of sign-in state.
  const [unsubState, setUnsubState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [unsubError, setUnsubError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.login) setCustomer(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!customer || unsubscribeToken) return;
    fetch("/api/account/notifications")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && typeof d.releaseEmailsOptIn === "boolean") setOptIn(d.releaseEmailsOptIn);
      })
      .catch(() => {
        // error-ok — the checkbox just starts at its default (off)
      });
  }, [customer, unsubscribeToken]);

  async function confirmUnsubscribe() {
    if (!unsubscribeToken) return;
    setUnsubState("working");
    setUnsubError(null);
    try {
      const res = await fetch("/api/account/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: unsubscribeToken }),
      });
      const json = await res.json().catch(() => null); // error-ok — a non-JSON body just falls through to the generic error message below
      if (res.ok && json?.ok) {
        setUnsubState("done");
        setOptIn(false);
      } else {
        setUnsubState("error");
        setUnsubError(json?.error || "Could not process this unsubscribe link.");
      }
    } catch {
      setUnsubState("error");
      setUnsubError("Could not reach GateTest. Try again shortly.");
    }
  }

  async function toggle(next: boolean) {
    setOptIn(next);
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/account/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optIn: next }),
      });
      if (!res.ok) {
        setOptIn(!next);
        setMessage("Could not save — try again.");
      }
    } catch {
      setOptIn(!next);
      setMessage("Could not reach GateTest. Try again shortly.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-background py-24">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // Unsubscribe-link landing — shown whether or not the visitor is signed in.
  if (unsubscribeToken) {
    return (
      <div className="flex-1 flex items-center justify-center bg-background px-6 py-16 sm:py-24">
        <div className="max-w-sm w-full text-center">
          <h1 className="font-display text-2xl font-bold tracking-tight text-foreground mb-2">
            Unsubscribe from release notes
          </h1>
          {unsubState === "done" ? (
            <p className="text-muted text-sm">You will not receive any more release-notes e-mails.</p>
          ) : (
            <>
              <p className="text-muted text-sm mb-6">
                Stop receiving GateTest release-notes e-mails at the address this link was sent to.
              </p>
              <button
                type="button"
                onClick={confirmUnsubscribe}
                disabled={unsubState === "working"}
                className="btn-cta w-full py-3.5 text-sm rounded-xl font-semibold disabled:opacity-60"
              >
                {unsubState === "working" ? "Working…" : "Confirm unsubscribe"}
              </button>
              {unsubState === "error" && (
                <p className="text-red-400 text-xs mt-3">{unsubError}</p>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  if (!customer) {
    return (
      <div className="flex-1 flex items-center justify-center bg-background px-6 py-16 sm:py-24">
        <div className="max-w-sm w-full text-center">
          <h1 className="font-display text-2xl font-bold tracking-tight text-foreground mb-2">Sign in to GateTest</h1>
          <p className="text-muted text-sm mb-8">Sign in to manage your notification settings.</p>
          <a
            href="/api/auth/github"
            className="btn-cta w-full py-3.5 text-sm block text-center rounded-xl font-semibold"
          >
            Sign in with GitHub
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 bg-background px-6 py-16 sm:py-24">
      <div className="max-w-lg mx-auto">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground mb-2">Notification settings</h1>
        <p className="text-muted text-sm mb-8">{customer.email}</p>

        <label className="flex items-start gap-3 p-4 rounded-xl border border-border bg-surface cursor-pointer">
          <input
            type="checkbox"
            checked={optIn}
            disabled={saving}
            onChange={(e) => toggle(e.target.checked)}
            className="mt-1 h-4 w-4 accent-accent"
          />
          <span>
            <span className="block text-sm font-semibold text-foreground">Email me release notes</span>
            <span className="block text-xs text-muted mt-1">
              A short e-mail when a new GateTest CLI version ships — what changed and how to update. Off by default.
            </span>
          </span>
        </label>

        {message && <p className="text-red-400 text-xs mt-3">{message}</p>}
      </div>
    </div>
  );
}
