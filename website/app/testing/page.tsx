/**
 * /testing — the live proof page.
 *
 * Reads the `gatetest-arena` repo's PRs via the GitHub public REST API,
 * matches injected-bug PRs with their corresponding ai-ci-fixer PRs, and
 * renders the cycle history as a timeline.
 *
 * Server-rendered with a 60-second revalidate so the page stays fresh
 * without hammering the GitHub API. If the arena repo doesn't exist yet
 * (pre-bootstrap), or no cycles have run, the page shows an honest
 * "warming up" state — never fake data.
 *
 * This is the HN-launch proof asset. Every claim on the landing page
 * about "AI opens the fix PR while you sleep" is backed by this page.
 *
 * The fetch + classify logic lives in ./arena-fetch.ts (no JSX there), so it
 * can be unit-tested directly. See that file's header for the 2026-09-25
 * anonymous-fallback fix.
 */

import PageHero from "../components/site/PageHero";
import Section from "../components/site/Section";
import {
  ARENA_REPO,
  fetchArenaPRs,
  getLastGoodSnapshot,
  describeArenaFailure,
  type PullRequest,
} from "./arena-fetch";
import { selectProofTone } from "../lib/testing-proof-tone";

export const revalidate = 60;

interface Cycle {
  patternId: string | null;
  bugPr: PullRequest;
  fixPr: PullRequest | null;
  injectedAt: string;
  fixOpenedAt: string | null;
  mergedAt: string | null;
  timeToFixMs: number | null;
  outcome: "fixed" | "fix-pending" | "fix-failed" | "no-fix-yet";
}

// Extract pattern id from the injector's PR body marker.
function extractPatternId(body: string | null): string | null {
  if (!body) return null;
  const match = body.match(/arena-cycle-marker pattern=([a-z0-9-]+)/);
  return match ? match[1] : null;
}

function buildCycles(prs: PullRequest[]): Cycle[] {
  // Bug PRs are titled `arena(bug): <id>`; fix PRs come from ai-ci-fixer
  // and are titled `fix(ai-ci-fixer): ...` or `arena(fix): ...`.
  const bugPrs = prs.filter((p) => /^arena\(bug\):/.test(p.title));
  const fixPrs = prs.filter((p) =>
    /^(fix\(ai-ci-fixer\)|ai-ci-fixer:|arena\(fix\))/.test(p.title),
  );

  return bugPrs.slice(0, 40).map((bug) => {
    const patternId = extractPatternId(bug.body);
    // Find the closest-in-time fix PR opened AFTER this bug PR.
    const bugTime = new Date(bug.created_at).getTime();
    const candidate = fixPrs
      .filter((f) => new Date(f.created_at).getTime() > bugTime)
      .sort(
        (a, b) =>
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      )[0];

    const fixOpenedAt = candidate?.created_at ?? null;
    const mergedAt = candidate?.merged_at ?? null;
    const timeToFixMs =
      candidate && bugTime
        ? new Date(candidate.created_at).getTime() - bugTime
        : null;

    let outcome: Cycle["outcome"];
    if (mergedAt) outcome = "fixed";
    else if (candidate && candidate.state === "open") outcome = "fix-pending";
    else if (candidate && candidate.state === "closed") outcome = "fix-failed";
    else outcome = "no-fix-yet";

    return {
      patternId,
      bugPr: bug,
      fixPr: candidate ?? null,
      injectedAt: bug.created_at,
      fixOpenedAt,
      mergedAt,
      timeToFixMs,
      outcome,
    };
  });
}

function formatDuration(ms: number | null): string {
  if (ms === null || Number.isNaN(ms)) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 3_600_000)} hr`;
}

function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 0) return "just now";
  if (diffMs < 60_000) return "just now";
  if (diffMs < 3_600_000) return `${Math.round(diffMs / 60_000)} min ago`;
  if (diffMs < 86_400_000) return `${Math.round(diffMs / 3_600_000)} hr ago`;
  return `${Math.round(diffMs / 86_400_000)} days ago`;
}

function aggregate(cycles: Cycle[]) {
  const total = cycles.length;
  const fixed = cycles.filter((c) => c.outcome === "fixed").length;
  const failed = cycles.filter((c) => c.outcome === "fix-failed").length;
  const pending = cycles.filter(
    (c) => c.outcome === "fix-pending" || c.outcome === "no-fix-yet",
  ).length;
  const fixTimes = cycles
    .filter((c) => c.outcome === "fixed" && c.timeToFixMs !== null)
    .map((c) => c.timeToFixMs as number)
    .sort((a, b) => a - b);
  const median =
    fixTimes.length > 0
      ? fixTimes[Math.floor(fixTimes.length / 2)]
      : null;
  const successRate = total > 0 ? Math.round((fixed / total) * 100) : 0;
  // The most recently merged fix, if any — GT-01's tone decision needs this,
  // not just the historical percentage, so a page can't stay green forever
  // on a single old win.
  const lastFixedAt = cycles
    .filter((c) => c.outcome === "fixed" && c.mergedAt)
    .map((c) => c.mergedAt as string)
    .reduce<string | null>(
      (latest, iso) =>
        latest === null || new Date(iso).getTime() > new Date(latest).getTime() ? iso : latest,
      null,
    );
  return { total, fixed, failed, pending, median, successRate, lastFixedAt };
}

// Known cause for zero merged fixes, when the data itself makes it obvious —
// optional per GT-01: the page stays honest even without it.
function inferStalledReason(stats: { fixed: number; pending: number; failed: number }): string | null {
  if (stats.fixed > 0) return null;
  if (stats.pending > 0) return "fixes are in flight but none has merged yet";
  if (stats.failed > 0) return "the fixer's attempts did not merge";
  return null;
}

export const metadata = {
  title: "Testing — live arena | GateTest",
  description:
    "Every 2 hours, GateTest's arena repo gets a bug injected. The ai-ci-fixer opens the PR with the fix. Every cycle is public. This page is the receipts.",
};

export default async function TestingPage() {
  const result = await fetchArenaPRs();

  if (result.kind === "ok") {
    return renderArena(result.prs, null);
  }

  // A transient live failure (rate limit, network blip, GitHub 5xx) still
  // has an honest answer if we've read this repo successfully before: the
  // last snapshot, labeled as such, beats an error page.
  const cached = getLastGoodSnapshot();
  if (cached) {
    return renderArena(cached.prs, describeArenaFailure(result));
  }

  if (result.kind === "not-found") {
    return <ErrorState reason="arena-not-yet-created" repo={ARENA_REPO} honestlyMissing />;
  }
  if (result.kind === "rate-limited") {
    return <RateLimitedState repo={ARENA_REPO} resetAt={result.resetAt} />;
  }
  return <ErrorState reason={result.reason} repo={ARENA_REPO} honestlyMissing={false} />;
}

function renderArena(prs: PullRequest[], staleNotice: string | null) {
  const cycles = buildCycles(prs);
  const stats = aggregate(cycles);

  if (cycles.length === 0) {
    return <WarmingUpState repo={ARENA_REPO} />;
  }

  // GT-01: a green "AUTO-FIXED 0%" is a lie by colour even when the number is
  // honest. This decides, from the numbers alone, whether the page may use
  // its success tone — see website/app/lib/testing-proof-tone.ts.
  const proofTone = selectProofTone({
    fixed: stats.fixed,
    total: stats.total,
    lastFixedAt: stats.lastFixedAt,
    reason: inferStalledReason(stats),
  });
  const isWarning = proofTone.tone === "warning";
  // Zero merged fixes is a harder failure than "it used to work" — reach for
  // the danger token there, the amber warning token for stale-but-proven.
  const severeTone: "warn" | "bad" = stats.fixed === 0 ? "bad" : "warn";
  const autoFixedTone: "ok" | "warn" | "bad" = isWarning ? severeTone : "ok";
  const medianTone: "warn" | "bad" | undefined = isWarning ? severeTone : undefined;

  return (
    <main>
      <PageHero
        eyebrow="Live arena"
        align="center"
        title="Watch the auto-fix loop, live."
        lede={
          <>
            Every 2 hours, a bug is injected into{" "}
            <a
              href={`https://github.com/${ARENA_REPO}`}
              className="text-accent hover:underline font-mono"
              target="_blank"
              rel="noopener noreferrer"
            >
              {ARENA_REPO}
            </a>
            . The ai-ci-fixer opens the PR with the fix. Nothing here is
            curated — this is the live data feed.
          </>
        }
      />

      {staleNotice && <StaleSnapshotNotice notice={staleNotice} />}
      {isWarning && <ProofToneNotice tone={severeTone} headline={proofTone.headline} />}

      <Section>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-12">
          <StatTile label="Cycles" value={String(stats.total)} sub="last 40" />
          <StatTile
            label="Auto-fixed"
            value={`${stats.successRate}%`}
            sub={`${stats.fixed} / ${stats.total}`}
            tone={autoFixedTone}
          />
          <StatTile
            label="Median fix time"
            value={stats.median !== null ? formatDuration(stats.median) : "—"}
            sub={stats.median !== null ? "injection → fix PR" : "no fix has landed yet"}
            tone={medianTone}
          />
          <StatTile
            label="Pending"
            value={String(stats.pending)}
            sub="fix in flight"
            tone="info"
          />
        </div>

        <div className="space-y-3">
          {cycles.map((cycle) => (
            <CycleRow key={cycle.bugPr.number} cycle={cycle} />
          ))}
        </div>

        <p className="mt-16 text-center text-sm text-muted">
          Data sourced live from the GitHub REST API. Updated every 60s.{" "}
          <a
            href={`https://github.com/${ARENA_REPO}/pulls?q=is%3Apr`}
            className="text-accent hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            See all PRs on GitHub &rarr;
          </a>
        </p>
      </Section>
    </main>
  );
}

function StatTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "ok" | "info" | "warn" | "bad";
}) {
  const valueColor =
    tone === "ok"
      ? "text-success"
      : tone === "info" || tone === "warn"
        ? "text-warning"
        : tone === "bad"
          ? "text-danger"
          : "text-foreground";
  return (
    <div className="card p-5 text-center">
      <div className="text-xs uppercase tracking-wider text-muted font-semibold">
        {label}
      </div>
      <div className={`font-display text-3xl font-bold mt-2 tabular-nums ${valueColor}`}>
        {value}
      </div>
      <div className="text-xs text-muted mt-1">{sub}</div>
    </div>
  );
}

function CycleRow({ cycle }: { cycle: Cycle }) {
  const outcomeBadge: Record<
    Cycle["outcome"],
    { text: string; cls: string }
  > = {
    fixed: { text: "FIXED", cls: "bg-success/10 text-success" },
    "fix-pending": {
      text: "FIX IN FLIGHT",
      cls: "bg-warning/10 text-warning",
    },
    "fix-failed": { text: "FIX FAILED", cls: "bg-danger/10 text-danger" },
    "no-fix-yet": { text: "AWAITING FIX", cls: "bg-surface-light border border-border text-muted" },
  };
  const badge = outcomeBadge[cycle.outcome];

  return (
    <div className="card p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <span
          className={`text-[10px] uppercase tracking-wider font-bold px-2 py-1 rounded-full ${badge.cls}`}
        >
          {badge.text}
        </span>
        {cycle.patternId && (
          <code className="text-xs font-mono text-accent bg-accent/5 px-2 py-1 rounded">
            {cycle.patternId}
          </code>
        )}
        <span className="text-xs text-muted ml-auto">
          {formatRelative(cycle.injectedAt)}
        </span>
      </div>

      <div className="grid sm:grid-cols-3 gap-3 text-sm">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wider text-muted font-semibold mb-1">
            Bug injected
          </div>
          <a
            href={cycle.bugPr.html_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline font-mono text-xs break-words"
          >
            #{cycle.bugPr.number} {cycle.bugPr.title.replace(/^arena\(bug\):\s*/, "")}
          </a>
        </div>
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wider text-muted font-semibold mb-1">
            Fix PR
          </div>
          {cycle.fixPr ? (
            <a
              href={cycle.fixPr.html_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline font-mono text-xs break-words"
            >
              #{cycle.fixPr.number} {cycle.fixPr.title.slice(0, 50)}
              {cycle.fixPr.title.length > 50 ? "…" : ""}
            </a>
          ) : (
            <span className="text-muted text-xs">awaiting fixer</span>
          )}
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-muted font-semibold mb-1">
            Time to fix
          </div>
          <span className="font-mono tabular-nums text-foreground">
            {formatDuration(cycle.timeToFixMs)}
          </span>
        </div>
      </div>
    </div>
  );
}

function WarmingUpState({ repo }: { repo: string }) {
  return (
    <main>
      <PageHero
        eyebrow="Live arena"
        align="center"
        title="Arena is warming up"
        lede={
          <>
            The arena repo{" "}
            <code className="text-accent font-mono">{repo}</code> exists, but no cycles
            have run yet. The injector cron runs every 2 hours at :17 past —
            the first cycle should appear shortly.
          </>
        }
        actions={
          <a
            href={`https://github.com/${repo}/actions`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary inline-flex items-center justify-center px-6 py-3 text-sm"
          >
            See workflow runs on GitHub &rarr;
          </a>
        }
      />
    </main>
  );
}

// `honestlyMissing` gates the "hasn't been created yet" suggestion: it is
// only true for a genuine 404 (no credential could see the repo either).
// A refused/stale credential (401/403 on both the bearer and the anonymous
// retry) or a transient GitHub error must never carry that suggestion —
// the repo may well exist; GateTest's own read was what failed.
function ErrorState({
  reason,
  repo,
  honestlyMissing,
}: {
  reason: string;
  repo: string;
  honestlyMissing: boolean;
}) {
  return (
    <main>
      <PageHero
        eyebrow="Live arena"
        align="center"
        title="Arena not reachable"
        lede={
          <>
            Tried to fetch from{" "}
            <code className="text-accent font-mono">{repo}</code> but got back:{" "}
            <code className="text-danger font-mono">{reason}</code>
          </>
        }
      />
      <Section narrow>
        <p className="text-sm text-muted text-center">
          {honestlyMissing ? (
            <>
              If the arena repo hasn&apos;t been created yet, see{" "}
              <code className="font-mono">arena-scaffold/README.md</code> in the main GateTest repo
              for setup instructions.
            </>
          ) : (
            <>
              This means GitHub refused the read itself — it does not mean the repo is missing.
              Check{" "}
              <code className="font-mono">{repo}</code> directly on GitHub to confirm it still
              exists.
            </>
          )}
        </p>
      </Section>
    </main>
  );
}

function RateLimitedState({ repo, resetAt }: { repo: string; resetAt: number | null }) {
  const retryText = resetAt
    ? `Retry after ${new Date(resetAt).toISOString()}.`
    : "Retry shortly.";
  return (
    <main>
      <PageHero
        eyebrow="Live arena"
        align="center"
        title="Rate limited — retry shortly"
        lede={
          <>
            Reading{" "}
            <code className="text-accent font-mono">{repo}</code> anonymously hit GitHub&apos;s
            public API rate limit (60 unauthenticated requests/hour, per IP). {retryText}
          </>
        }
      />
    </main>
  );
}

function StaleSnapshotNotice({ notice }: { notice: string }) {
  return (
    <Section narrow>
      <p className="text-sm text-warning text-center">
        Showing the last successful read — {notice}. This refreshes automatically once the live
        read succeeds again.
      </p>
    </Section>
  );
}

// GT-01: the honest sentence that goes with a warning-tone stat row —
// "cycles ran, fixes did not land", and why if known. Rendered whenever
// selectProofTone() (website/app/lib/testing-proof-tone.ts) says the page
// may not use its success tone.
function ProofToneNotice({ tone, headline }: { tone: "warn" | "bad"; headline: string }) {
  const cls = tone === "bad" ? "text-danger" : "text-warning";
  return (
    <Section narrow>
      <p className={`text-sm text-center font-medium ${cls}`}>{headline}</p>
    </Section>
  );
}
