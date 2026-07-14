/**
 * <HomeModelChoice> — "Your key, or ours. Your model, or our pick."
 *
 * The single biggest differentiator no competitor has: the customer chooses
 * the AI model AND who pays for it. Grounded in engine-models.js:
 *   - Deterministic 120-module scan uses ZERO Claude tokens.
 *   - BYOK: user's ANTHROPIC_API_KEY, their model, their spend, no cap.
 *   - Supplied (metered): we provide a budget-capped key; Sonnet 5 / Opus 4.8 /
 *     Fable 5, priced per the model that actually ran (budget-tracker.js).
 *
 * SonarQube / Snyk can't fix at all; DeepSource picks the model for you.
 * Every claim here is already shipped — no vaporware.
 */

const MODELS = [
  {
    name: "Sonnet 5",
    id: "claude-sonnet-5",
    tag: "Default",
    tagClass: "bg-accent/10 text-accent border-accent/25",
    blurb: "Fast and cheapest. The default for scans, chat, and everyday fixes.",
  },
  {
    name: "Opus 4.8",
    id: "claude-opus-4-8",
    tag: "Deeper",
    tagClass: "bg-blue-500/10 text-blue-500 border-blue-500/25",
    blurb: "Heavier reasoning when a fix is subtle or spans many files.",
  },
  {
    name: "Fable 5",
    id: "claude-fable-5",
    tag: "Most capable",
    tagClass: "bg-violet-500/10 text-violet-500 border-violet-500/25",
    blurb:
      "The most capable model Anthropic ships — powers the $199 / $399 fix tiers.",
  },
];

export default function HomeModelChoice() {
  return (
    <section id="model-choice" className="py-24 px-6 border-t border-border bg-background">
      <div className="mx-auto max-w-6xl">
        {/* Heading */}
        <div className="text-center mb-14">
          <span className="text-sm font-semibold text-accent uppercase tracking-wider">
            You control the AI
          </span>
          <h2 className="text-3xl sm:text-4xl font-bold mt-4 mb-4 text-foreground">
            Your key, or ours.{" "}
            <span className="gradient-text">Your model, or our pick.</span>
          </h2>
          <p className="text-muted text-lg max-w-3xl mx-auto">
            The 120-module scan runs on{" "}
            <span className="text-foreground font-semibold">zero AI tokens</span>{" "}
            — pure deterministic speed. When a fix needs real intelligence,{" "}
            <span className="text-foreground font-semibold">you</span>{" "}
            decide how it&apos;s powered. No other QA tool lets you do this.
          </p>
        </div>

        {/* Two paths */}
        <div className="grid md:grid-cols-2 gap-6 mb-10">
          {/* BYOK */}
          <div className="rounded-2xl border border-accent/30 bg-gradient-to-br from-accent/[0.06] to-accent/[0.02] p-8 flex flex-col">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-bold uppercase tracking-widest text-accent">
                Bring your own key
              </span>
            </div>
            <p className="text-foreground/90 leading-relaxed mb-5">
              Point GateTest at your own{" "}
              <code className="font-mono text-sm text-accent">ANTHROPIC_API_KEY</code>.
              You pick the model, you own the spend, and there&apos;s no cap.
              Calls go straight from your machine to Anthropic —{" "}
              <span className="text-foreground font-semibold">never through our servers.</span>
            </p>
            <ul className="mt-auto space-y-2 text-sm text-muted">
              <li className="flex items-start gap-2"><span className="text-accent mt-0.5">✓</span> Your usage, your bill, your control</li>
              <li className="flex items-start gap-2"><span className="text-accent mt-0.5">✓</span> Any of the three models, per fix</li>
              <li className="flex items-start gap-2"><span className="text-accent mt-0.5">✓</span> Works on CLI, MCP, and the web fix route</li>
            </ul>
          </div>

          {/* Supplied / metered */}
          <div className="rounded-2xl border border-border bg-surface-solid p-8 flex flex-col">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-bold uppercase tracking-widest text-foreground/70">
                Or use ours
              </span>
            </div>
            <p className="text-foreground/90 leading-relaxed mb-5">
              No key? We supply one. Usage is{" "}
              <span className="text-foreground font-semibold">metered and budget-capped</span>{" "}
              — every fix is priced at the model that actually ran, so there are
              no surprises on the bill. Just run the scan and take the PR.
            </p>
            <ul className="mt-auto space-y-2 text-sm text-muted">
              <li className="flex items-start gap-2"><span className="text-accent mt-0.5">✓</span> Nothing to set up — buy a scan and go</li>
              <li className="flex items-start gap-2"><span className="text-accent mt-0.5">✓</span> Hard budget cap — never a runaway bill</li>
              <li className="flex items-start gap-2"><span className="text-accent mt-0.5">✓</span> Fable 5 on the paid fix tiers by default</li>
            </ul>
          </div>
        </div>

        {/* The three models */}
        <div className="grid sm:grid-cols-3 gap-4 mb-10">
          {MODELS.map((m) => (
            <div key={m.id} className="rounded-xl border border-border bg-surface-solid p-5">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-base font-bold text-foreground">{m.name}</h3>
                <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${m.tagClass}`}>
                  {m.tag}
                </span>
              </div>
              <p className="text-sm text-muted leading-relaxed">{m.blurb}</p>
            </div>
          ))}
        </div>

        {/* Competitor kicker */}
        <p className="text-center text-base text-foreground/80 max-w-3xl mx-auto">
          SonarQube can&apos;t fix it. Snyk can&apos;t fix it. DeepSource picks
          the model for you.{" "}
          <span className="text-foreground font-semibold">GateTest hands you the keys.</span>
        </p>
      </div>
    </section>
  );
}
