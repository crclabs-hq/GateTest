import type { Metadata } from "next";
import Link from "next/link";
import PageHero from "../components/site/PageHero";
import Section from "../components/site/Section";
import { I } from "../preview/_lib/icons";
import { TOTAL_MODULES } from "@/app/lib/module-count";
import { breadcrumbSchema, contentMetadata, jsonLd } from "../lib/seo/schema";

/**
 * /enterprise — the contact-based Enterprise plan, as its own route.
 *
 * PROVENANCE OF EVERY CLAIM ON THIS PAGE. Nothing here is new positioning;
 * it is existing repo copy rendered at a URL that did not exist:
 *
 *   - Heading, kicker, lede, and the three posture cards are lifted from
 *     `app/preview/_components/Enterprise.tsx`, which was written but only
 *     ever rendered on `/preview` (a `robots: noindex` prototype shell).
 *   - The plan description ("custom scan volume, a raised AI-review budget,
 *     priority support, and invoicing on your terms") and the
 *     `mailto:hello@gatetest.ai?subject=GateTest%20Enterprise` CTA are copied
 *     verbatim from the Enterprise card in `app/components/Pricing.tsx`.
 *   - "No fixed price, no Stripe tier, negotiated per deal" is CLAUDE.md's
 *     PRICING table (Craig, 2026-07-23).
 *   - The three posture statements are each backed by a Bible rule:
 *     fail-closed HMAC webhook verification (Quality Bar §5), timestamped
 *     evidence on every gate pass (Gate Rule #4), and the least-privilege
 *     access model documented on /trust.
 *   - The module count is TOTAL_MODULES, derived from the catalogue.
 *
 * DELIBERATELY NOT CARRIED OVER from the preview component's STATS grid:
 * "100× margin vs. manual review" (no measurement anywhere in this repo),
 * "10+ fragmented tools replaced" (a positioning claim, Boss Rule #8), and
 * "120+ checks per unified scan" (stale, and "checks" is a different unit
 * from "modules"). Putting an unbacked number on an indexable page is a
 * different act from leaving it on a noindex prototype.
 *
 * The e-mail address stays @gatetest.ai on purpose — see CLAUDE.md THE DOMAIN:
 * the .ai mailbox is the verified sending/receiving domain, .io is not.
 */

export const metadata: Metadata = contentMetadata({
  title: "GateTest for Enterprise — contact-based plans",
  description:
    "Running GateTest across a large organisation? Enterprise plans are negotiated per deal: custom scan volume, a raised AI-review budget, priority support, and invoicing on your terms. No fixed price, no self-serve tier.",
  path: "/enterprise",
  keywords: [
    "enterprise code scanning",
    "enterprise static analysis",
    "code quality platform for enterprise",
    "sonarqube enterprise alternative",
    "snyk enterprise alternative",
  ],
});

/** Verbatim from app/preview/_components/Enterprise.tsx. */
const POSTURE = [
  {
    icon: I.lock,
    t: "Least-privilege by design",
    d: "Scoped App permissions, short-lived installation tokens minted per scan, no long-lived credentials stored.",
  },
  {
    icon: I.shield,
    t: "Fail-closed webhooks",
    d: "Every event is HMAC-verified. Missing secret rejects — never fails open.",
  },
  {
    icon: I.eye,
    t: "Evidence on every gate",
    d: "Each pass produces a timestamped report. Audit-ready by construction.",
  },
];

/** Verbatim from the Enterprise card in app/components/Pricing.tsx. */
const COVERS = [
  "Custom scan volume",
  "A raised AI-review budget",
  "Priority support",
  "Invoicing on your terms",
];

const CONTACT =
  "mailto:hello@gatetest.ai?subject=GateTest%20Enterprise";

export default function EnterprisePage() {
  return (
    <div className="bg-background">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLd(
            breadcrumbSchema([
              { name: "GateTest", path: "/" },
              { name: "Pricing", path: "/pricing" },
              { name: "Enterprise" },
            ]),
          ),
        }}
      />

      <main>
        {/* === Hero + the offer === */}
        <PageHero
          eyebrow="Built for engineering leadership"
          title="Unlock AI velocity without surrendering control"
          lede="Your team is shipping AI-generated code at record speed. GateTest is the gate that keeps that speed honest — a single, policy-driven checkpoint your CTO can stand behind in front of the board."
        >
          <div className="card p-6 sm:p-8">
            <h2 className="font-display text-xl font-bold text-foreground">Enterprise</h2>
            <p className="mt-1 text-sm text-muted leading-relaxed">
              Running GateTest across a large organisation? We&apos;ll shape a
              plan around you: custom scan volume, a raised AI-review budget,
              priority support, and invoicing on your terms.
            </p>

            <ul className="mt-6 space-y-2.5 text-sm text-foreground-secondary">
              {COVERS.map((c) => (
                <li key={c} className="flex items-start gap-2">
                  <span className="text-accent mt-0.5 flex-shrink-0" aria-hidden>
                    ✓
                  </span>
                  <span>{c}</span>
                </li>
              ))}
            </ul>

            <a
              href={CONTACT}
              className="btn-cta mt-7 w-full inline-flex items-center justify-center px-6 py-3 text-sm"
            >
              Talk to us
            </a>

            {/* Honesty: there is no number to publish, and saying so is
                better than a "Contact sales" wall that implies there is. */}
            <p className="mt-4 text-xs text-muted leading-relaxed">
              There is no fixed Enterprise price and no self-serve Enterprise
              tier — terms are negotiated per deal. If you want a price you
              can read without talking to anyone, every other tier is listed
              on the{" "}
              <Link href="/pricing" className="text-accent hover:underline">
                pricing page
              </Link>
              .
            </p>
          </div>
        </PageHero>

        {/* === Posture === */}
        <Section>
          <div className="grid gap-4 sm:grid-cols-3">
            {POSTURE.map((p) => (
              <div key={p.t} className="card flex items-start gap-3 p-5">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border bg-[var(--background-alt)] text-accent">
                  <p.icon className="h-5 w-5" />
                </span>
                <div>
                  <h2 className="text-sm font-semibold text-foreground">
                    {p.t}
                  </h2>
                  <p className="mt-0.5 text-sm text-muted">{p.d}</p>
                </div>
              </div>
            ))}
          </div>

          <p className="mt-8 text-sm text-muted leading-relaxed">
            The same gate, and the same{" "}
            <Link href="/modules" className="text-accent hover:underline">
              {TOTAL_MODULES} modules
            </Link>
            , that every other tier runs. Read the full security posture on{" "}
            <Link href="/trust" className="text-accent hover:underline">
              Trust &amp; Security
            </Link>
            .
          </p>
        </Section>

        {/* === Evaluating? === */}
        <Section alt>
          <div className="mx-auto max-w-4xl text-center">
            <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-foreground mb-3">
              Evaluating GateTest for a team?
            </h2>
            <p className="text-base text-foreground-secondary leading-relaxed max-w-2xl mx-auto">
              You do not need a contract to start. The engine is open source and
              runs on your own machine, and every self-serve tier is priced in
              public.
            </p>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
              <Link
                href="/pricing"
                className="btn-cta inline-flex items-center justify-center px-6 py-3 text-sm"
              >
                See pricing
              </Link>
              <Link
                href="/trust"
                className="btn-secondary inline-flex items-center justify-center px-6 py-3 text-sm"
              >
                Trust &amp; Security
              </Link>
              <Link
                href="/compare"
                className="btn-secondary inline-flex items-center justify-center px-6 py-3 text-sm"
              >
                Compare the alternatives
              </Link>
            </div>
          </div>
        </Section>
      </main>
    </div>
  );
}
