"use client";

/**
 * Post-checkout landing.
 *
 * Two shapes of purchase land here and used to be treated as one:
 *   - ONE-TIME repo scans (quick / full / scan_fix / nuclear) → look up the
 *     session, then hand off to /scan/status which runs the scan.
 *   - SUBSCRIPTIONS (mcp / continuous) → there is no scan to start; the
 *     deliverable is an API key by email (MCP) or every-push scanning of the
 *     org (Continuous). Sending these to /scan/status rendered "No repository
 *     URL found / Scan failed" to a customer who had just paid (2026-08-18
 *     audit). They now get a confirmation that says what happens next.
 *
 * Forbidden #4: never sit at a pulse forever. Every branch reaches a
 * terminal state — hand-off, confirmation, or an error with a way out.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { SUPPORT_EMAIL } from "@/app/lib/site-url";

type State =
  | { kind: "loading" }
  | { kind: "subscription"; tier: string }
  | { kind: "error"; message: string; sessionId: string | null };

const HANDOFF_TIMEOUT_MS = 15_000;

export default function CheckoutSuccess() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session_id");
    const tier = params.get("tier") || "";
    const kind = params.get("kind") || "";

    if (kind === "subscription" || tier === "mcp" || tier === "continuous") {
      setState({ kind: "subscription", tier: tier || "subscription" });
      return;
    }
    if (!sessionId) {
      setState({ kind: "error", message: "We could not find your checkout session in this link.", sessionId: null });
      return;
    }

    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      // Still hand off — /scan/status can resolve the session itself.
      window.location.href = `/scan/status?session_id=${encodeURIComponent(sessionId)}`;
    }, HANDOFF_TIMEOUT_MS);

    fetch(`/api/scan/status?id=${encodeURIComponent(sessionId)}`)
      .then((res) => res.json())
      .then((data) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const scanUrl = `/scan/status?session_id=${encodeURIComponent(sessionId)}&repo_url=${encodeURIComponent(data.repoUrl || "")}&tier=${encodeURIComponent(data.tier || "quick")}`;
        window.location.href = scanUrl;
      })
      .catch(() => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.location.href = `/scan/status?session_id=${encodeURIComponent(sessionId)}`;
      });
    return () => clearTimeout(timer);
  }, []);

  if (state.kind === "subscription") {
    const isMcp = state.tier === "mcp";
    return (
      <div className="flex-1 bg-background flex items-center justify-center px-6 py-16 sm:py-24">
        <div className="max-w-lg text-center">
          <div className="w-12 h-12 rounded-full bg-accent/10 border border-accent/30 flex items-center justify-center mx-auto mb-4">
            <span className="text-accent-light text-xl">&#10003;</span>
          </div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-foreground mb-3">{isMcp ? "You're on GateTest MCP." : "Continuous is live for your org."}</h1>
          {isMcp ? (
            <p className="text-muted mb-6">
              Your <code>gtmcp_</code> API key is being emailed to the address you used at checkout — usually within a minute.
              Paste it as <code>GATETEST_API_KEY</code> and the hosted tools light up in claude.ai. No email in five minutes?
              Write to <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> with your receipt and we&apos;ll resend it.
            </p>
          ) : (
            <p className="text-muted mb-6">
              Every push to any repository under your org is now scanned by the full engine. If the GateTest GitHub App is
              not installed yet, install it once and pushes start flowing; results post as commit statuses and PR comments.
            </p>
          )}
          <div className="flex flex-wrap gap-3 justify-center">
            <a href={isMcp ? "/mcp" : "/github/setup"} className="px-5 py-2.5 rounded-xl text-sm font-bold bg-accent text-white">
              {isMcp ? "Set up the hosted MCP tools" : "Install the GitHub App"}
            </a>
            <a href="/billing" className="px-5 py-2.5 rounded-xl text-sm font-bold border border-border">Manage billing</a>
          </div>
        </div>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="flex-1 bg-background flex items-center justify-center px-6 py-16 sm:py-24">
        <div className="max-w-lg text-center">
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-foreground mb-3">Payment received — but we lost the thread.</h1>
          <p className="text-muted mb-6">
            {state.message} Your card was charged only once and the scan is still yours. Email{" "}
            <a className="underline" href={`mailto:${SUPPORT_EMAIL}?subject=Checkout%20session%20${encodeURIComponent(state.sessionId || "unknown")}`}>{SUPPORT_EMAIL}</a>{" "}
            with your Stripe receipt and we will start it by hand.
          </p>
          <Link href="/" className="px-5 py-2.5 rounded-xl text-sm font-bold border border-border">Back to GateTest</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 bg-background flex items-center justify-center px-6 py-16 sm:py-24">
      <div className="text-center">
        <div className="w-12 h-12 rounded-full bg-accent/10 border border-accent/30 flex items-center justify-center mx-auto mb-4 animate-pulse">
          <span className="text-accent-light text-xl">&#9679;</span>
        </div>
        <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-foreground mb-2">Starting your scan...</h1>
        <p className="text-muted">Connecting to your repository. This hands off within {HANDOFF_TIMEOUT_MS / 1000} seconds.</p>
      </div>
    </div>
  );
}
