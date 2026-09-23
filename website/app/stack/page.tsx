import Link from "next/link";
import PageHero from "../components/site/PageHero";
import Section from "../components/site/Section";
import { Card, Stat, Callout } from "../components/v2";
import siteStats from "../data/site-stats.json";
import { PLATFORM_NAME, PLATFORM_HOST, PLATFORM_SITE_URL } from "../lib/platform-config";

// gatetest.io/stack — "One team, three products" page.
//
// Boss Rule #8 — all customer-facing copy below is a draft for Craig's
// final review. Drafted by GateTest session 016MgmXrLw4Y35fnyTBLS96m
// on 2026-05-13.

export const metadata = {
  title: `One team, three products — GateTest · Gluecron · ${PLATFORM_NAME}`,
  description:
    `GateTest audits your code and your site. Gluecron hosts your git. ${PLATFORM_NAME} tells you when something breaks. All built by the same team. Use whichever solves your problem.`,
};

export default function StackPage() {
  return (
    <main>
      <PageHero
        eyebrow="One team, three products"
        title={
          <>
            GateTest gates it.
            <br />
            Gluecron hosts it.
            <br />
            <span className="text-accent">{PLATFORM_NAME} runs it.</span>
          </>
        }
        lede={
          <>
            Three independent products. One team behind them. Each one solves a different
            piece of the &quot;running real software in production without losing sleep&quot;
            problem — and they&apos;re designed to be useful on their own or together.
            We use these every day, so you can use them every day.
          </>
        }
        actions={
          <>
            <Link href="/playground" className="btn-cta inline-flex items-center justify-center px-6 py-3 text-sm">
              Scan a repo free
            </Link>
            <a
              href="https://gluecron.com"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary inline-flex items-center justify-center px-6 py-3 text-sm"
            >
              Visit Gluecron <span aria-hidden="true" className="ml-1">→</span>
            </a>
          </>
        }
      >
        <ol className="grid gap-3">
          {STEPS.map((s, i) => (
            <li key={s.name} className="card p-5 flex items-start gap-4">
              <span className="font-mono text-xs text-accent mt-1 shrink-0">0{i + 1}</span>
              <div>
                <div className="font-display font-semibold text-foreground">{s.name}</div>
                <p className="text-sm text-foreground-secondary leading-relaxed mt-1">{s.does}</p>
              </div>
            </li>
          ))}
        </ol>
      </PageHero>

      <Section eyebrow="The products" title="Use whichever solves your problem">
        <div className="grid lg:grid-cols-3 gap-6">
          {PRODUCTS.map((p) => (
            <div key={p.name} className={`${p.highlighted ? "card-highlight" : "card"} p-8 flex flex-col`}>
              <div className="flex items-center gap-3 mb-5">
                <div className={`w-10 h-10 rounded-lg ${p.badgeColor} flex items-center justify-center flex-shrink-0`}>
                  <span className="text-white font-bold text-sm font-mono">{p.badge}</span>
                </div>
                <h3 className="font-display font-bold text-2xl text-foreground">{p.name}</h3>
              </div>
              <p className="text-base text-foreground leading-relaxed mb-4 font-medium">{p.tagline}</p>
              <p className="text-sm text-foreground-secondary leading-relaxed mb-6">{p.body}</p>
              <ul className="text-sm text-foreground-secondary space-y-2 mb-6">
                {p.bullets.map((b) => (
                  <li key={b} className="flex items-start gap-2">
                    <span className="text-accent mt-0.5 font-bold" aria-hidden="true">✓</span>
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
                    className="btn-primary inline-flex items-center gap-2 px-5 py-2.5 text-sm"
                  >
                    Visit {p.name} <span aria-hidden="true">→</span>
                  </a>
                ) : (
                  <Link href={p.href} className="btn-primary inline-flex items-center gap-2 px-5 py-2.5 text-sm">
                    Open {p.name} <span aria-hidden="true">→</span>
                  </Link>
                )}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section alt narrow title="Why three products instead of one big one">
        <div className="text-base text-foreground-secondary leading-relaxed space-y-4">
          <p>
            We could have built one mega-product. We didn&apos;t, because no real customer wants
            a mega-product. They want{" "}
            <span className="font-semibold text-foreground">the tool that solves the problem they have right now</span>{" "}
            — and they want to be able to drop it for a different tool tomorrow without unsubscribing
            from anything.
          </p>
          <p>
            So we built three small products that share a philosophy but not a billing surface.
            Use GateTest without ever signing up for Gluecron. Use {PLATFORM_NAME} without ever touching
            GateTest. Or use all three. The choice stays yours.
          </p>
          <p>
            The shared philosophy: <span className="font-semibold text-foreground">pay-per-use where it works,
            no-subscription-pressure, and explicit about what each tool does and does not do.</span>
          </p>
        </div>
      </Section>

      <Section title="Each product, on its own">
        <p className="text-sm text-foreground-secondary leading-relaxed mb-8 max-w-2xl">
          Every product below is complete without the other two. Buy one, buy all three,
          or pair one with tools you already run — nothing here needs a sibling product
          to work.
        </p>
        <div className="grid lg:grid-cols-3 gap-6">
          <Card className="p-6 flex flex-col">
            <h3 className="font-display font-bold text-lg text-foreground mb-2">GateTest</h3>
            <p className="text-sm font-semibold text-foreground mb-3">
              CI quality gate for AI-written code.
            </p>
            <p className="text-sm text-foreground-secondary leading-relaxed mb-4">
              Scans your repository or your live URL with the same {siteStats.modules.total}-module
              engine — security, performance, accessibility, SEO, supply chain, AI safety. Fails
              the job only on findings outside your committed baseline.
            </p>
            <Stat
              value="B · 85/100"
              label="Free scan on expressjs/express, graded by an independent buyer walk"
              source="Verified by Tallrig's buyer-walk report, 22 Sep 2026"
            />
            <ul className="text-xs text-foreground-secondary space-y-1.5 my-4">
              <li>
                Quick suite on a real 77-package customer monorepo: 69 minutes cut to under
                ten (9 m 55 s) after one engine fix
              </li>
              <li>
                A real customer tree: 438 blocking findings down to 237 in a day, catching two
                genuine bugs the customer fixed
              </li>
            </ul>
            <p className="text-sm text-foreground-secondary mb-4">
              From $29 per scan &mdash; no subscription required.
            </p>
            <p className="text-xs text-foreground-secondary italic mb-6">
              Runs on GitHub or any CI you already use.
            </p>
            <div className="mt-auto">
              <Link href="/playground" className="btn-primary inline-flex items-center gap-2 px-5 py-2.5 text-sm">
                Scan a repo free <span aria-hidden="true">→</span>
              </Link>
            </div>
          </Card>

          <Card className="p-6 flex flex-col">
            <h3 className="font-display font-bold text-lg text-foreground mb-2">Gluecron</h3>
            <p className="text-sm font-semibold text-foreground mb-3">
              Git hosting with the gate on every push.
            </p>
            <p className="text-sm text-foreground-secondary leading-relaxed mb-4">
              A git host built for agents. [GLUECRON: pending their words &mdash; full pitch]
            </p>
            <p className="text-sm text-foreground-secondary mb-4">
              [GLUECRON: pending their words &mdash; one verifiable proof point]
            </p>
            <p className="text-sm text-foreground-secondary mb-4">
              [GLUECRON: pending their words &mdash; price model]
            </p>
            <p className="text-xs text-foreground-secondary italic mb-6">
              Its own CI gate runs on every push &mdash; nothing external required.
            </p>
            <div className="mt-auto">
              <a
                href="https://gluecron.com"
                target="_blank"
                rel="noopener noreferrer"
                className="btn-primary inline-flex items-center gap-2 px-5 py-2.5 text-sm"
              >
                Visit Gluecron <span aria-hidden="true">→</span>
              </a>
            </div>
          </Card>

          <Card className="p-6 flex flex-col">
            <h3 className="font-display font-bold text-lg text-foreground mb-2">{PLATFORM_NAME}</h3>
            <p className="text-sm font-semibold text-foreground mb-3">
              The developer platform for the next decade.
            </p>
            <p className="text-sm text-foreground-secondary leading-relaxed mb-4">
              Deploy your services and scheduled jobs, run managed Postgres, send email, and
              register and serve your domains from one dashboard, on infrastructure {PLATFORM_NAME}{" "}
              owns and operates. One bill, one place.
            </p>
            <p className="text-sm text-foreground-secondary mb-4">
              {PLATFORM_HOST} states its own initial JavaScript weight, measured and stamped at
              build time &mdash; 110 KB on 23 September 2026. Check it in your browser&apos;s
              network panel.
            </p>
            <p className="text-sm text-foreground-secondary mb-4">
              Free with no card, Pro from $20/mo, Scale from $99/mo, Enterprise by conversation
              &mdash; every product on one bill with metered overage.
            </p>
            <p className="text-xs text-foreground-secondary italic mb-6">
              A new release has to answer its health check before any traffic moves to it, and
              the last good release keeps serving until it does.
            </p>
            <div className="mt-auto">
              <a
                href={PLATFORM_SITE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-primary inline-flex items-center gap-2 px-5 py-2.5 text-sm"
              >
                Visit {PLATFORM_NAME} <span aria-hidden="true">→</span>
              </a>
            </div>
          </Card>
        </div>
      </Section>

      <Section alt narrow title="Better together (optional)">
        <ul className="text-sm text-foreground-secondary space-y-4">
          <Card as="li" className="p-5">
            <span className="font-semibold text-foreground">Add GateTest to Gluecron:</span>{" "}
            a push to a Gluecron repo lands on the same Signal Bus queue GateTest already scans
            from for GitHub &mdash; the same checks on the diff, wherever the code lives.
          </Card>
          <Card as="li" className="p-5">
            <span className="font-semibold text-foreground">Add GateTest to {PLATFORM_NAME}:</span>{" "}
            GateTest checks the change before it is pushed; {PLATFORM_NAME}&apos;s gate checks the
            release before it goes live. Add GateTest and a bad change is stopped at the first
            door, with the same verdict you would have seen at the second.
          </Card>
          <Card as="li" className="p-5">
            <span className="font-semibold text-foreground">All three:</span>{" "}
            two independent gates &mdash; one on the diff, one on the deploy &mdash; from one team,
            in front of a git host built for the same agents writing the code.
          </Card>
        </ul>
        <div className="mt-6">
          <Callout tone="accent">
            Not built yet: there is no single login or shared console across GateTest, Gluecron
            and {PLATFORM_NAME}. Each keeps its own sign-in, its own dashboard and its own bill
            today.
          </Callout>
        </div>
      </Section>
    </main>
  );
}

const STEPS = [
  { name: "GateTest gates it", does: `${siteStats.modules.total} modules on every push. Failing scans block the merge; paid tiers open the fix PR.` },
  { name: "Gluecron hosts it", does: "A git host built for AI agents — repos, branches, PRs and webhooks the way an agent expects them." },
  { name: `${PLATFORM_NAME} runs it`, does: "Scheduled jobs and background work at the edge, with zero infrastructure to manage." },
];

const PRODUCTS = [
  {
    name: "GateTest",
    badge: "G",
    badgeColor: "bg-accent",
    tagline: "CI quality gate for AI-written code.",
    body:
      `QA + security audit for your codebase OR your live website. ${siteStats.modules.total} modules covering security, performance, accessibility, SEO, supply chain, AI safety. Pay per scan, not per seat.`,
    bullets: [
      "Free preview shows your top issues — no card, no signup",
      "Pay-per-scan from $29 — no subscription required",
      "Same engine scans your code AND your live URL",
      "Plain-language report you can hand to anyone",
    ],
    href: "/",
    external: false,
    highlighted: true,
  },
  {
    name: "Gluecron",
    badge: "Gc",
    badgeColor: "bg-indigo-500",
    tagline: "The git host built for AI agents.",
    body:
      "A git host designed from day one for the era when most of the code is being written by AI agents. Programmatic webhook API, agent-friendly auth, agent-aware tooling. GateTest scans Gluecron repos first-class through its Signal Bus.",
    bullets: [
      "Repos, branches, PRs — done the way an agent expects them",
      "Programmatic webhook registration via REST (no clicking through UIs)",
      "PAT auth that just works for agents",
      "No code-AI-training opt-in question because there's no opt-in",
    ],
    href: "https://gluecron.com",
    external: true,
  },
  {
    name: PLATFORM_NAME,
    badge: "Ct",
    badgeColor: "bg-amber-500",
    tagline: "Scheduled jobs with a record per run.",
    body:
      `Scheduled jobs, background tasks and event-driven work, each run recorded with its start time, exit status, output and duration. Jobs are defined in code and dispatched by ${PLATFORM_NAME}; there is no server to provision.`,
    bullets: [
      "A row per run: fired at, exit status, output, duration",
      "No server to provision or patch",
      "Jobs are defined in code and readable by tooling, including agents",
      "Billed per run that executes",
    ],
    href: PLATFORM_SITE_URL,
    external: true,
  },
];
