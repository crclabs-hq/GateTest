/**
 * <HomeProof> — the executive/consumer confidence layer.
 *
 * Three moves, for the buyer who isn't an HN developer:
 *   1. ROI — the real cost is the fragmented stack GateTest replaces.
 *   2. Proof — a real scan on a real production repo, with real numbers
 *      (Crontech, from docs/proofs/phase-2-3-crontech-real-customer-grade.md).
 *      Honest and verifiable — Bible Forbidden #1.
 *   3. Staying power — Fable 5 still has the limitations GateTest solves,
 *      so this is a permanent layer, not a one-model-generation bet.
 *
 * Light / teal editorial system (var(--*) tokens) to match the rest of the
 * page. Static server component.
 */

const REPLACED = [
  "SonarQube", "Snyk", "ESLint", "BrowserStack", "Lighthouse CI",
  "Renovate", "Dependabot", "hadolint", "tfsec", "gitleaks", "+ 10 more",
];

export default function HomeProof() {
  return (
    <section className="max-w-6xl mx-auto my-20 px-4">
      {/* ── ROI ─────────────────────────────────────────────────────── */}
      <div className="text-center mb-12">
        <p className="text-xs uppercase tracking-widest text-[var(--accent)] font-semibold mb-3">
          The real math
        </p>
        <h2 className="text-3xl md:text-4xl font-black text-[var(--foreground)] tracking-tight max-w-3xl mx-auto">
          The scanner isn&apos;t the cost. The ten tools it replaces are.
        </h2>
      </div>

      <div className="grid md:grid-cols-2 gap-6 items-stretch mb-20">
        {/* The fragmented stack */}
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--background-alt)] p-7">
          <h3 className="font-bold text-[var(--foreground)] mb-1">The fragmented stack</h3>
          <p className="text-sm text-[var(--muted)] mb-5">
            Each with its own config, dashboard, and per-seat bill.
          </p>
          <div className="flex flex-wrap gap-2 mb-6">
            {REPLACED.map((t) => (
              <span
                key={t}
                className="text-xs font-mono px-2.5 py-1 rounded-md bg-white border border-[var(--border)] text-[var(--foreground-secondary)] line-through decoration-[var(--danger)]/60"
              >
                {t}
              </span>
            ))}
          </div>
          <ul className="text-sm text-[var(--foreground-secondary)] space-y-2">
            <li>· 10+ dashboards to check, 10+ invoices to reconcile</li>
            <li>· Per-seat pricing — the bill grows with headcount, not usage</li>
            <li>· No tool talks to the others — findings never correlate</li>
          </ul>
        </div>

        {/* GateTest */}
        <div className="rounded-2xl border-2 border-[var(--accent)] bg-[var(--surface-solid)] p-7 shadow-lg shadow-[var(--accent)]/10">
          <h3 className="font-bold text-[var(--accent)] mb-1">GateTest</h3>
          <p className="text-sm text-[var(--muted)] mb-5">
            One engine, 120 modules, one decision.
          </p>
          <ul className="text-sm text-[var(--foreground-secondary)] space-y-2.5 mb-6">
            <li className="flex gap-2"><span className="text-[var(--accent)]">✓</span> One config file, one gate — pass or the build stops</li>
            <li className="flex gap-2"><span className="text-[var(--accent)]">✓</span> Pay per run ($29–$399) or $49/mo continuous — <strong>no seats</strong></li>
            <li className="flex gap-2"><span className="text-[var(--accent)]">✓</span> Free forever on the CLI: <code className="font-mono text-xs bg-[var(--background-alt)] px-1 rounded">npx @gatetest/cli</code></li>
            <li className="flex gap-2"><span className="text-[var(--accent)]">✓</span> Findings correlate into attack chains no single linter sees</li>
          </ul>
          <p className="text-xs text-[var(--muted)]">
            Enterprise plans for SonarQube + Snyk alone run well into five figures a year.
            GateTest bills on what you scan, not how many engineers you employ.
          </p>
        </div>
      </div>

      {/* ── PROOF ───────────────────────────────────────────────────── */}
      <div className="text-center mb-8">
        <p className="text-xs uppercase tracking-widest text-[var(--accent)] font-semibold mb-3">
          Real scan · real production repo
        </p>
        <h2 className="text-2xl md:text-3xl font-black text-[var(--foreground)] tracking-tight">
          Not a demo. Here&apos;s what one run found.
        </h2>
      </div>

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-solid)] p-8 shadow-sm">
        <div className="grid sm:grid-cols-3 gap-6 text-center mb-8">
          <div>
            <div className="text-4xl font-black text-[var(--foreground)]">575</div>
            <div className="text-xs text-[var(--muted)] mt-1">code-quality issues<br />(file length, dead logs, complexity)</div>
          </div>
          <div>
            <div className="text-4xl font-black text-[var(--danger)]">14</div>
            <div className="text-xs text-[var(--muted)] mt-1">exposed secrets across<br />14 different files</div>
          </div>
          <div>
            <div className="text-4xl font-black text-[var(--accent)]">2</div>
            <div className="text-xs text-[var(--muted)] mt-1">critical attack chains<br />the correlator assembled</div>
          </div>
        </div>
        <div className="border-t border-[var(--border)] pt-6 text-sm text-[var(--foreground-secondary)] max-w-3xl mx-auto space-y-3">
          <p>
            The 14 secrets each look survivable in isolation. GateTest&apos;s correlator
            connected them into two <strong>critical</strong> chains a linter would never
            report: hard-coded credentials in a frontend component plus an admin
            onboarding route → <strong>credential exposure and admin takeover</strong>; and
            a leaked queue-client secret in auto-deploy scripts →{" "}
            <strong>supply-chain takeover via CI</strong>.
          </p>
          <p className="text-[var(--muted)] text-xs">
            Verbatim from a real scan of a production codebase — full report in{" "}
            <code className="font-mono">docs/proofs/</code>. We publish the receipts because
            &quot;AI finds your bugs&quot; is a crowded, over-promised space and you should be skeptical.
          </p>
        </div>
      </div>

      {/* ── STAYING POWER ───────────────────────────────────────────── */}
      <div className="mt-16 rounded-2xl bg-[var(--foreground)] text-white p-8 md:p-10 text-center">
        <p className="text-xs uppercase tracking-widest text-[var(--accent-light)] font-semibold mb-3">
          Why this isn&apos;t a fad
        </p>
        <p className="text-lg md:text-xl leading-relaxed max-w-3xl mx-auto">
          We&apos;re already on <strong className="text-[var(--accent-light)]">Fable 5</strong> — and the
          same failure modes remain. The model still can&apos;t see the rendered page, doesn&apos;t
          know what production is throwing, and can&apos;t prove its own fix worked. GateTest is
          the permanent layer around that: a <strong>deterministic gate</strong>, real{" "}
          <strong>senses</strong>, and <strong>proof</strong> — not a bet on one model generation.
        </p>
      </div>
    </section>
  );
}
