"use client";

// /checkout?tier=<tier>&repo=<url> — bridge from anywhere on the site into
// Stripe Checkout. The playground, scan results, and upsell surfaces all
// link here with query params; this page POSTs /api/checkout and forwards
// the visitor to Stripe. Before 2026-07-23 this route did not exist and
// every one of those links 404'd at the moment of purchase intent.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { TIERS } from "@/app/lib/checkout-tiers";

const REPO_FREE_TIERS = new Set(["mcp"]);
const URL_TIERS = new Set(["web_scan", "wp_health"]);

function formatPrice(cents: number, recurring?: boolean): string {
  return `$${Math.round(cents / 100)}${recurring ? "/mo" : ""}`;
}

export default function CheckoutPage() {
  const [tier, setTier] = useState<string>("");
  const [repoUrl, setRepoUrl] = useState<string>("");
  const [phase, setPhase] = useState<"init" | "redirecting" | "form" | "error">("init");
  const [error, setError] = useState<string>("");
  const started = useRef(false);

  async function startCheckout(t: string, target: string) {
    setPhase("redirecting");
    setError("");
    // URL tiers (website / WP full reports) send `url`; scan tiers send
    // `repoUrl`; MCP sends neither.
    const body: Record<string, string> = { tier: t };
    if (target) {
      if (URL_TIERS.has(t)) body.url = target;
      else body.repoUrl = target;
    }
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { checkoutUrl?: string; error?: string };
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
        return;
      }
      setError(data.error || "Could not start checkout. Please try again.");
      setPhase("error");
    } catch {
      setError("Network error starting checkout. Please try again.");
      setPhase("error");
    }
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const sp = new URLSearchParams(window.location.search);
    const t = (sp.get("tier") || "").trim();
    const repo = (sp.get("repo") || sp.get("repoUrl") || sp.get("url") || "").trim();
    setTier(t);
    setRepoUrl(repo);

    if (!t || !TIERS[t]) {
      setError(t ? `Unknown tier "${t}".` : "No tier selected.");
      setPhase("error");
      return;
    }
    if (repo || REPO_FREE_TIERS.has(t)) {
      startCheckout(t, repo);
    } else {
      // Scan tiers need a repo URL — ask for it instead of erroring.
      setPhase("form");
    }
  }, []);

  const tierInfo = tier ? TIERS[tier] : undefined;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-6">
      <div className="max-w-md w-full text-center">
        <div className="w-14 h-14 rounded-2xl bg-accent flex items-center justify-center mx-auto mb-6">
          <span className="text-white font-bold text-xl font-[var(--font-mono)]">G</span>
        </div>

        {tierInfo && (
          <>
            <h1 className="text-2xl font-bold mb-1">{tierInfo.name}</h1>
            <p className="text-lg font-semibold mb-2">
              {formatPrice(tierInfo.priceInCents, tierInfo.recurring)}
            </p>
            <p className="text-muted text-sm mb-8">{tierInfo.description}</p>
          </>
        )}

        {phase === "redirecting" && (
          <div className="flex items-center justify-center gap-3">
            <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-muted">Taking you to secure checkout…</span>
          </div>
        )}

        {phase === "form" && tierInfo && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (repoUrl.trim()) startCheckout(tier, repoUrl.trim());
            }}
          >
            <label htmlFor="repo-url" className="block text-sm text-muted mb-2 text-left">
              {URL_TIERS.has(tier) ? "Which website should we scan?" : "Which repository should we scan?"}
            </label>
            <input
              id="repo-url"
              type="url"
              required
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder={URL_TIERS.has(tier) ? "https://yoursite.com" : "https://github.com/owner/repo"}
              className="w-full px-4 py-3 rounded-xl border border-border bg-transparent text-sm mb-4"
            />
            <button type="submit" className="btn-cta w-full py-3.5 text-sm rounded-xl font-semibold">
              Continue to checkout
            </button>
          </form>
        )}

        {phase === "error" && (
          <div>
            <p className="text-sm text-red-500 mb-6">{error}</p>
            {tierInfo ? (
              <button
                onClick={() => startCheckout(tier, repoUrl)}
                className="btn-cta w-full py-3.5 text-sm rounded-xl font-semibold"
              >
                Try again
              </button>
            ) : (
              <Link
                href="/#pricing"
                className="btn-cta w-full py-3.5 text-sm block text-center rounded-xl font-semibold"
              >
                See plans &amp; pricing
              </Link>
            )}
          </div>
        )}

        <div className="mt-6">
          <Link href="/" className="text-sm text-muted hover:text-foreground">
            &larr; Back to GateTest
          </Link>
        </div>
      </div>
    </div>
  );
}
