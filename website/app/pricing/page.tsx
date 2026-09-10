import type { Metadata } from "next";
import Link from "next/link";
import Pricing from "../components/Pricing";
import PageHero from "../components/site/PageHero";
import Section from "../components/site/Section";
import { TOTAL_MODULES } from "@/app/lib/module-count";
import { breadcrumbSchema, contentMetadata, jsonLd } from "../lib/seo/schema";

/**
 * /pricing — the canonical pricing URL.
 *
 * Why this route exists: pricing shipped only as a homepage section reachable
 * at `/#pricing`. That is the most-linked, most-shared and most-searched URL a
 * developer tool has, and it had no page of its own — an anchor cannot be
 * canonicalised, cannot carry its own Open Graph card, and cannot be indexed
 * separately from the homepage.
 *
 * HONESTY / SYNC RULES that govern this file (CLAUDE.md):
 *   - It renders the EXISTING `components/Pricing.tsx`. Prices are not
 *     restated here — not in the copy, not in the metadata.
 *     `tests/pricing-consistency.test.js` ties Pricing.tsx to
 *     `lib/checkout-tiers.ts`; a second hand-typed "$29" on this page would
 *     sit outside that tripwire and drift silently.
 *   - The module count comes from TOTAL_MODULES (catalogue-derived), never a
 *     literal — Sync Rule: "prefer generated values over hardcoded ones".
 *   - "Charged upfront at checkout" is the actual Stripe behaviour (Craig
 *     2026-05-18, Quality Bar §5). Do not reword it towards pay-on-completion;
 *     pricing-consistency.test.js has a tripwire for exactly that claim.
 *   - `/#pricing` still works: the homepage keeps its <Pricing /> section and
 *     the component still renders `id="pricing"`.
 */

export const metadata: Metadata = contentMetadata({
  title: "GateTest pricing — pay per scan, not per seat",
  description:
    "Every GateTest tier in one place: one-time scans billed per run, plus the Continuous and hosted MCP subscriptions. Charged upfront at checkout. The engine is free and open-source if you run it yourself.",
  path: "/pricing",
  keywords: [
    "gatetest pricing",
    "code scanning pricing",
    "pay per scan",
    "static analysis pricing",
    "sonarqube pricing alternative",
    "snyk pricing alternative",
  ],
});

/** Pages a buyer actually wants before they reach for a card. All real routes. */
const NEXT_STEPS: { href: string; title: string; body: string }[] = [
  {
    href: "/modules",
    title: `Browse all ${TOTAL_MODULES} modules`,
    body: "Every check the engine runs, by category — with a page per module.",
  },
  {
    href: "/compare",
    title: "How GateTest compares",
    body: "Side by side against SonarQube, Snyk, ESLint, Semgrep, CodeQL and more.",
  },
  {
    href: "/how-it-works",
    title: "How a scan runs",
    body: "What happens between checkout and the report landing in your repo.",
  },
  {
    href: "/trust",
    title: "What we do with your code",
    body: "Storage, retention and our security posture — including what we are not.",
  },
  {
    href: "/enterprise",
    title: "Enterprise",
    body: "Contact-based plans for large organisations. No fixed price.",
  },
  {
    href: "/legal/refunds",
    title: "Refund policy",
    body: "What happens when a scan fails or a run does not deliver.",
  },
];

export default function PricingPage() {
  return (
    <div className="bg-background">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLd(
            breadcrumbSchema([{ name: "GateTest", path: "/" }, { name: "Pricing" }]),
          ),
        }}
      />

      <main>
        {/* The shared hero sits directly under the sticky site header (no
            top padding — the header is in-flow). The tier grid below is the
            same <Pricing /> component the homepage renders at /#pricing. */}
        <PageHero
          eyebrow="Pricing"
          title="GateTest pricing"
          align="center"
          lede={
            <>
              Four one-time scan tiers billed per run, two subscriptions, and a
              contact-based{" "}
              <Link href="/enterprise" className="text-accent hover:underline">
                Enterprise
              </Link>{" "}
              plan. Everything is charged upfront at checkout — no seats, no
              minimum commitment, no sales call to see a price.
            </>
          }
        />

        {/* The one and only pricing surface — the same component the homepage
            renders at /#pricing, so the two can never disagree. */}
        <Pricing />

        {/* Deep links into the pages a buyer reads before deciding. Also the
            fix for the modules catalogue being reachable only from a homepage
            anchor. */}
        <Section alt>
          <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-foreground mb-8 text-center">
            Before you decide
          </h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {NEXT_STEPS.map((s) => (
              <Link
                key={s.href}
                href={s.href}
                className="card block p-5"
              >
                <h3 className="font-semibold text-foreground text-sm mb-1.5">
                  {s.title}
                </h3>
                <p className="text-xs text-muted leading-relaxed">{s.body}</p>
              </Link>
            ))}
          </div>
          <p className="text-center text-xs text-muted mt-8">
            Already subscribed?{" "}
            <Link href="/billing" className="text-accent hover:underline">
              Manage your subscription
            </Link>
            .
          </p>
        </Section>
      </main>
    </div>
  );
}
