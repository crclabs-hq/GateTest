/**
 * Which tiers actually run a module — derived, never typed.
 *
 * Tier prices come from checkout-tiers.ts (the Stripe source of truth),
 * suite membership from the engine's config via module-suites.js, and the
 * hosted-execution exclusions from legal/_facts.js (drift-tested against
 * cli-engine-runner.js). The page used to promise every module on "Full
 * ($99)"; a customer buying Full for mutation testing or the live crawler
 * would not have got it.
 */
import { TIERS } from "@/app/lib/checkout-tiers";
import { suitesForModule } from "@/app/lib/module-suites";
import { HOSTED_UNSAFE_MODULES } from "@/app/legal/_facts";

export type Availability = {
  kind: "quick" | "full" | "forensic" | "action" | "live" | "none" | "unknown";
  /** Answers "which tiers include this module?" */
  tiers: string;
  /** Bold lead for the coverage bullet. */
  lead: string;
  /** How to run it from the free local CLI. */
  cli: string;
  /** schema.org Offer, or null when nothing purchasable runs it. */
  offer: { price: string; description: string } | null;
};

const usd = (t: keyof typeof TIERS) => `$${TIERS[t].priceInCents / 100}`;
const QUICK_TIER_MODULES = TIERS.quick.modules.split(",").map((s) => s.trim());

export function availabilityFor(name: string, pretty: string, totalModules: number): Availability {
  const suites = suitesForModule(name);
  const repoCli = `gatetest --module ${name}`;
  const fullOffer = { price: String(TIERS.full.priceInCents / 100), description: `Full Scan — every applicable module of ${totalModules}, including ${pretty}` };

  if (suites === null) {
    return {
      kind: "unknown",
      tiers: `Full (${usd("full")}), Scan + Fix (${usd("scan_fix")}) and Forensic (${usd("nuclear")}) run every module that applies to a repository; the Quick tier (${usd("quick")}) runs 4.`,
      lead: "Runs on the repository tiers.",
      cli: repoCli,
      offer: fullOffer,
    };
  }
  if (QUICK_TIER_MODULES.includes(name)) {
    return {
      kind: "quick",
      tiers: `Every repository tier — Quick (${usd("quick")}), Full (${usd("full")}), Scan + Fix (${usd("scan_fix")}) and Forensic (${usd("nuclear")}). It is one of the four modules the Quick tier runs.`,
      lead: "Runs on every tier, including Quick.",
      cli: repoCli,
      offer: { price: String(TIERS.quick.priceInCents / 100), description: `Quick Scan — 4 modules including ${pretty}` },
    };
  }
  const inFull = suites.includes("full");
  const inNuclear = suites.includes("nuclear");
  const inWeb = suites.includes("web");
  const inWp = suites.includes("wp");
  const liveNote = inWeb || inWp
    ? ` It also runs in the live-URL scanners — the website scan (${usd("web_scan")} full report)${inWp ? ` and the WordPress health check (${usd("wp_health")})` : ""}.`
    : "";

  if (HOSTED_UNSAFE_MODULES.includes(name)) {
    return {
      kind: "action",
      tiers: `The CLI and the GitHub Action. It executes your project (tests, a linter toolchain or a headless browser), so the hosted website scan never runs it on our servers — no website tier includes it.${inNuclear && !inFull ? " On the Action it belongs to the Forensic (nuclear) suite." : ""}`,
      lead: "Runs where your CI runs.",
      cli: repoCli,
      offer: null,
    };
  }
  if (inFull) {
    return {
      kind: "full",
      tiers: `Full (${usd("full")}), Scan + Fix (${usd("scan_fix")}) and Forensic (${usd("nuclear")}) — every repository tier except Quick (${usd("quick")}), which runs only 4 modules.${liveNote}`,
      lead: "Runs on every Full scan and above.",
      cli: repoCli,
      offer: fullOffer,
    };
  }
  if (inNuclear) {
    return {
      kind: "forensic",
      tiers: `Forensic (${usd("nuclear")}) only — it is part of the deeper nuclear suite. Full and Scan + Fix do not run it.${liveNote}`,
      lead: "Forensic tier only.",
      cli: repoCli,
      offer: { price: String(TIERS.nuclear.priceInCents / 100), description: `Forensic Scan — the nuclear suite, including ${pretty}` },
    };
  }
  if (inWeb || inWp) {
    const tier = inWeb ? "web_scan" : "wp_health";
    return {
      kind: "live",
      tiers: `The live-URL scanners, not the repository tiers: the website scan (${usd("web_scan")} full report)${inWp ? ` and the WordPress health check (${usd("wp_health")})` : ""}. It probes a running site, so it needs a URL rather than a repo.`,
      lead: "Runs against a live URL.",
      cli: `gatetest --crawl https://your-site.example --module ${name}`,
      offer: { price: String(TIERS[tier].priceInCents / 100), description: `${TIERS[tier].name} — includes ${pretty}` },
    };
  }
  return { kind: "none", tiers: "No purchasable tier includes it yet.", lead: "Not in any tier yet.", cli: repoCli, offer: null };
}
