/**
 * /trust — credibility surface for enterprises evaluating GateTest before
 * installing on private repos. The page that lands when a CTO clicks
 * "Is this safe?" from the pricing page or the GitHub Marketplace listing.
 *
 * Design principles:
 *   - HONEST. Don't overclaim. We are not SOC2 today. We say so.
 *   - LINK-BACKED. Every claim points at a real artifact (the live self-scan,
 *     the public test count, the open source-policy commit, the privacy
 *     policy section).
 *   - NO FUD. Don't roast competitors here. Show our work instead.
 *
 * Voice: enterprise-direct. Plain English. Bullet points where bullets help,
 * full sentences where the reasoning matters.
 */

import Link from "next/link";
import SelfScanBadge from "@/app/components/SelfScanBadge";

export const metadata = {
  title: "Trust & Security — GateTest",
  description:
    "How GateTest handles your code, what we do and don't store, our security posture, and the roadmap to SOC2. Honest answers for engineering and security leaders.",
};

export default function TrustPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      {/* Hero */}
      <section className="px-6 pt-20 pb-10 max-w-4xl mx-auto text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-accent/10 border border-accent/20 text-accent text-sm font-medium mb-8">
          <span className="w-2 h-2 rounded-full bg-accent animate-pulse" aria-hidden />
          Trust &amp; Security
        </div>
        <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight mb-6">
          What we do with your code,{" "}
          <span className="hero-accent-text">in plain English.</span>
        </h1>
        <p className="text-lg sm:text-xl text-muted max-w-2xl mx-auto">
          You&apos;re about to install a tool that reads every file in your
          repo. Here&apos;s exactly how that works, what we store, and what we
          don&apos;t.
        </p>
      </section>

      {/* Self-scan + at-a-glance numbers */}
      <section className="px-6 py-10 max-w-5xl mx-auto">
        <div className="grid md:grid-cols-2 gap-6">
          <div className="rounded-2xl border border-border bg-surface p-6">
            <h2 className="text-sm font-semibold text-accent-light uppercase tracking-wider mb-3">
              We run GateTest on GateTest
            </h2>
            <p className="text-sm text-muted mb-5">
              Every commit to <code className="text-foreground">main</code>{" "}
              runs the same 120-module gate we sell. The badge below is the
              live verdict, updated within seconds of every CI run. If we
              ship a regression, you see it before we do.
            </p>
            <SelfScanBadge />
            <p className="text-xs text-muted mt-4">
              Polls our own{" "}
              <code className="text-foreground">/api/internal/self-scan-status</code>{" "}
              every 60 seconds.
            </p>
          </div>

          <div className="rounded-2xl border border-border bg-surface p-6">
            <h2 className="text-sm font-semibold text-accent-light uppercase tracking-wider mb-3">
              At a glance
            </h2>
            <ul className="text-sm space-y-3">
              <Metric label="Modules in the gate" value="120" />
              <Metric label="Tests passing on main" value="4,100+" />
              <Metric label="Auto-fix accuracy (Vapron dogfood)" value="100%" sub="3/3 prod crashes caught" />
              <Metric label="GitHub Marketplace" value="In review" sub="week 1 of approval" />
              <Metric label="SOC2 Type II" value="Audit Q3 2026" sub="not certified today — see roadmap below" />
            </ul>
          </div>
        </div>
      </section>

      {/* What we DO and DON'T do — the headline section */}
      <section className="px-6 py-16 border-t border-border/30">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-3xl font-bold text-center mb-4">
            What happens to your code
          </h2>
          <p className="text-muted text-center max-w-2xl mx-auto mb-12">
            The honest answer, scoped per install path. Pick the path that
            applies to you.
          </p>

          <div className="space-y-6">
            <ScopeCard
              path="GitHub App (recommended)"
              doList={[
                'We read the files in your repo via the GitHub API, scoped to the repositories you authorise during install.',
                "We send relevant file contents to Anthropic's Claude API ONLY when you trigger auto-fix and only for the files the gate flagged.",
                "We write findings to your repo's GitHub Security tab (SARIF) and post commit statuses on your PRs.",
                "We open pull requests in your repo when auto-fix produces a verified patch. You review and merge — we never merge for you.",
              ]}
              dontList={[
                "We DO NOT clone your repo to our servers. Files are read in-flight per scan.",
                "We DO NOT store your source code at rest. Scan results are kept; raw code is not.",
                "We DO NOT train any model on your code. Anthropic's API terms of service guarantee no training without opt-in.",
                "We DO NOT have write access to anything except your auto-fix branches. We cannot push to main, change settings, or read other repos.",
              ]}
            />

            <ScopeCard
              path="CLI in your CI (self-hosted)"
              doList={[
                "We are an npm package that runs entirely inside your CI runner. Your code never leaves your network during the scan.",
                "Auto-fix requires you to expose ANTHROPIC_API_KEY to the runner. Code sent to Anthropic stays subject to Anthropic's data policy — not ours.",
                "Reporters emit findings to local files (.gatetest/reports/) which your CI uploads as artifacts. We have zero visibility unless you choose to publish them.",
              ]}
              dontList={[
                "We have no telemetry. No usage metrics, no error reporting, no phone-home.",
                "We have no licence server. The CLI runs offline forever, no kill-switch.",
                "We do not require an account. You can run `npx @gatetest/cli` against any repo with zero signup.",
              ]}
            />

            <ScopeCard
              path="Public URL scan (gatetest.ai / wp / web)"
              doList={[
                "We fetch the public pages of the URL you supply, with the same User-Agent any browser would.",
                "We store the URL, the timestamp, and the scan results (no auth, no cookies, no personal data) to power the trust badge and the recurring continuous-scan tier.",
                "We charge Stripe ($29-$399) for the scan tier you select. Stripe holds the card data; we hold the session ID + tier.",
              ]}
              dontList={[
                "We DO NOT scan content behind authentication. We never see your dashboard, your admin panel, or any logged-in state.",
                "We DO NOT honeypot or probe destructively. Every request is a public GET — same as any web crawler.",
                "We DO NOT sell or share scan data. The only outputs are your scan report and the public health badge on your URL (which you can disable).",
              ]}
            />
          </div>
        </div>
      </section>

      {/* Security posture */}
      <section className="px-6 py-16 border-t border-border/30 bg-surface/30">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-3xl font-bold text-center mb-4">Security posture</h2>
          <p className="text-muted text-center max-w-2xl mx-auto mb-12">
            What we do today, and where we&apos;re going.
          </p>

          <div className="grid md:grid-cols-2 gap-4">
            <PostureCard
              title="Encryption"
              state="now"
              body={
                <>
                  All API traffic over TLS 1.3. Stripe payment data never
                  touches our servers (Stripe-hosted checkout). Anthropic API
                  calls go directly from your CI to Anthropic — we are not
                  in the middle.
                </>
              }
            />
            <PostureCard
              title="Secrets handling"
              state="now"
              body={
                <>
                  We use the <code className="text-foreground">secrets</code>{" "}
                  module on our own code. Zero hardcoded credentials. Stripe
                  + Anthropic keys live in Vercel environment variables,
                  rotated quarterly.
                </>
              }
            />
            <PostureCard
              title="No code storage at rest"
              state="now"
              body={
                <>
                  Per-scan: files read, scanned, results emitted. The raw
                  source code is dropped after scan completion. We retain
                  only the findings and timing metadata for the badge / report.
                </>
              }
            />
            <PostureCard
              title="Audit trail"
              state="now"
              body={
                <>
                  Every scan emits a signed SARIF report. Every auto-fix PR
                  links to the workflow run that produced it. You can
                  reproduce any fix locally with{" "}
                  <code className="text-foreground">node bin/gatetest.js --replay &lt;run-id&gt;</code>.
                </>
              }
            />
            <PostureCard
              title="SOC2 Type II"
              state="roadmap"
              body={
                <>
                  Audit kicks off Q3 2026. Until certified, do NOT install
                  GateTest on repos that have a contractual SOC2 vendor
                  requirement &mdash; use the self-hosted CLI path instead
                  (zero data leaves your network).
                </>
              }
            />
            <PostureCard
              title="HIPAA / PII handling"
              state="roadmap"
              body={
                <>
                  We are not currently a HIPAA business associate. Customers
                  with PHI workloads should run the self-hosted CLI; the
                  GitHub App path is not approved for PHI today.
                </>
              }
            />
          </div>
        </div>
      </section>

      {/* Memory-as-a-Service opt-in */}
      <section className="px-6 py-16 border-t border-border/30">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-3xl font-bold text-center mb-4">
            Cross-customer fix learning <span className="text-accent-light">— opt-in</span>
          </h2>
          <p className="text-muted text-center max-w-2xl mx-auto mb-10">
            We have a centralised fix-recipe store at{" "}
            <code className="text-foreground">gatetest.ai/api/recipes</code>{" "}
            so successful fixes from one customer can speed up the same
            fix on every other customer&apos;s next scan. <strong>It is
            OFF by default.</strong> Here&apos;s exactly what enabling it
            means.
          </p>

          <div className="rounded-2xl border border-border bg-surface p-6 sm:p-8 mb-6">
            <h3 className="text-lg font-semibold mb-4">How to enable</h3>
            <p className="text-sm text-muted mb-4">
              In your workflow (or <code className="text-foreground">.gatetest.json</code>):
            </p>
            <pre className="rounded-lg bg-black/40 border border-border p-4 font-[var(--font-mono)] text-xs sm:text-sm overflow-x-auto text-emerald-300 whitespace-pre-wrap">
{`- uses: crclabs-hq/gatetest@v1
  with:
    auto-fix: true
    share-learnings: true   # opt-in — see /trust
`}
            </pre>
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-5">
              <p className="text-sm font-semibold text-emerald-300 uppercase tracking-wider mb-3">
                What WE store, anonymously
              </p>
              <ul className="space-y-2 text-sm text-foreground/90">
                <li>&#10003; The module name (<code className="text-foreground">ssrf</code>, <code className="text-foreground">secrets</code>, etc.)</li>
                <li>&#10003; The finding type slug (<code className="text-foreground">tainted-url-to-fetch</code>)</li>
                <li>&#10003; The file extension (<code className="text-foreground">ts</code>, <code className="text-foreground">py</code>)</li>
                <li>&#10003; Before/after code snippets, capped at 2KB each</li>
                <li>&#10003; SHA-256 hash of the before snippet (dedup key)</li>
                <li>&#10003; Confidence + usage count</li>
              </ul>
            </div>

            <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-5">
              <p className="text-sm font-semibold text-red-300 uppercase tracking-wider mb-3">
                What we NEVER store
              </p>
              <ul className="space-y-2 text-sm text-foreground/90">
                <li>&times; File paths or directory structure</li>
                <li>&times; Repository names, URLs, or commit SHAs</li>
                <li>&times; User identifiers, emails, or installation IDs</li>
                <li>&times; Environment variables or secrets</li>
                <li>&times; Source code outside the 2KB before/after snippet</li>
                <li>&times; IP addresses (used only for in-memory rate limiting)</li>
              </ul>
            </div>
          </div>

          <p className="text-sm text-muted mt-6">
            <strong className="text-foreground">Private alternative:</strong>{" "}
            if you want the learning loop but don&apos;t want to share with the
            cross-customer pool, set{" "}
            <code className="text-foreground">recipe-store-url</code> to your
            own HTTP endpoint that implements the{" "}
            <code className="text-foreground">GET / PUT /recipes</code>{" "}
            contract. Your fixes never touch our servers.
          </p>
        </div>
      </section>

      {/* Independent verification */}
      <section className="px-6 py-16 max-w-4xl mx-auto">
        <h2 className="text-3xl font-bold text-center mb-4">
          Verify it yourself
        </h2>
        <p className="text-muted text-center max-w-2xl mx-auto mb-12">
          We don&apos;t expect you to trust us. Every claim above maps to a
          public artifact:
        </p>

        <div className="space-y-3">
          <VerifyRow
            claim="The 120 modules"
            verify={
              <>
                Run{" "}
                <code className="text-foreground">
                  npx @gatetest/cli --list
                </code>{" "}
                — the gate output is authoritative.
              </>
            }
          />
          <VerifyRow
            claim="The 4,100+ tests"
            verify={
              <>
                Clone the repo and run{" "}
                <code className="text-foreground">
                  node --test tests/*.test.js
                </code>{" "}
                — every file is in the open repo.
              </>
            }
          />
          <VerifyRow
            claim="The auto-fix loop catches real bugs"
            verify={
              <>
                See <Link href="/quickstart" className="text-accent-light hover:underline">/quickstart</Link>
                {" "}for a deliberate-bug recipe that triggers the loop in under 5 minutes
                on any GitHub repo.
              </>
            }
          />
          <VerifyRow
            claim="No third-party CVE in our dependencies"
            verify={
              <>
                Our own gate runs the{" "}
                <code className="text-foreground">dependencies</code> module
                on every commit. The CI badge above goes red the moment a
                new advisory lands on a transitive dep.
              </>
            }
          />
          <VerifyRow
            claim="The pay-per-scan model"
            verify={
              <>
                Stripe webhooks are the source of truth. We never bill
                without a successful scan. Refund policy:{" "}
                <Link
                  href="/legal/refunds"
                  className="text-accent-light hover:underline"
                >
                  /legal/refunds
                </Link>
                .
              </>
            }
          />
        </div>
      </section>

      {/* Contact */}
      <section className="px-6 py-16 border-t border-border/30 max-w-3xl mx-auto text-center">
        <h2 className="text-2xl font-bold mb-4">Found a security issue?</h2>
        <p className="text-muted mb-6">
          Responsible disclosure to{" "}
          <a
            href="mailto:security@gatetest.ai"
            className="text-accent-light hover:underline"
          >
            security@gatetest.ai
          </a>
          . We acknowledge within 24 hours. PGP key available on request.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <Link
            href="/legal/privacy"
            className="px-5 py-2.5 text-sm font-semibold rounded-xl border border-border text-foreground hover:border-accent/50 transition-colors"
          >
            Privacy policy
          </Link>
          <Link
            href="/legal/terms"
            className="px-5 py-2.5 text-sm font-semibold rounded-xl border border-border text-foreground hover:border-accent/50 transition-colors"
          >
            Terms of service
          </Link>
          <Link
            href="/quickstart"
            className="btn-cta px-5 py-2.5 text-sm font-semibold rounded-xl"
          >
            Try it in 5 minutes &rarr;
          </Link>
        </div>
      </section>
    </main>
  );
}

/* ─────────────────── subcomponents ─────────────────── */

function Metric({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <li className="flex items-baseline justify-between gap-3 pb-3 border-b border-border/50 last:border-0 last:pb-0">
      <div>
        <div className="text-foreground">{label}</div>
        {sub ? <div className="text-xs text-muted mt-0.5">{sub}</div> : null}
      </div>
      <div className="font-mono text-lg font-bold text-accent-light tabular-nums shrink-0">
        {value}
      </div>
    </li>
  );
}

function ScopeCard({
  path,
  doList,
  dontList,
}: {
  path: string;
  doList: string[];
  dontList: string[];
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-6 sm:p-8">
      <h3 className="text-xl font-semibold mb-5 text-foreground">{path}</h3>
      <div className="grid sm:grid-cols-2 gap-6">
        <div>
          <p className="text-sm font-semibold text-emerald-300 uppercase tracking-wider mb-3">
            What we do
          </p>
          <ul className="space-y-2.5">
            {doList.map((item, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-foreground/90">
                <span className="text-emerald-300 mt-0.5 shrink-0" aria-hidden>
                  &#10003;
                </span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="text-sm font-semibold text-red-300 uppercase tracking-wider mb-3">
            What we don&apos;t do
          </p>
          <ul className="space-y-2.5">
            {dontList.map((item, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-foreground/90">
                <span className="text-red-300 mt-0.5 shrink-0" aria-hidden>
                  &times;
                </span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function PostureCard({
  title,
  state,
  body,
}: {
  title: string;
  state: "now" | "roadmap";
  body: React.ReactNode;
}) {
  const badge = state === "now"
    ? { text: "Today", classes: "bg-emerald-500/10 border-emerald-500/30 text-emerald-300" }
    : { text: "Roadmap", classes: "bg-amber-500/10 border-amber-500/30 text-amber-300" };

  return (
    <div className="rounded-xl border border-border bg-background/40 p-5">
      <div className="flex items-center justify-between mb-3">
        <h4 className="font-semibold text-foreground">{title}</h4>
        <span
          className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${badge.classes}`}
        >
          {badge.text}
        </span>
      </div>
      <p className="text-sm text-muted leading-relaxed">{body}</p>
    </div>
  );
}

function VerifyRow({
  claim,
  verify,
}: {
  claim: string;
  verify: React.ReactNode;
}) {
  return (
    <div className="grid sm:grid-cols-[1fr,2fr] gap-3 sm:gap-6 p-4 rounded-lg border border-border bg-surface">
      <div className="font-semibold text-foreground">{claim}</div>
      <div className="text-sm text-muted">{verify}</div>
    </div>
  );
}
