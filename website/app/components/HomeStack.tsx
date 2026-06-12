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
 * Honesty rule: every claim here is either the product's own published
 * tagline or a verifiable dogfood fact (the Hall of Scans entries, the
 * dual-host scan queue). No invented specs.
 */

const PRODUCTS = [
  {
    name: "Gluecron",
    domain: "gluecron.com",
    href: "https://gluecron.com",
    badge: "Gc",
    badgeColor: "bg-indigo-500",
    accent: "from-indigo-500/15 to-blue-500/5",
    tagline: "The git host built around Claude.",
    body:
      "Git hosting built for small teams — no tickets, no politics. GateTest is wired into it natively: every push lands on Gluecron's Signal Bus and triggers a scan from the same queue that serves GitHub.",
    proof: "Dogfooded hard: GateTest's Forensic scan ran against Gluecron's own codebase — full findings published in the Hall of Scans.",
    bullets: [
      "Push-to-scan: GateTest gates merges natively",
      "Built by the same team, used every day",
      "Independent product — no bundle lock-in",
    ],
  },
  {
    name: "Vapron",
    domain: "vapron.ai",
    href: "https://vapron.ai",
    badge: "V",
    badgeColor: "bg-amber-500",
    accent: "from-amber-500/15 to-orange-500/5",
    tagline: "Scheduled jobs that actually run. Cron with receipts.",
    body:
      "AI-native, edge-first, zero ops. The cron and background jobs that power your product — run with receipts, so \"did the job fire?\" is never a mystery again.",
    proof: "Dogfooded hard: the live demo on this page replays a real Vapron failure that GateTest caught and fixed. Full scan in the Hall of Scans.",
    bullets: [
      "Production scheduling without babysitting",
      "GateTest guards its codebase on every push",
      "Independent product — use it alone or together",
    ],
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
          <h2 className="text-3xl sm:text-4xl font-bold mt-4 mb-3 text-foreground">
            One team. Three products. Zero lock-in.
          </h2>
          <p className="text-muted text-base max-w-2xl mx-auto">
            GateTest keeps your code honest. Gluecron hosts your git. Vapron runs
            your scheduled jobs. Each stands alone — together they cover the whole
            &ldquo;real software in production&rdquo; problem.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-6 mb-10">
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

              <ul className="text-sm space-y-2 mb-5">
                {p.bullets.map((b) => (
                  <li key={b} className="flex items-start gap-2">
                    <span className="text-accent mt-0.5 font-bold">✓</span>
                    <span className="text-muted">{b}</span>
                  </li>
                ))}
              </ul>

              <p className="text-xs text-muted italic mb-6">{p.proof}</p>

              <div className="mt-auto flex flex-wrap gap-3">
                <a
                  href={p.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-accent text-white font-semibold text-sm hover:bg-accent-hover transition-colors"
                >
                  Visit {p.name} <span aria-hidden>→</span>
                </a>
                <Link
                  href="/scans"
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg border border-border text-foreground font-semibold text-sm hover:bg-surface-dark transition-colors"
                >
                  See the scan proof
                </Link>
              </div>
            </article>
          ))}
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
