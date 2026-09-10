import type { Metadata } from "next";
import Link from "next/link";
import PageHero from "../../components/site/PageHero";
import Section from "../../components/site/Section";

export const metadata: Metadata = {
  title: "GateTest Installed — You're All Set",
  description: "GateTest is now running a free quick gate on your repos on every push and PR.",
};

const NEXT_STEPS = [
  "Push code to any connected repo",
  "GateTest scans automatically (syntax, lint, secrets, code quality)",
  "Green check or red X appears on your commit",
  "Open a PR — detailed scan report posted as a comment",
];

export default function Installed() {
  return (
    <main>
      <PageHero
        align="center"
        eyebrow="Installed"
        title={<span className="gradient-text">GateTest is live.</span>}
        lede="Every push and pull request now gets a free quick gate — syntax, lint, and hardcoded-secret detection. Results appear as commit statuses and PR comments."
      />

      <Section narrow>
        <div className="max-w-xl mx-auto text-center">
          {/* Success state */}
          <div className="w-20 h-20 rounded-full bg-success/10 border-2 border-success/30 flex items-center justify-center mx-auto mb-8">
            <span className="text-4xl text-success">&#10003;</span>
          </div>

          {/* What happens next — what the CI sees, so it stays a dark panel */}
          <div className="rounded-xl bg-panel text-panel-foreground border border-panel-border overflow-hidden max-w-md mx-auto mb-10">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-panel-border bg-panel-alt">
              <div className="w-3 h-3 rounded-full bg-danger/80" />
              <div className="w-3 h-3 rounded-full bg-warning/80" />
              <div className="w-3 h-3 rounded-full bg-success/80" />
              <span className="ml-3 text-xs text-panel-muted">What happens next</span>
            </div>
            <div className="p-6 text-left text-sm space-y-3">
              {NEXT_STEPS.map((step) => (
                <div key={step} className="flex items-start gap-3">
                  <span className="text-emerald-400 shrink-0">&#10003;</span>
                  <span className="text-panel-muted">{step}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Upgrade CTA */}
          <div className="card p-6 max-w-md mx-auto mb-8">
            <h2 className="font-display font-bold text-foreground mb-2">Want auto-fixes too?</h2>
            <p className="text-sm text-muted mb-4">
              Upgrade to Scan + Fix and GateTest will automatically create PRs
              that fix the issues it finds. From $199 per scan.
            </p>
            <Link
              href="/#pricing"
              className="btn-cta inline-block px-6 py-3 text-sm font-semibold rounded-xl"
            >
              See Pricing
            </Link>
          </div>

          <Link
            href="/"
            className="text-sm text-muted hover:text-foreground transition-colors"
          >
            &larr; Back to gatetest.io
          </Link>
        </div>
      </Section>
    </main>
  );
}
