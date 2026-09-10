/**
 * /fixes — Public "Fixed by GateTest" registry.
 *
 * Every PR that GateTest ships is logged here as social proof.
 * Server component — fetches data from /api/fixes at render time.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import PageHero from '../components/site/PageHero';
import Section from '../components/site/Section';
import StatTiles from '../components/site/StatTiles';

export const metadata: Metadata = {
  title: 'Fixed by GateTest — Public Fix Registry',
  description: 'Every bug, vulnerability, and code issue fixed by GateTest — public proof from real repos.',
};

// Always dynamically rendered — live data, no static prerender
export const dynamic = 'force-dynamic';
export const revalidate = 60;

interface Fix {
  id: string;
  created_at: string;
  repo_name: string;
  pr_url: string | null;
  tier: string;
  errors_fixed: number;
  warnings_fixed: number;
  modules_fired: string[];
  message: string | null;
}

interface Stats {
  total_fixes: number;
  total_errors_fixed: number;
  total_warnings_fixed: number;
  unique_repos: number;
}

const EMPTY_PAGE = { fixes: [] as Fix[], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 0 } };
const EMPTY_STATS: Stats = { total_fixes: 0, total_errors_fixed: 0, total_warnings_fixed: 0, unique_repos: 0 };

// The registry is read from our own API. If that call cannot complete (the
// API is down, or the public base URL points somewhere unreachable from this
// process) the page renders empty rather than 500ing — a public page must
// never die on its own dependency (Forbidden #15; found by the 2026-09-10
// render pass, where every width returned 500).
async function fetchFixes(page = 1): Promise<{ fixes: Fix[]; pagination: Record<string, number> }> {
  const base = process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000';
  try {
    const res = await fetch(`${base}/api/fixes?page=${page}`, { next: { revalidate: 60 } });
    if (!res.ok) return EMPTY_PAGE;
    const data = await res.json();
    return data.ok ? data : EMPTY_PAGE;
  } catch {
    return EMPTY_PAGE;
  }
}

async function fetchStats(): Promise<Stats> {
  const base = process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000';
  try {
    const res = await fetch(`${base}/api/fixes?stats=1`, { next: { revalidate: 60 } });
    if (!res.ok) return EMPTY_STATS;
    const data = await res.json();
    return data.ok ? data.stats : EMPTY_STATS;
  } catch {
    return EMPTY_STATS;
  }
}

const TIER_LABELS: Record<string, { label: string; color: string }> = {
  quick: { label: 'Quick', color: 'text-muted bg-surface-light border border-border' },
  full: { label: 'Full', color: 'text-blue-700 bg-blue-500/10' },
  'scan_fix': { label: 'Scan+Fix', color: 'text-violet-700 bg-violet-500/10' },
  nuclear: { label: 'Forensic', color: 'text-danger bg-danger/10' },
};

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return iso.slice(0, 10);
  }
}

function repoShortName(repoName: string) {
  const parts = repoName.split('/');
  return parts[parts.length - 1] || repoName;
}

export default async function FixesPage() {
  const [{ fixes, pagination }, stats] = await Promise.all([fetchFixes(), fetchStats()]);

  return (
    <main>
      <PageHero
        eyebrow="Public registry"
        title="Fixed by GateTest"
        lede="Real bugs, vulnerabilities, and code issues fixed by GateTest across real repos. Every entry is a delivered PR."
        align="center"
      />

      <Section narrow>
        {/* Stats banner */}
        {stats.total_fixes > 0 && (
          <div className="mb-12">
            <StatTiles
              items={[
                { label: 'PRs shipped', value: stats.total_fixes.toLocaleString() },
                { label: 'Errors fixed', value: stats.total_errors_fixed.toLocaleString() },
                { label: 'Warnings fixed', value: stats.total_warnings_fixed.toLocaleString() },
                { label: 'Unique repos', value: stats.unique_repos.toLocaleString() },
              ]}
            />
          </div>
        )}

        {/* Fix list */}
        {fixes.length === 0 ? (
          <div className="card text-center py-20 px-6 text-muted">
            <p className="text-foreground font-semibold">No fixes recorded yet.</p>
            <p className="text-sm mt-2">Every GateTest-delivered PR will appear here.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {fixes.map((fix) => {
              const tier = TIER_LABELS[fix.tier] ?? { label: fix.tier, color: 'text-muted bg-surface-light border border-border' };
              const modules = (fix.modules_fired ?? []).slice(0, 4);
              const moreModules = (fix.modules_fired ?? []).length - modules.length;

              return (
                <div key={fix.id} className="card p-5">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="text-foreground-secondary font-mono text-sm truncate max-w-[180px]" title={fix.repo_name}>
                        {repoShortName(fix.repo_name)}
                      </span>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${tier.color}`}>
                        {tier.label}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted shrink-0">
                      <span>{formatDate(fix.created_at)}</span>
                      {/* PR links are withheld on the public registry — they
                          identify the customer's repo (Craig 2026-06-12). */}
                      {fix.pr_url && (
                        <a
                          href={fix.pr_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-accent hover:text-accent-hover transition-colors"
                          aria-label={`View PR for ${fix.repo_name}`}
                        >
                          View PR →
                        </a>
                      )}
                    </div>
                  </div>

                  {fix.message && (
                    <p className="text-sm text-foreground-secondary mt-2 line-clamp-2">{fix.message}</p>
                  )}

                  <div className="flex items-center gap-4 mt-3 text-xs text-muted flex-wrap">
                    {fix.errors_fixed > 0 && (
                      <span className="text-danger">🔴 {fix.errors_fixed} error{fix.errors_fixed !== 1 ? 's' : ''} fixed</span>
                    )}
                    {fix.warnings_fixed > 0 && (
                      <span className="text-warning">🟡 {fix.warnings_fixed} warning{fix.warnings_fixed !== 1 ? 's' : ''} fixed</span>
                    )}
                    {modules.length > 0 && (
                      <div className="flex items-center gap-1 flex-wrap">
                        {modules.map((m) => (
                          <span key={m} className="px-1.5 py-0.5 rounded bg-surface-light border border-border text-foreground-secondary font-mono">
                            {m}
                          </span>
                        ))}
                        {moreModules > 0 && (
                          <span className="text-muted">+{moreModules} more</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Pagination */}
        {pagination.totalPages > 1 && (
          <nav aria-label="Pagination" className="flex justify-center items-center gap-4 mt-8">
            {pagination.page > 1 && (
              <Link
                href={`/fixes?page=${pagination.page - 1}`}
                className="btn-secondary px-4 py-2 text-sm"
              >
                ← Previous
              </Link>
            )}
            <span className="px-4 py-2 text-sm text-muted">
              Page {pagination.page} of {pagination.totalPages}
            </span>
            {pagination.page < pagination.totalPages && (
              <Link
                href={`/fixes?page=${pagination.page + 1}`}
                className="btn-secondary px-4 py-2 text-sm"
              >
                Next →
              </Link>
            )}
          </nav>
        )}

        {/* CTA */}
        <div className="mt-16 rounded-2xl border border-accent/20 bg-accent/5 px-6 py-8 text-center">
          <h2 className="font-display text-xl sm:text-2xl font-bold tracking-tight text-foreground mb-2">Want your repo in this list?</h2>
          <p className="text-foreground-secondary text-sm mb-6">
            GateTest scans your code. On Scan + Fix ($199) and Forensic Scan ($399) it fixes the issues and opens a PR. You merge. Done.
          </p>
          <Link href="/" className="btn-cta inline-flex items-center gap-2 px-6 py-3">
            Scan your repo →
          </Link>
        </div>
      </Section>
    </main>
  );
}
