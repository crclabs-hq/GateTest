/**
 * Quickstart — the 5-minute "install → first auto-fix PR" path.
 *
 * Built for the HN visitor who lands here from a comment thread, has a CI that
 * fails sometimes, and wants to confirm in under 5 minutes whether GateTest
 * actually opens a real fix PR. The two failure modes that kill day-one trust:
 *   1. They install but skip the ANTHROPIC_API_KEY step → CI fails → no PR
 *      opens → they conclude the product doesn't work. We make Step 2 visually
 *      impossible to miss.
 *   2. They install on a green CI → nothing to fix → no PR → assume the
 *      product is broken. We give an explicit "Step 4 — push a deliberate
 *      lint failure to see it work" so success is observable.
 *
 * Voice: direct imperative. No marketing fluff inside the steps. The header
 * sells the outcome; the steps just execute it.
 */

import Link from "next/link";
import PageHero from "../components/site/PageHero";
import Section from "../components/site/Section";

export const metadata = {
  title: "GateTest Quickstart — install to first fix PR in 5 minutes",
  description:
    "Install GateTest on a GitHub repo, add one secret, push a commit, watch an auto-fix PR open. Four steps, five minutes. Free to try.",
};

export default function Quickstart() {
  return (
    <main>
      <PageHero
        align="center"
        eyebrow="5 minutes from install to first auto-fix PR"
        title={<>Get your CI <span className="text-accent">self-healing</span><br />in four steps.</>}
        lede="You install one workflow, add one secret, and the next time your CI fails you get a pull request with the fix already written."
      />

      {/* Steps */}
      <Section>
        <div className="max-w-4xl mx-auto space-y-8">
          {/* Step 1 — Install */}
          <Step n={1} title="Install the workflow" timeEstimate="~30 seconds">
            <p className="text-sm text-muted mb-4">
              From the root of any GitHub repo, run the one-liner. It drops
              three files: the CI workflow, a pre-push hook, and a protection
              marker. Nothing else changes.
            </p>
            <CodeBlock>
              curl -sSL https://raw.githubusercontent.com/crclabs-hq/gatetest/main/integrations/scripts/install.sh | bash
            </CodeBlock>
            <Note>
              Public or private repos both work. The workflow file only
              <strong> reads</strong> your code &mdash; nothing is sent
              anywhere until CI runs.
            </Note>
          </Step>

          {/* Step 2 — Secret. THE critical step. */}
          <Step n={2} title="Add the ANTHROPIC_API_KEY secret" timeEstimate="~2 minutes" highlight>
            <p className="text-sm text-muted mb-4">
              This is what unlocks auto-fix PRs. Without this secret, CI still
              runs the gate &mdash; but no PR opens when something fails.
            </p>

            <div className="rounded-lg border border-warning/40 bg-warning/5 p-4 mb-5 text-sm">
              <p className="font-semibold text-warning mb-2">⚠ This is the step most people skip.</p>
              <p className="text-foreground-secondary">
                If you skip it, your CI will still detect bugs but won&apos;t open fix PRs.
                You&apos;ll see a yellow &ldquo;auto-repair not configured&rdquo; warning on every failing run.
              </p>
            </div>

            <ol className="text-sm space-y-3 mb-5 list-decimal list-inside text-foreground">
              <li>
                Open the secrets page for your repo or org:
                <CodeBlock>https://github.com/{"<your-org>"}/{"<your-repo>"}/settings/secrets/actions</CodeBlock>
                <p className="text-xs text-muted mt-1 ml-5">
                  Or for the whole org at once:{" "}
                  <code className="text-foreground">github.com/organizations/{"<your-org>"}/settings/secrets/actions</code>
                </p>
              </li>
              <li>
                Click <strong>New repository secret</strong> (or <em>organization secret</em>).
              </li>
              <li>
                <strong>Name:</strong> <code className="text-foreground">ANTHROPIC_API_KEY</code>
              </li>
              <li>
                <strong>Value:</strong> your Anthropic API key. Get one at{" "}
                <a
                  href="https://console.anthropic.com/settings/keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                >
                  console.anthropic.com
                </a>
                {" "}&mdash; pay-as-you-go, no minimum, a typical fix PR costs ~$0.02 in API spend.
              </li>
              <li>Save.</li>
            </ol>

            <Note>
              We never see or store your key &mdash; it goes from GitHub Secrets
              directly to Anthropic at fix-time. You&apos;re billed by Anthropic
              for the API usage, not by us.
            </Note>
          </Step>

          {/* Step 3 — Trigger */}
          <Step n={3} title="Push a commit (deliberate or real)" timeEstimate="~1 minute">
            <p className="text-sm text-muted mb-4">
              On your next push or pull request, the workflow runs. If
              everything passes, the gate shows green and you move on. If it
              finds a fixable bug, Step 4 kicks in.
            </p>
            <p className="text-sm text-muted mb-4">
              <strong>Want to see it work end-to-end?</strong> Add an obvious
              bug and push:
            </p>
            <CodeBlock>{`# Pick any JS/TS file in the repo, add a stray console.log + commit
echo 'console.log("debug");' >> src/some-file.js
git add -A && git commit -m "test: trigger gate" && git push`}</CodeBlock>
            <p className="text-xs text-muted mt-3">
              The gate flags <code>console.log in library code</code> as
              error-severity. CI goes red. Auto-fix runs.
            </p>
          </Step>

          {/* Step 4 — Receive PR */}
          <Step n={4} title="Watch the fix PR open" timeEstimate="~1 minute">
            <p className="text-sm text-muted mb-4">
              Within ~60 seconds of CI failing, a new pull request appears in
              your repo titled{" "}
              <code className="text-foreground">
                AI CI-fixer: repair workflow run #{"<id>"}
              </code>
              . It contains:
            </p>

            <ul className="text-sm space-y-2 mb-5">
              <Bullet>
                The actual code fix &mdash; <code>console.log</code> replaced
                with <code>process.stderr.write</code>, or whatever was
                appropriate for the specific finding.
              </Bullet>
              <Bullet>
                A before/after scan summary in the PR body.
              </Bullet>
              <Bullet>
                A regression test for the bug (so it can&apos;t silently come
                back).
              </Bullet>
              <Bullet>
                On Scan + Fix and Forensic Scan tiers: a pair-review comment from a
                second Claude scoring the fix on 4 axes.
              </Bullet>
            </ul>

            <p className="text-sm text-muted">
              Review it like any other PR. Merge it if you&apos;re happy. Your
              gate stays red until either this PR merges or you fix it yourself.
            </p>
          </Step>
        </div>
      </Section>

      {/* Troubleshooting */}
      <Section alt narrow title="Nothing happened on a failing run?">
        <div className="space-y-4">
          <Trouble q="The workflow ran but no fix PR appeared.">
            Check the workflow output for a yellow{" "}
            <em>&ldquo;auto-repair not configured&rdquo;</em> warning. If you
            see it, Step 2 didn&apos;t land &mdash; the{" "}
            <code className="text-foreground">ANTHROPIC_API_KEY</code> secret
            isn&apos;t set on the repo (or org).
          </Trouble>
          <Trouble q="The workflow says &ldquo;auto-repair could not generate any fixes.&rdquo;">
            The fix engine ran but couldn&apos;t produce a verified patch.
            Common causes: file too large (&gt; 50KB), config-level finding
            with no file:line to anchor a fix, or the finding wasn&apos;t a
            straightforward code change (architecture, dependency choice).
            Check the per-finding{" "}
            <code className="text-foreground">[skipped: &hellip;]</code>
            {" "}lines in the workflow log for the reason.
          </Trouble>
          <Trouble q="CI passes but I want to see a fix PR anyway.">
            The gate only opens PRs when something fails. Try Step 3&apos;s
            &ldquo;add a deliberate bug&rdquo; trick &mdash; cheapest way to
            see the loop work end-to-end on a real repo.
          </Trouble>
          <Trouble q="I&apos;m on GitLab/Jenkins/CircleCI, not GitHub.">
            Don&apos;t hand-write the pipeline &mdash;{" "}
            <code className="text-foreground">npx @gatetest/cli --ci-init gitlab</code>{" "}
            writes a complete{" "}
            <code className="text-foreground">.gitlab-ci.yml</code>, and{" "}
            <code className="text-foreground">--ci-init circleci</code> writes{" "}
            <code className="text-foreground">.circleci/config.yml</code> (
            <code className="text-foreground">github</code> is also accepted).
            Both generate a quick gate on merge requests, a full scan on the
            main branch, and JUnit + SARIF artifacts wired to the native test
            reporting. On any other CI,{" "}
            <code className="text-foreground">npx @gatetest/cli --suite full</code>{" "}
            from your pipeline runs the same 121 modules. Auto-fix PRs are also
            available from the CLI via{" "}
            <code className="text-foreground">gatetest fix --apply</code> and{" "}
            <code className="text-foreground">--auto-pr</code>.
          </Trouble>
        </div>
      </Section>

      {/* Onboarding an existing repo — baseline mode */}
      <Section
        narrow
        title="Turning it on over an existing codebase"
        lede={<>
          Point any scanner at a mature repo and the first run is a backlog you
          didn&apos;t write. Baseline mode grandfathers everything that exists
          today, so the gate only ever fails on <strong>new</strong> findings
          &mdash; you adopt it without stopping to fix years of history first.
        </>}
      >
        <CodeBlock>{`# Snapshot every current finding, then commit the file
gatetest --baseline
git add .gatetest/baseline.json && git commit -m "chore: baseline GateTest"

# From now on the gate blocks only on findings that aren't in it
gatetest --suite full`}</CodeBlock>
        <ul className="text-muted space-y-2 text-sm leading-relaxed list-disc pl-5 mt-6">
          <li>
            Baselined findings stay <strong>visible</strong> in every report.
            They are silenced for the gate decision, not hidden from you.
          </li>
          <li>
            The count is tracked per file, so you can&apos;t sneak a new
            problem in behind an old one &mdash; add a second empty catch to a
            file that already had one baselined and the gate blocks again.
          </li>
          <li>
            Fix a baselined finding and it&apos;s gone for good. Refresh the
            snapshot after paying down debt with{" "}
            <code className="text-foreground">gatetest --baseline</code>, or
            delete{" "}
            <code className="text-foreground">.gatetest/baseline.json</code>{" "}
            to see everything again.
          </li>
        </ul>
      </Section>

      {/* Next steps */}
      <Section alt narrow>
        <div className="text-center">
          <h2 className="font-display text-2xl sm:text-3xl font-bold text-foreground mb-4">You&apos;re live. What&apos;s next?</h2>
          <p className="text-muted max-w-xl mx-auto mb-8">
            The free path covers most of what you need. Upgrade tiers if you
            want deeper analysis, pair-review, and cross-finding attack-chain
            correlation.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Link href="/#pricing" className="btn-cta px-6 py-3 text-sm font-semibold rounded-xl">
              See pricing &rarr;
            </Link>
            <Link href="/docs/configuration" className="btn-secondary px-6 py-3 text-sm font-semibold rounded-xl">
              Config &amp; suppression
            </Link>
            <Link href="/docs/api" className="btn-secondary px-6 py-3 text-sm font-semibold rounded-xl">
              CLI reference
            </Link>
            <Link href="/how-it-works" className="btn-secondary px-6 py-3 text-sm font-semibold rounded-xl">
              How the fix loop works
            </Link>
          </div>
        </div>
      </Section>
    </main>
  );
}

/* ----------------------------- subcomponents ----------------------------- */

function Step({
  n,
  title,
  timeEstimate,
  children,
  highlight = false,
}: {
  n: number;
  title: string;
  timeEstimate: string;
  children: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <div className={`p-6 sm:p-8 ${highlight ? "card-highlight" : "card"}`}>
      <div className="flex items-start gap-4 mb-4">
        <div
          className={`w-10 h-10 rounded-lg flex items-center justify-center font-[var(--font-mono)] font-bold shrink-0 ${
            highlight
              ? "bg-accent/15 border border-accent/30 text-accent"
              : "section-alt border border-border text-foreground"
          }`}
        >
          {n}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-display text-xl font-semibold mb-1 text-foreground">{title}</h3>
          <p className="text-xs text-muted">{timeEstimate}</p>
        </div>
      </div>
      <div className="pl-0 sm:pl-14">{children}</div>
    </div>
  );
}

// Commands are what the terminal shows, so they stay a dark panel.
function CodeBlock({ children }: { children: React.ReactNode }) {
  return (
    <pre className="rounded-lg bg-panel text-emerald-300 border border-panel-border p-4 mb-2 font-[var(--font-mono)] text-xs sm:text-sm overflow-x-auto whitespace-pre-wrap break-all">
      {children}
    </pre>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-4 text-xs text-muted section-alt border border-border rounded-lg p-3">
      {children}
    </p>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-foreground">
      <span className="text-accent mt-0.5">&#10003;</span>
      <span>{children}</span>
    </li>
  );
}

function Trouble({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <details className="card p-4 group">
      <summary className="font-semibold text-foreground cursor-pointer group-open:mb-3">
        {q}
      </summary>
      <p className="text-sm text-muted">{children}</p>
    </details>
  );
}
