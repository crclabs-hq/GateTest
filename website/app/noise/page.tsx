import type { Metadata } from "next";
import Link from "next/link";
import { contentMetadata, breadcrumbSchema, jsonLd } from "../lib/seo/schema";
import { readRuleNoiseRows } from "../lib/scan-telemetry-store";
import { aggregateRuleNoise } from "../lib/rule-noise";
import PageHero from "../components/site/PageHero";
import Section from "../components/site/Section";

// Every number on this page is an aggregate over the anonymized per-rule
// counts CLI and MCP machines send to /api/telemetry/scan — rule ids and
// integers, never code, paths or repositories. Nothing here is typed by hand.
// The page re-renders at most hourly; with no database it says so.

export const revalidate = 3600;

export const metadata: Metadata = contentMetadata({
  title: "Rule noise — which rules teams silence",
  description:
    "Per rule, how often GateTest's checks fire across real scans and how often teams silence them. The false-positive proxy, published rule by rule.",
  path: "/noise",
});

const pct = (n: number) => `${Math.round(n * 100)}%`;
const label = "text-xs font-mono uppercase tracking-[0.13em] mb-4";

export default async function NoisePage() {
  const read = await readRuleNoiseRows({ days: 90 });
  const agg = read.ok ? aggregateRuleNoise(read.rows) : null;
  const ranked = agg ? agg.rules.filter((r) => !r.thin) : [];
  const thin = agg ? agg.rules.filter((r) => r.thin) : [];

  return (
    <main>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLd(breadcrumbSchema([{ name: "GateTest", path: "/" }, { name: "Rule noise" }])),
        }}
      />

      <PageHero
        eyebrow="Measured"
        title="Which rules teams silence"
        lede={
          <>
            Every scan that opts into telemetry sends the rule ids that fired and the ones the team had
            silenced in <code className="font-mono text-foreground text-[0.92em]">.gatetestignore</code> —
            integers per rule id, never code, paths or repository names. A silenced rule is a rule someone
            judged not worth acting on in their codebase. That is the closest thing to a false-positive rate
            a scanner can publish without reading customers&rsquo; code, so it is published, rule by rule,
            worst first.
          </>
        }
        actions={
          <Link href="/precision" className="btn-secondary inline-flex items-center justify-center px-6 py-3 text-sm">
            Precision benchmark &rarr;
          </Link>
        }
      />

      <Section>
        {!read.ok ? (
          <section className="card p-6 text-foreground-secondary max-w-[62ch]">
            <h2 className={`${label} text-warning`}>Not available</h2>
            <p>
              The leaderboard reads live telemetry and the store is not reachable from this deployment
              ({read.reason}). Nothing is shown rather than a stale or invented table.
            </p>
          </section>
        ) : agg && agg.scans === 0 ? (
          <section className="card p-6 text-foreground-secondary max-w-[62ch]">
            <h2 className={`${label} text-warning`}>No data yet</h2>
            <p>
              No scan in the last {read.windowDays} days carried per-rule counts. The table fills as
              CLI and MCP scans on engine v1.61+ report in; a rule needs {agg.minScans} scans before it is ranked.
            </p>
          </section>
        ) : agg ? (
          <>
            <section>
              <h2 className={`${label} text-accent`}>
                Silenced rate — last {read.windowDays} days, {agg.scans} scans
              </h2>
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full min-w-[720px] text-sm">
                  <thead>
                    <tr className="border-b border-border bg-surface-light text-left text-muted">
                      <th className="px-4 py-3 font-medium">Rule</th>
                      <th className="px-4 py-3 font-medium text-right">Scans</th>
                      <th className="px-4 py-3 font-medium text-right">Fired</th>
                      <th className="px-4 py-3 font-medium text-right">Silenced</th>
                      <th className="px-4 py-3 font-medium text-right">Silenced rate</th>
                      <th className="px-4 py-3 font-medium text-right">Scans that silenced it</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ranked.map((r) => (
                      <tr key={r.id} className="border-b border-border last:border-0">
                        <td className="px-4 py-3 font-mono text-foreground">{r.id}</td>
                        <td className="px-4 py-3 font-mono text-right tabular-nums text-foreground-secondary">{r.scans}</td>
                        <td className="px-4 py-3 font-mono text-right tabular-nums text-foreground-secondary">{r.fired}</td>
                        <td className="px-4 py-3 font-mono text-right tabular-nums text-foreground-secondary">{r.silenced}</td>
                        <td className={`px-4 py-3 font-mono text-right tabular-nums ${r.silencedRate > 0.2 ? "text-danger" : "text-success"}`}>
                          {pct(r.silencedRate)}
                        </td>
                        <td className="px-4 py-3 font-mono text-right tabular-nums text-foreground-secondary">{pct(r.silencedScanRate)}</td>
                      </tr>
                    ))}
                    {ranked.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-4 py-6 text-muted">
                          No rule has reached {agg.minScans} scans yet; {thin.length} rule(s) are below the line.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
            {thin.length > 0 && (
              <section className="mt-8 text-sm text-muted max-w-[66ch] leading-relaxed">
                <p>
                  {thin.length} rule(s) seen in fewer than {agg.minScans} scans are not ranked — three
                  repositories are not a population.
                </p>
              </section>
            )}
          </>
        ) : null}

        <section className="mt-12 text-sm text-muted max-w-[66ch] leading-relaxed space-y-3">
          <p>
            Above 20% the rule is on the retirement list: fixed against the corpus or withdrawn. Below
            it, the rule stays and the silencing is the team&rsquo;s call. Your own machine keeps the same
            ledger locally —{" "}
            <code className="font-mono text-foreground-secondary">gatetest --noise</code> ranks the rules in your repository —
            and opts out with <code className="font-mono text-foreground-secondary">GATETEST_NO_TELEMETRY=1</code>.{" "}
            <Link href="/precision" className="text-accent hover:underline">
              Precision on the corpus &rarr;
            </Link>
          </p>
        </section>
      </Section>
    </main>
  );
}
