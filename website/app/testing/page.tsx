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
 */

export const revalidate = 60;

const ARENA_REPO = process.env.ARENA_REPO || "crclabs-hq/gatetest-arena";

interface PullRequest {
  number: number;
  title: string;
  state: string;
  created_at: string;
  merged_at: string | null;
  html_url: string;
  user: { login: string } | null;
  body: string | null;
}

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

async function fetchArenaPRs(): Promise<PullRequest[] | { error: string }> {
  const url = `https://api.github.com/repos/${ARENA_REPO}/pulls?state=all&per_page=100&sort=created&direction=desc`;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "gatetest.ai-testing-page",
        ...(process.env.GITHUB_TOKEN
          ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
          : {}),
      },
      next: { revalidate: 60 },
    });
    if (res.status === 404) return { error: "arena-not-yet-created" };
    if (!res.ok) return { error: `github-api-${res.status}` };
    return (await res.json()) as PullRequest[];
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
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
  return { total, fixed, failed, pending, median, successRate };
}

export const metadata = {
  title: "Testing — live arena | GateTest",
  description:
    "Every 2 hours, GateTest's arena repo gets a bug injected. The ai-ci-fixer opens the PR with the fix. Every cycle is public. This page is the receipts.",
};

export default async function TestingPage() {
  const result = await fetchArenaPRs();

  if (!Array.isArray(result)) {
    return <ErrorState reason={result.error} repo={ARENA_REPO} />;
  }

  const cycles = buildCycles(result);
  const stats = aggregate(cycles);

  if (cycles.length === 0) {
    return <WarmingUpState repo={ARENA_REPO} />;
  }

  return (
    <main className="min-h-screen bg-background text-foreground px-6 py-16">
      <div className="max-w-5xl mx-auto">
        <header className="text-center mb-12">
          <span className="text-sm font-semibold text-accent uppercase tracking-wider">
            Live arena
          </span>
          <h1 className="text-4xl sm:text-5xl font-bold mt-3 mb-4 text-foreground">
            Watch the auto-fix loop, live.
          </h1>
          <p className="text-lg text-muted max-w-2xl mx-auto">
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
          </p>
        </header>

        <section className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-12">
          <StatTile label="Cycles" value={String(stats.total)} sub="last 40" />
          <StatTile
            label="Auto-fixed"
            value={`${stats.successRate}%`}
            sub={`${stats.fixed} / ${stats.total}`}
            tone="ok"
          />
          <StatTile
            label="Median fix time"
            value={stats.median !== null ? formatDuration(stats.median) : "—"}
            sub="injection → fix PR"
          />
          <StatTile
            label="Pending"
            value={String(stats.pending)}
            sub="fix in flight"
            tone="info"
          />
        </section>

        <section className="space-y-3">
          {cycles.map((cycle) => (
            <CycleRow key={cycle.bugPr.number} cycle={cycle} />
          ))}
        </section>

        <footer className="mt-16 text-center text-sm text-muted">
          <p>
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
        </footer>
      </div>
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
  tone?: "ok" | "info";
}) {
  const valueColor =
    tone === "ok"
      ? "text-emerald-600"
      : tone === "info"
        ? "text-amber-600"
        : "text-foreground";
  return (
    <div className="rounded-xl border border-border bg-background-alt p-5 text-center">
      <div className="text-xs uppercase tracking-wider text-muted font-semibold">
        {label}
      </div>
      <div className={`text-3xl font-bold mt-2 tabular-nums ${valueColor}`}>
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
    fixed: { text: "FIXED", cls: "bg-emerald-100 text-emerald-800" },
    "fix-pending": {
      text: "FIX IN FLIGHT",
      cls: "bg-amber-100 text-amber-800",
    },
    "fix-failed": { text: "FIX FAILED", cls: "bg-red-100 text-red-800" },
    "no-fix-yet": { text: "AWAITING FIX", cls: "bg-gray-100 text-gray-700" },
  };
  const badge = outcomeBadge[cycle.outcome];

  return (
    <div className="rounded-lg border border-border bg-background-alt p-4 sm:p-5">
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
        <div>
          <div className="text-xs uppercase tracking-wider text-muted font-semibold mb-1">
            Bug injected
          </div>
          <a
            href={cycle.bugPr.html_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline font-mono text-xs"
          >
            #{cycle.bugPr.number} {cycle.bugPr.title.replace(/^arena\(bug\):\s*/, "")}
          </a>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-muted font-semibold mb-1">
            Fix PR
          </div>
          {cycle.fixPr ? (
            <a
              href={cycle.fixPr.html_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline font-mono text-xs"
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
    <main className="min-h-screen bg-background text-foreground px-6 py-24">
      <div className="max-w-3xl mx-auto text-center">
        <h1 className="text-4xl font-bold mb-4 text-foreground">
          Arena is warming up
        </h1>
        <p className="text-lg text-muted mb-6">
          The arena repo{" "}
          <code className="text-accent">{repo}</code> exists, but no cycles
          have run yet. The injector cron runs every 2 hours at :17 past —
          the first cycle should appear shortly.
        </p>
        <a
          href={`https://github.com/${repo}/actions`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline"
        >
          See workflow runs on GitHub &rarr;
        </a>
      </div>
    </main>
  );
}

function ErrorState({ reason, repo }: { reason: string; repo: string }) {
  return (
    <main className="min-h-screen bg-background text-foreground px-6 py-24">
      <div className="max-w-3xl mx-auto text-center">
        <h1 className="text-4xl font-bold mb-4 text-foreground">
          Arena not reachable
        </h1>
        <p className="text-lg text-muted mb-2">
          Tried to fetch from{" "}
          <code className="text-accent">{repo}</code> but got back:{" "}
          <code className="text-red-600">{reason}</code>
        </p>
        <p className="text-sm text-muted">
          If the arena repo hasn&apos;t been created yet, see{" "}
          <code>arena-scaffold/README.md</code> in the main GateTest repo for
          setup instructions.
        </p>
      </div>
    </main>
  );
}
