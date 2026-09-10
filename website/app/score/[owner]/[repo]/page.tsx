/**
 * GateTest Score — public quality score page.
 * /score/:owner/:repo
 *
 * Shows the public GateTest score for any scanned repository.
 * Embeddable badge available at /api/score?owner=X&repo=Y&format=badge
 */
import Link from "next/link";
import { SITE_URL } from "@/app/lib/site-url";
import PageHero from "../../../components/site/PageHero";
export const dynamic = "force-dynamic";

interface ScoreData {
  owner: string;
  repo: string;
  score: number | null;
  grade: string | null;
  label: string | null;
  color: string | null;
  lastScan?: {
    tier: string;
    scannedAt: string;
    ageDays: number;
    // `scan_history` records a single issue count and does not split errors
    // from warnings. The previous `errors`/`warnings` pair came from the
    // auto-fix log (errors_FIXED, warnings_FIXED) — numbers about fixes
    // presented as numbers about the scan.
    issues: number;
  };
  badge?: string;
  readme?: string;
  message?: string;
}

async function fetchScore(owner: string, repo: string): Promise<ScoreData> {
  // SITE_URL rather than a raw env read: the resolver strips a trailing slash,
  // which a hand-typed env var usually has, and which turns this into a
  // double-slash fetch.
  const base = SITE_URL;
  try {
    const res = await fetch(`${base}/api/score?owner=${owner}&repo=${repo}`, { cache: "no-store" });
    return res.json();
  } catch {
    return { owner, repo, score: null, grade: null, label: null, color: null, message: "Could not load score" };
  }
}

function GradeRing({ score, grade, color }: { score: number; grade: string; color: string }) {
  const r = 52;
  const circumference = 2 * Math.PI * r;
  const offset = circumference - (score / 100) * circumference;

  return (
    <div className="relative flex items-center justify-center w-40 h-40">
      <svg className="w-40 h-40 -rotate-90" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r={r} fill="none" stroke="var(--border-strong)" strokeWidth="10" />
        <circle
          cx="60" cy="60" r={r} fill="none"
          stroke={color} strokeWidth="10"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 1s ease" }}
        />
      </svg>
      <div className="absolute text-center">
        <div className="font-display text-4xl font-black text-foreground">{grade}</div>
        <div className="text-lg font-bold" style={{ color }}>{score}/100</div>
      </div>
    </div>
  );
}

export default async function ScorePage({
  params,
}: {
  params: Promise<{ owner: string; repo: string }>;
}) {
  const { owner, repo } = await params;
  const data = await fetchScore(owner, repo);

  const hasScore = data.score !== null;
  const tierLabel: Record<string, string> = {
    quick: "Quick Scan ($29)",
    full: "Full Scan ($99)",
    scan_fix: "Scan + Fix ($199)",
    nuclear: "Forensic Scan ($399)",
  };

  return (
    <main>
      <PageHero
        eyebrow="Public quality score"
        align="center"
        title={
          <>
            <span className="text-muted">{owner}</span>
            <span className="text-muted/50 mx-2">/</span>
            <span>{repo}</span>
          </>
        }
        lede="GateTest quality score · computed from the latest scan on record"
      />

      <div className="max-w-5xl mx-auto px-6 py-16">
        {hasScore ? (
          <>
            {/* Score card */}
            <div className="card flex flex-col sm:flex-row items-center gap-10 p-8 mb-8">
              <GradeRing
                score={data.score!}
                grade={data.grade!}
                color={data.color!}
              />
              <div className="flex-1 text-center sm:text-left">
                <div className="font-display text-2xl font-bold text-foreground mb-1">{data.label}</div>
                <div className="text-muted mb-4">
                  {data.lastScan?.issues} {data.lastScan?.issues === 1 ? "issue" : "issues"} ·{" "}
                  {data.lastScan?.tier ? tierLabel[data.lastScan.tier] || data.lastScan.tier : ""}
                </div>
                <div className="flex flex-wrap gap-3 justify-center sm:justify-start items-center">
                  <a
                    href={`${SITE_URL}?repo=${encodeURIComponent(`${owner}/${repo}`)}`}
                    className="btn-cta px-4 py-2 text-sm"
                  >
                    Improve this score →
                  </a>
                  {data.lastScan && (
                    <span className="px-2 py-2 text-muted text-sm">
                      Last scanned {data.lastScan.ageDays === 0 ? "today" : `${data.lastScan.ageDays}d ago`}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Badge + README embed */}
            <div className="grid sm:grid-cols-2 gap-4 mb-8">
              <div className="card p-5">
                <div className="text-xs text-muted font-semibold uppercase tracking-wider mb-3">Badge preview</div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={data.badge}
                  alt="GateTest score badge"
                  width={120}
                  height={20}
                  className="mb-3"
                />
              </div>
              <div className="card p-5 min-w-0">
                <div className="text-xs text-muted font-semibold uppercase tracking-wider mb-3">Add to README</div>
                <pre className="text-xs text-panel-foreground font-mono bg-panel border border-panel-border p-3 rounded-lg overflow-x-auto whitespace-pre-wrap break-all">
                  {data.readme}
                </pre>
              </div>
            </div>

            {/* Score breakdown */}
            <div className="card p-6">
              <div className="text-sm font-semibold text-muted uppercase tracking-wider mb-4">How the score is calculated</div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
                {[
                  { label: "Start", value: "100", note: "base score" },
                  { label: "Issues", value: `−${Math.min(50, (data.lastScan?.issues || 0) * 5)}`, note: `−5 each (max −50)` },
                  { label: "Modules passed", value: "up to +10", note: "pass rate × 10" },
                  { label: "Fix tier bonus", value: ["scan_fix", "nuclear"].includes(data.lastScan?.tier || "") ? "+5" : "+0", note: "Scan + Fix / Forensic" },
                  { label: "Staleness", value: (data.lastScan?.ageDays || 0) > 7 ? `−${Math.floor(((data.lastScan?.ageDays || 0) - 7) / 7) * 5}` : "−0", note: `−5/week after 7d` },
                  { label: "Final score", value: String(data.score), note: data.label || "" },
                ].map((r) => (
                  <div key={r.label} className="text-center p-3 rounded-lg bg-surface-light border border-border">
                    <div className="text-lg font-bold text-foreground tabular-nums">{r.value}</div>
                    <div className="text-foreground-secondary text-xs">{r.label}</div>
                    <div className="text-muted text-xs mt-0.5">{r.note}</div>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          /* No scan yet */
          <div className="card text-center py-16 px-6">
            <div className="font-display text-6xl font-black text-muted/30 mb-4" aria-hidden="true">?</div>
            <h2 className="font-display text-2xl font-bold text-foreground mb-2">No scans found</h2>
            <p className="text-foreground-secondary mb-8">
              {owner}/{repo} hasn&apos;t been scanned yet. Run a GateTest scan to get a public score.
            </p>
            <a
              href={`${SITE_URL}#pricing`}
              className="btn-cta inline-block px-8 py-3"
            >
              Scan this repo →
            </a>
          </div>
        )}
        <p className="mt-8 text-center text-sm text-muted">
          <Link href="/" className="hover:text-foreground transition-colors">&larr; Back to GateTest</Link>
        </p>
      </div>
    </main>
  );
}
