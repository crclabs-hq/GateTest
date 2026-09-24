import { PLATFORM_NAME, PLATFORM_HOST, PLATFORM_SITE_URL } from "../lib/platform-config";
import { Stat, Callout, Card } from "./v2";
import siteStats from "../data/site-stats.json";
import Link from "next/link";

/**
 * <HomeStack> — full-weight homepage section for the product stack.
 *
 * Upgraded from the slim footer StackBar per Craig 2026-06-12: "we really
 * need to market the hell out of Gluecron and Vapron." Sits late in the
 * homepage flow (after FAQ) so the top of the funnel stays focused on
 * converting the GateTest visitor; the navbar "Stack" tab and /stack page
 * carry the deep-dive.
 *
 * Rewritten 2026-09-23 per issue #715/#716 (owner: "we should be trying to
 * sell each product way much better"): each product's own card carries only
 * its own pitch, proof and price — nothing about a sibling — and the upgrade
 * path is a separate, later block framed as "better together", never
 * "needs". Gluecron's own pitch/proof/price are still pending on
 * ccantynz-alt/Gluecron.com#140; Tallrig's five lines are its own words,
 * verified by them, from crclabs-hq/GateTest#715.
 *
 * Honesty rule: every claim here has a source in the PR's claims register.
 * No invented specs. The Hall of Scans page was retired 2026-09-10 (Craig).
 */

const PRODUCTS = [
  {
    name: "GateTest",
    domain: "gatetest.io",
    href: "/playground",
    external: false,
    ctaLabel: "Scan a repo free",
    badge: "G",
    badgeColor: "bg-accent",
    accent: "from-accent/15 to-accent/5",
    tagline: "CI quality gate for AI-written code.",
    body:
      `Scans your repository or your live URL with the same ${siteStats.modules.total}-module engine. Fails the job only on findings outside your committed baseline.`,
    proofStat: {
      value: "B · 85/100",
      label: "Free scan on expressjs/express, graded by an independent buyer walk",
    },
    bullets: [
      "From $29 per scan — no subscription required",
      "69 minutes cut to 9 m 55 s on a real 77-package customer monorepo",
      "Runs on GitHub or any CI you already use",
    ],
  },
  {
    name: "Gluecron",
    domain: "gluecron.com",
    href: "https://gluecron.com",
    external: true,
    ctaLabel: "Visit Gluecron",
    badge: "Gc",
    badgeColor: "bg-indigo-500",
    accent: "from-indigo-500/15 to-blue-500/5",
    tagline: "Git hosting with the gate on every push.",
    body: "A git host built for agents. [GLUECRON: pending their words — full pitch]",
    proofStat: null,
    bullets: [
      "[GLUECRON: pending their words — one verifiable proof point]",
      "[GLUECRON: pending their words — price model]",
      "Its own CI gate runs on every push — nothing external required",
    ],
  },
  {
    name: PLATFORM_NAME,
    domain: PLATFORM_HOST,
    href: PLATFORM_SITE_URL,
    external: true,
    ctaLabel: `Visit ${PLATFORM_NAME}`,
    badge: PLATFORM_NAME.charAt(0),
    badgeColor: "bg-amber-500",
    accent: "from-amber-500/15 to-orange-500/5",
    tagline: "The developer platform for the next decade.",
    body:
      "Deploy your services and scheduled jobs, run managed Postgres, send email, and register and serve your domains from one dashboard, on infrastructure it owns and operates. One bill, one place.",
    proofStat: null,
    bullets: [
      `${PLATFORM_HOST} states its own initial JS weight, stamped at build time — 110 KB on 23 Sep 2026`,
      "Free with no card, Pro from $20/mo, Scale from $99/mo, Enterprise by conversation",
      "A release answers its health check before traffic moves to it",
    ],
  },
] as const;

const TOGETHER = [
  {
    title: "Add GateTest to Gluecron",
    body:
      "A push to a Gluecron repo lands on the same Signal Bus queue GateTest already scans from for GitHub — the same checks on the diff, wherever the code lives.",
  },
  {
    title: `Add GateTest to ${PLATFORM_NAME}`,
    body:
      `GateTest checks the change before it is pushed; ${PLATFORM_NAME}'s gate checks the release before it goes live. Add GateTest and a bad change is stopped at the first door, with the same verdict you would have seen at the second.`,
  },
  {
    title: "All three",
    body:
      "Two independent gates — one on the diff, one on the deploy — from one team, in front of a git host built for the same agents writing the code.",
  },
] as const;

export default function HomeStack() {
  return (
    <section id="stack" className="py-24 px-6 border-t border-border">
      <div className="mx-auto max-w-5xl">
        <div className="text-center mb-14">
          <span className="text-sm font-semibold text-accent uppercase tracking-wider">
            The Stack
          </span>
          <h2 className="font-display text-3xl sm:text-4xl font-bold tracking-tight mt-4 mb-3 text-foreground [text-wrap:balance]">
            Three products. Each complete on its own.
          </h2>
          <p className="text-muted text-base max-w-2xl mx-auto">
            GateTest, Gluecron and {PLATFORM_NAME} are built by one team and sold
            separately — buy one, buy all three, or pair one with tools you
            already run. Nothing below needs a sibling product to work.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-6 mb-10">
          {PRODUCTS.map((p) => (
            <article
              key={p.name}
              className={`rounded-2xl border border-border bg-gradient-to-br ${p.accent} p-8 flex flex-col hover:border-accent/40 transition-colors`}
            >
              <div className="flex items-center gap-3 mb-4">
                <div className={`w-10 h-10 rounded-lg ${p.badgeColor} flex items-center justify-center flex-shrink-0`}>
                  <span className="text-white font-bold text-sm font-[var(--font-mono)]">{p.badge}</span>
                </div>
                <div>
                  <h3 className="font-bold text-xl text-foreground">{p.name}</h3>
                  <span className="text-xs text-muted font-mono">{p.domain}</span>
                </div>
              </div>

              <p className="text-base font-semibold text-foreground mb-3">{p.tagline}</p>
              <p className="text-sm text-muted leading-relaxed mb-4">{p.body}</p>

              {p.proofStat && (
                <div className="mb-4">
                  <Stat value={p.proofStat.value} label={p.proofStat.label} />
                </div>
              )}

              <ul className="text-xs text-muted space-y-2 mb-6">
                {p.bullets.map((b) => (
                  <li key={b} className="flex items-start gap-2">
                    <span className="text-accent mt-0.5 font-bold">✓</span>
                    <span>{b}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-auto">
                {p.external ? (
                  <a
                    href={p.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-accent text-white font-semibold text-sm hover:bg-accent-hover transition-colors"
                  >
                    {p.ctaLabel} <span aria-hidden>→</span>
                  </a>
                ) : (
                  <Link
                    href={p.href}
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-accent text-white font-semibold text-sm hover:bg-accent-hover transition-colors"
                  >
                    {p.ctaLabel} <span aria-hidden>→</span>
                  </Link>
                )}
              </div>
            </article>
          ))}
        </div>

        <div className="mb-10">
          <h3 className="text-center font-display text-xl font-bold text-foreground mb-6">
            Better together (optional)
          </h3>
          <ul className="grid sm:grid-cols-3 gap-4 text-sm text-muted mb-6">
            {TOGETHER.map((t) => (
              <Card as="li" key={t.title} className="p-5">
                <span className="font-semibold text-foreground block mb-1">{t.title}</span>
                {t.body}
              </Card>
            ))}
          </ul>
          <Callout tone="accent">
            Not built yet: there is no single login or shared console across GateTest,
            Gluecron and {PLATFORM_NAME}. Each keeps its own sign-in, its own dashboard
            and its own bill today.
          </Callout>
        </div>

        <div className="text-center">
          <Link
            href="/stack"
            className="inline-flex items-center gap-2 text-sm font-semibold text-accent hover:underline"
          >
            How the three products fit together →
          </Link>
        </div>
      </div>
    </section>
  );
}
