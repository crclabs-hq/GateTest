"use client";

// /billing — self-serve subscription management. Enter the email used at
// checkout and a secure Stripe billing-portal link (update card, invoices,
// change plan, cancel) is emailed to it. The link is emailed rather than
// shown here so only the inbox owner can open the portal.

import { useState } from "react";
import Link from "next/link";

export default function BillingPage() {
  const [email, setEmail] = useState("");
  const [phase, setPhase] = useState<"form" | "sending" | "sent" | "error">("form");
  const [message, setMessage] = useState("");

  async function requestLink(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setPhase("sending");
    setMessage("");
    try {
      const res = await fetch("/api/billing/portal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = (await res.json()) as { ok?: boolean; message?: string; error?: string };
      if (res.ok && data.ok) {
        setMessage(data.message || "Check your inbox for the manage-subscription link.");
        setPhase("sent");
      } else {
        setMessage(data.error || "Something went wrong. Please try again.");
        setPhase("error");
      }
    } catch {
      setMessage("Network error. Please try again.");
      setPhase("error");
    }
  }

  return (
    <div className="flex-1 flex items-center justify-center bg-[var(--v2-bg)] px-6 py-16 sm:py-24">
      <div className="v2-wrap-narrow max-w-md w-full text-center">
        <h1 className="v2-h1 !text-2xl sm:!text-3xl mb-2">Manage your subscription</h1>
        <p className="text-[var(--v2-muted)] text-sm mb-8">
          Enter the email you used at checkout. We&rsquo;ll send you a secure link to
          update your payment method, view invoices, change plan, or cancel.
        </p>

        {(phase === "form" || phase === "sending" || phase === "error") && (
          <form onSubmit={requestLink}>
            <label htmlFor="billing-email" className="block text-sm text-[var(--v2-muted)] mb-2 text-left">
              Email used at checkout
            </label>
            <input
              id="billing-email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              className="w-full px-4 py-3 rounded-[var(--v2-radius-sm)] border border-[var(--v2-line-strong)] bg-transparent text-sm mb-4 text-[var(--v2-fg)]"
            />
            {phase === "error" && <p className="text-sm text-[var(--v2-bad)] mb-4">{message}</p>}
            <button
              type="submit"
              disabled={phase === "sending"}
              className="v2-btn v2-btn-primary w-full justify-center disabled:opacity-60"
            >
              {phase === "sending" ? "Sending…" : "Email me a secure link"}
            </button>
          </form>
        )}

        {phase === "sent" && (
          <div>
            <p className="text-sm mb-6">{message}</p>
            <button
              onClick={() => { setPhase("form"); setMessage(""); }}
              className="text-sm text-[var(--v2-muted)] underline"
            >
              Use a different email
            </button>
          </div>
        )}

        <p className="text-xs text-[var(--v2-muted)] mt-10">
          Trouble managing your plan?{" "}
          <a href="mailto:support@gatetest.io" className="underline">support@gatetest.io</a>
          {" · "}
          <Link href="/pricing" className="underline">Pricing</Link>
        </p>
      </div>
    </div>
  );
}
