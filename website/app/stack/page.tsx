import Link from "next/link";
import PageHero from "../components/site/PageHero";
import Section from "../components/site/Section";
import siteStats from "../data/site-stats.json";

// gatetest.io/stack — "One team, three products" page.
//
// Boss Rule #8 — all customer-facing copy below is a draft for Craig's
// final review. Drafted by GateTest session 016MgmXrLw4Y35fnyTBLS96m
// on 2026-05-13.

export const metadata = {
  title: "One team, three products — GateTest · Gluecron · Vapron",
  description:
    "GateTest audits your code and your site. Gluecron hosts your git. Vapron tells you when something breaks. All built by the same team. Use whichever solves your problem.",
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
            <span className="text-accent">Vapron runs it.</span>
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
            Use GateTest without ever signing up for Gluecron. Use Vapron without ever touching
            GateTest. Or use all three. The choice stays yours.
          </p>
          <p>
            The shared philosophy: <span className="font-semibold text-foreground">pay-per-use where it works,
            no-subscription-pressure, and brutally honest about what each tool DOES and DOESN&apos;T do.</span>
          </p>
        </div>
      </Section>

      <Section narrow title="How they fit together (if you use more than one)">
        <ul className="text-sm text-foreground-secondary space-y-4">
          <li className="card p-5">
            <span className="font-semibold text-foreground">Code on Gluecron, audited by GateTest:</span>{" "}
            push triggers a scan; failing scans block the merge. Same gate story as a GitHub repo,
            but on a git host that Claude actually understands.
          </li>
          <li className="card p-5">
            <span className="font-semibold text-foreground">Scheduled jobs on Vapron, audited by GateTest:</span>{" "}
            the cron / background work that powers your product gets the same QA treatment as your
            request-path code. GateTest scans the job definition; Vapron runs it at the edge.
          </li>
          <li className="card p-5">
            <span className="font-semibold text-foreground">All three:</span>{" "}
            code on Gluecron, gated by GateTest at push-time, scheduled jobs running on Vapron.
            End-to-end coverage with three independent tools, three independent bills, three
            independent failure modes.
          </li>
        </ul>
      </Section>
    </main>
  );
}

const STEPS = [
  { name: "GateTest gates it", does: `${siteStats.modules.total} modules on every push. Failing scans block the merge; paid tiers open the fix PR.` },
  { name: "Gluecron hosts it", does: "A git host built around Claude — repos, branches, PRs and webhooks the way an agent expects them." },
  { name: "Vapron runs it", does: "Scheduled jobs and background work at the edge, with zero infrastructure to manage." },
];

const PRODUCTS = [
  {
    name: "GateTest",
    badge: "G",
    badgeColor: "bg-accent",
    tagline: "AI writes fast. GateTest keeps it honest.",
    body:
      `QA + security audit for your codebase OR your live website. ${siteStats.modules.total} modules covering security, performance, accessibility, SEO, supply chain, AI safety. Pay per scan, not per seat.`,
    bullets: [
      "Free preview shows your top 3 issues",
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
    tagline: "The git host built around Claude.",
    body:
      "A git host designed from day one for the era when most of the code is being written by AI agents. Programmatic webhook API, agent-friendly auth, Claude-aware tooling. The platform GateTest itself runs on.",
    bullets: [
      "Repos, branches, PRs — done the way Claude expects them",
      "Programmatic webhook registration via REST (no clicking through UIs)",
      "PAT auth that just works for agents",
      "No code-AI-training opt-in question because there's no opt-in",
    ],
    href: "https://gluecron.com",
    external: true,
  },
  {
    name: "Vapron",
    badge: "Ct",
    badgeColor: "bg-amber-500",
    tagline: "AI-native. Edge-first. Zero ops.",
    body:
      "Scheduled jobs, background tasks, and event-driven work that runs at the edge with zero infrastructure to manage. Designed for the agent era — describe what you want done; Vapron runs it.",
    bullets: [
      "Edge-first runtime — close to your users, close to your data",
      "Zero infra to provision, zero on-call rotation",
      "AI-native by design — Claude understands your jobs",
      "Pay only when work actually runs",
    ],
    href: "https://vapron.ai",
    external: true,
  },
];
