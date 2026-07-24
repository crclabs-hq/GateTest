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
    <div className="min-h-screen flex items-center justify-center bg-background px-6">
      <div className="max-w-md w-full text-center">
        <div className="w-14 h-14 rounded-2xl bg-accent flex items-center justify-center mx-auto mb-6">
          <span className="text-white font-bold text-xl font-[var(--font-mono)]">G</span>
        </div>

        <h1 className="text-2xl font-bold mb-2">Manage your subscription</h1>
        <p className="text-muted text-sm mb-8">
          Enter the email you used at checkout. We&rsquo;ll send you a secure link to
          update your payment method, view invoices, change plan, or cancel.
        </p>

        {(phase === "form" || phase === "sending" || phase === "error") && (
          <form onSubmit={requestLink}>
            <label htmlFor="billing-email" className="block text-sm text-muted mb-2 text-left">
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
              className="w-full px-4 py-3 rounded-xl border border-border bg-transparent text-sm mb-4"
            />
            {phase === "error" && <p className="text-sm text-red-500 mb-4">{message}</p>}
            <button
              type="submit"
              disabled={phase === "sending"}
              className="btn-cta w-full py-3.5 text-sm rounded-xl font-semibold disabled:opacity-60"
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
              className="text-sm text-muted underline"
            >
              Use a different email
            </button>
          </div>
        )}

        <p className="text-xs text-muted mt-10">
          Trouble managing your plan?{" "}
          <a href="mailto:hello@gatetest.ai" className="underline">hello@gatetest.ai</a>
          {" · "}
          <Link href="/pricing" className="underline">Pricing</Link>
        </p>
      </div>
    </div>
  );
}
