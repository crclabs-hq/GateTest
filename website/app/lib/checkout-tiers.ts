/**
 * Single source of truth for GateTest's pricing tiers.
 *
 * Deliberately zero-dependency (no `next/server`, no other app imports) so
 * it can be `require()`-d directly by plain CJS files via Node's
 * transparent TypeScript loader — same pattern as
 * `website/app/lib/scan-modules/types.ts`. This is what lets
 * `website/app/lib/stripe-checkout.js` (loaded by `tests/stripe-checkout.test.js`
 * outside the Next.js build) import the real tier table instead of
 * maintaining a second hand-written copy that can drift (previously:
 * missing scan_fix/nuclear/continuous/mcp, stale "all-84" module count).
 *
 * `website/app/api/checkout/route.ts` imports this too — it is the
 * authoritative definition either way.
 */

export interface ScanTier {
  name: string;
  priceInCents: number;
  modules: string;
  description: string;
  /** Stripe Checkout mode — monthly subscription instead of one-time payment. */
  recurring?: boolean;
}

export const TIERS: Record<string, ScanTier> = {
  quick: {
    name: "Quick Scan",
    priceInCents: 2900,
    modules: "syntax, lint, secrets, codeQuality",
    description: "4 modules — syntax, linting, secrets, code quality",
  },
  full: {
    name: "Full Scan",
    priceInCents: 9900,
    modules: "all-120",
    description:
      "All 120 modules — security, supply chain, auth, CI hardening, AI review, and more. Scan-only (no auto-fix — that ships at Scan + Fix $199 and above).",
  },
  scan_fix: {
    name: "Scan + Fix",
    priceInCents: 19900,
    modules: "all-120+pair-review+architecture",
    description:
      "Everything in Full Scan, plus a second-Claude pair-review critique on every fix (correctness/completeness/readability/test-coverage rubric) and a separate architecture-annotator report on codebase-shape design observations. Same PR, deeper deliverable.",
  },
  nuclear: {
    name: "Forensic Scan",
    priceInCents: 39900,
    modules: "all-120+nuclear-stack",
    description:
      "Everything in Scan + Fix, PLUS: real Claude diagnosis on every finding (no templated snippets), cross-finding attack-chain correlation (textbook session-forgery / supply-chain vectors no per-finding scanner can see), board-ready CISO report (OWASP / SOC2 / CIS v8 / 30-60-90), and a CTO-readable executive summary report. Mutation testing and chaos / fuzz pass are also available via the GitHub Action (mutation: true / chaos: true) — they need a CI runner so they ship wherever your CI runs.",
  },
  // Continuous subscription — Craig green-light 2026-06-12. Unlimited
  // deterministic scans on every push (near-zero marginal cost); AI reviews
  // metered by the continuous_ai_ledger monthly allowance (default $10/mo,
  // env CONTINUOUS_AI_BUDGET_USD). Fix PRs are NOT included — they remain
  // the per-scan upsell.
  continuous: {
    name: "Continuous",
    priceInCents: 4900,
    modules: "subscription-continuous",
    description:
      "Scan every push. Unlimited deterministic scans across all 120 modules, plus a monthly Claude AI-review allowance. Cancel anytime.",
    recurring: true,
  },
  // MCP subscription — $29/mo. Key-based (no repo URL). Unlocks premium
  // Eyes/Ears/Hands tools in the Claude MCP integration. Key delivered by
  // email immediately after checkout. Craig-authorized 2026-07-04.
  mcp: {
    name: "GateTest MCP",
    priceInCents: 2900,
    modules: "subscription-mcp",
    description:
      "Full MCP server access — 120-module scans, AI fixes, live-page screenshots, production errors, test runs, and pass/fail fix verification. API key delivered by email instantly. Cancel anytime.",
    recurring: true,
  },
};
