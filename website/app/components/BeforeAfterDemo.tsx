/**
 * <BeforeAfterDemo> — visual showcase of the painkiller story.
 *
 * The whole pitch in one frame: CI goes red at 2am → GateTest auto-fix
 * PR appears within 60s → reviewer merges → CI goes green. This is the
 * screenshot HN visitors share when they decide we're worth their time.
 *
 * Pure CSS / no third-party libs. The middle panel has a "working" step
 * with a CSS ping animation so the panel feels alive without screaming.
 * Mobile: stacks vertically. Desktop: three columns side-by-side.
 */

export default function BeforeAfterDemo() {
  return (
    <section id="features" className="px-6 py-24 border-t border-white/5 bg-background relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-accent/[0.03] to-transparent pointer-events-none" />

      <div className="relative z-10 max-w-6xl mx-auto">
        <div className="text-center mb-12">
          <span className="text-sm font-semibold text-accent-light uppercase tracking-wider">
            What you get
          </span>
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold mt-4 mb-4 text-foreground">
            From red CI to merged fix &mdash;{" "}
            <span className="gradient-text">while you sleep.</span>
          </h2>
          <p className="text-muted text-lg max-w-2xl mx-auto">
            Most tools tell you what&apos;s broken. We open the PR that fixes
            it. This is what a single GateTest run looks like, end-to-end.
          </p>
        </div>

        <div className="grid lg:grid-cols-3 gap-4 lg:gap-2">
          <Panel
            stage="1"
            timestamp="02:14 UTC"
            badge="CI failed"
            badgeColor="red"
            title="A test breaks on main"
            body={
              <>
                <pre className="text-xs sm:text-sm font-mono text-red-300/90 whitespace-pre-wrap bg-black/40 rounded-md p-3 leading-relaxed">
{`× crontech-api.service failed
  ReferenceError: resolveTenantCapForHotPath
    is not defined
  at apps/api/src/cdn/handler.ts:65:22
  Bun v1.3.14 (Linux x64)

  ::error file=apps/api/src/cdn/handler.ts,
    line=65::ReferenceError`}
                </pre>
                <p className="text-xs text-white/40 mt-3">
                  A real Crontech failure from 2026-05-24. The api crashed at
                  module load. Rollback also failed.
                </p>
              </>
            }
          />

          <Panel
            stage="2"
            timestamp="02:14 + 38s"
            badge="GateTest working"
            badgeColor="teal"
            title="Auto-fix runs while you sleep"
            body={
              <>
                <ul className="text-sm space-y-2.5 mb-3">
                  <Step state="done">Re-runs the gate to isolate the failing module</Step>
                  <Step state="done">Reads the project conventions (README, AGENTS.md)</Step>
                  <Step state="done">Generates the fix with Claude Sonnet 4</Step>
                  <Step state="done">Validates the fix re-passes the gate</Step>
                  <Step state="done">Writes a regression test for the bug</Step>
                  <Step state="working">Pair-reviews the fix with a second Claude</Step>
                </ul>
                <p className="text-xs text-white/40">
                  ~38 seconds, ~$0.02 in Anthropic API spend per fix on the
                  $99 tier. Margin: 100x.
                </p>
              </>
            }
          />

          <Panel
            stage="3"
            timestamp="02:15 UTC"
            badge="PR opened"
            badgeColor="emerald"
            title="A fix PR lands in your repo"
            body={
              <>
                <pre className="text-xs sm:text-sm font-mono text-emerald-300/90 whitespace-pre-wrap bg-black/40 rounded-md p-3 leading-relaxed">
{`+ import { resolveTenantCapForHotPath }
+   from "./quotas";

  const handler = createSomething({
    tenantCapResolver:
      resolveTenantCapForHotPath,
    ...
  });

✓ Tests added (1)  ✓ Gate green`}
                </pre>
                <p className="text-xs text-white/40 mt-3">
                  One-click &ldquo;Commit suggestion&rdquo; in GitHub. CI re-runs
                  green. You wake up to a merged fix instead of a 47-message
                  Slack thread.
                </p>
              </>
            }
          />
        </div>

        <p className="text-center text-base sm:text-lg text-white/55 mt-12 max-w-3xl mx-auto">
          No other tool ships{" "}
          <strong className="text-white">scan + fix + regression test +
            pair-review + cross-finding correlation</strong>{" "}
          on pay-per-scan pricing. <span className="text-accent-light">We do.</span>
        </p>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────── */

function Panel({
  stage,
  timestamp,
  badge,
  badgeColor,
  title,
  body,
}: {
  stage: string;
  timestamp: string;
  badge: string;
  badgeColor: "red" | "teal" | "emerald";
  title: string;
  body: React.ReactNode;
}) {
  const badgeStyles: Record<typeof badgeColor, string> = {
    red: "bg-red-500/10 border-red-500/30 text-red-300",
    teal: "bg-accent/10 border-accent/30 text-accent-light",
    emerald: "bg-emerald-500/10 border-emerald-500/30 text-emerald-300",
  };
  const borderStyles: Record<typeof badgeColor, string> = {
    red: "border-red-500/20",
    teal: "border-accent/30",
    emerald: "border-emerald-500/20",
  };

  return (
    <div
      className={`relative rounded-2xl border ${borderStyles[badgeColor]} bg-surface/50 p-6 backdrop-blur-sm`}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-white/35 uppercase tracking-wider">
            Step {stage}
          </span>
          <span className="text-xs font-mono text-white/30">&middot;</span>
          <span className="text-xs font-mono text-white/35">{timestamp}</span>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border ${badgeStyles[badgeColor]}`}
        >
          {badgeColor === "red" && (
            <span className="w-1.5 h-1.5 rounded-full bg-red-400" aria-hidden />
          )}
          {badgeColor === "teal" && (
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" aria-hidden />
          )}
          {badgeColor === "emerald" && (
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" aria-hidden />
          )}
          {badge}
        </span>
      </div>

      <h3 className="text-lg font-semibold text-foreground mb-3">{title}</h3>

      {body}
    </div>
  );
}

function Step({
  state,
  children,
}: {
  state: "done" | "working";
  children: React.ReactNode;
}) {
  if (state === "done") {
    return (
      <li className="flex items-start gap-2 text-white/80">
        <span className="text-accent-light text-xs mt-1" aria-hidden>
          &#10003;
        </span>
        <span>{children}</span>
      </li>
    );
  }
  return (
    <li className="flex items-start gap-2 text-white/80">
      <span className="relative inline-flex h-3 w-3 mt-1 shrink-0" aria-hidden>
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent/70 opacity-75" />
        <span className="relative inline-flex h-3 w-3 rounded-full bg-accent" />
      </span>
      <span>{children}</span>
    </li>
  );
}
