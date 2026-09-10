import type { Metadata } from "next";
import Link from "next/link";
import { contentMetadata, breadcrumbSchema, jsonLd } from "../lib/seo/schema";
import precision from "../data/precision.json";
import siteStats from "../data/site-stats.json";
import PageHero from "../components/site/PageHero";
import Section from "../components/site/Section";

// Every number on this page comes from website/app/data/precision.json,
// which scripts/real-world-precision.js writes from its own measurement —
// the same contract as site-stats.json. Nothing here is typed by hand, and
// tests/precision-page-sync.test.js fails the build if the JSON and the
// corpus manifest ever disagree.

export const metadata: Metadata = contentMetadata({
  title: "Precision benchmark — GateTest measured on repositories it does not control",
  description:
    "Blocking findings from a full GateTest scan of pinned commits of express, Django, Rails, zod, hono and more, with the ceiling each is held to and the recall floor on OWASP NodeGoat. Regenerated from a real run; no number is typed by hand.",
  path: "/precision",
  keywords: [
    "static analysis false positive rate",
    "code scanner precision benchmark",
    "sast false positives",
    "gatetest precision",
  ],
});

type Row = {
  name: string;
  url: string;
  sha: string;
  why?: string;
  blocking: number;
  ceiling?: number;
  floor?: number;
};

type Calibration = {
  threshold: number;
  bands: Array<{ confidence: number; precision: number; recall: number }>;
  sweep: Array<{ threshold: number; precisionBlocking: number; recallBlocking: number; shipped: boolean }>;
  gap: { below: number | null; above: number | null };
  softened: { precisionTotal: number; precisionBlocking: number; precisionSoftened: number; recallTotal: number; recallBlocking: number; recallLost: number };
  recallRepos: Array<{ name: string; blocking: number; floor: number | null; held: boolean | null }>;
};

const rows = precision.repos as Row[];
// Written by the same corpus run as the table; null when a report could not
// be read, in which case the section says so rather than disappearing.
const calibration = (precision as { calibration?: Calibration | null }).calibration ?? null;
const calibrationNote = (precision as { calibrationNote?: string }).calibrationNote ?? "";
const precisionRows = rows.filter((r) => typeof r.ceiling === "number");
const recallRows = rows.filter((r) => typeof r.floor === "number");
const commitUrl = (r: Row) => `${r.url.replace(/\.git$/, "")}/commit/${r.sha}`;
const generated = new Date(precision.generatedAt);

const label = "text-xs font-mono uppercase tracking-[0.13em] text-accent mb-4";
const headRow = "border-b border-border bg-surface-light text-left text-muted";
const bodyRow = "border-b border-border last:border-0";
const numCell = "px-4 py-3 font-mono text-right tabular-nums";

export default function PrecisionPage() {
  return (
    <main>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLd(breadcrumbSchema([{ name: "GateTest", path: "/" }, { name: "Precision" }])),
        }}
      />

      <PageHero
        eyebrow="Measured"
        title="Precision, on code we do not control"
        lede={
          <>
            A scanner tuned against its own repository looks perfect on its own repository. The only
            honest test is code its authors did not write and cannot quietly adjust. Each repository
            below is cloned fresh at a pinned commit and scanned with{" "}
            <code className="font-mono text-foreground text-[0.92em]">--suite full</code> — exactly what a
            paying Full Scan runs. The number is blocking findings; the ceiling is what CI holds the engine
            to, and it only ever moves down.
          </>
        }
        actions={
          <Link href="/modules" className="btn-secondary inline-flex items-center justify-center px-6 py-3 text-sm">
            {siteStats.modules.total} modules &rarr;
          </Link>
        }
      />

      <Section>
        <section>
          <h2 className={label}>Precision — clean code must pass</h2>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className={headRow}>
                  <th className="px-4 py-3 font-medium">Repository</th>
                  <th className="px-4 py-3 font-medium">Commit</th>
                  <th className="px-4 py-3 font-medium text-right">Blocking</th>
                  <th className="px-4 py-3 font-medium text-right">Ceiling</th>
                  <th className="px-4 py-3 font-medium">Why it is in the corpus</th>
                </tr>
              </thead>
              <tbody>
                {precisionRows.map((r) => (
                  <tr key={r.name} className={bodyRow}>
                    <td className="px-4 py-3 font-medium text-foreground">{r.name}</td>
                    <td className="px-4 py-3 font-mono text-muted">
                      <a href={commitUrl(r)} className="hover:text-accent transition-colors" rel="noopener">
                        {r.sha.slice(0, 8)}
                      </a>
                    </td>
                    <td className={`${numCell} ${r.blocking === 0 ? "text-success" : "text-foreground"}`}>{r.blocking}</td>
                    <td className={`${numCell} text-muted`}>{r.ceiling}</td>
                    <td className="px-4 py-3 text-foreground-secondary max-w-[38ch]">{r.why}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-12">
          <h2 className={label}>Recall — a vulnerable app must keep failing</h2>
          <p className="text-foreground-secondary max-w-[62ch] leading-relaxed mb-4">
            Precision alone is satisfied by a scanner that reports nothing. So a deliberately vulnerable
            application is held to a <em>floor</em>: if it ever stops failing, the gate goes red.
          </p>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className={headRow}>
                  <th className="px-4 py-3 font-medium">Repository</th>
                  <th className="px-4 py-3 font-medium">Commit</th>
                  <th className="px-4 py-3 font-medium text-right">Blocking</th>
                  <th className="px-4 py-3 font-medium text-right">Floor</th>
                </tr>
              </thead>
              <tbody>
                {recallRows.map((r) => (
                  <tr key={r.name} className={bodyRow}>
                    <td className="px-4 py-3 font-medium text-foreground">{r.name}</td>
                    <td className="px-4 py-3 font-mono text-muted">
                      <a href={commitUrl(r)} className="hover:text-accent transition-colors" rel="noopener">
                        {r.sha.slice(0, 8)}
                      </a>
                    </td>
                    <td className={`${numCell} text-danger`}>{r.blocking}</td>
                    <td className={`${numCell} text-muted`}>{r.floor}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-12">
          <h2 className={label}>Confidence — the block threshold, measured on the same run</h2>
          <p className="text-foreground-secondary max-w-[62ch] leading-relaxed mb-4">
            Every error finding carries a confidence score: 1.0 unless a signal fires (a test file, a
            fixture, a comment, a string literal), and only findings at or above the block threshold
            fail the gate. The threshold used to be a number someone liked. Now each corpus run sweeps
            the alternatives: how much would block on the clean repositories, and how much the
            vulnerable one would still catch.
          </p>
          {calibration ? (
            <>
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full min-w-[520px] text-sm">
                  <thead>
                    <tr className={headRow}>
                      <th className="px-4 py-3 font-medium">Block at confidence ≥</th>
                      <th className="px-4 py-3 font-medium text-right">Blocking on clean repos</th>
                      <th className="px-4 py-3 font-medium text-right">Still caught on NodeGoat</th>
                    </tr>
                  </thead>
                  <tbody>
                    {calibration.sweep.map((s) => (
                      <tr key={s.threshold} className={`${bodyRow} ${s.shipped ? "bg-accent/10" : ""}`}>
                        <td className="px-4 py-3 font-mono tabular-nums text-foreground">
                          {s.threshold.toFixed(2)}
                          {s.shipped && <span className="ml-2 text-[11px] uppercase tracking-[0.08em] text-accent">shipped</span>}
                        </td>
                        <td className={`${numCell} text-foreground-secondary`}>{s.precisionBlocking}</td>
                        <td className={`${numCell} text-danger`}>{s.recallBlocking}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-4 text-sm text-muted max-w-[66ch] leading-relaxed">
                Confidence is not a continuum: this run produced only{" "}
                {calibration.bands.length} distinct values (
                {calibration.bands.map((b) => b.confidence.toFixed(2)).join(", ")}). The shipped threshold
                of {calibration.threshold} sits between {calibration.gap.below ?? "nothing"} and{" "}
                {calibration.gap.above ?? "nothing"}, so any value in that gap gives the same gate. The
                signals kept {calibration.softened.precisionSoftened} of {calibration.softened.precisionTotal}{" "}
                error findings off the clean repositories and cost {calibration.softened.recallLost} of{" "}
                {calibration.softened.recallTotal} on the vulnerable one.
              </p>
            </>
          ) : (
            <p className="text-sm text-warning max-w-[62ch]">{calibrationNote || "Not measured on this run."}</p>
          )}
        </section>

        <section className="mt-12 text-sm text-muted max-w-[66ch] leading-relaxed space-y-3">
          <p>
            What remains on a repository is reported, not hidden. Django&rsquo;s ORM builds SQL by string
            inside <code className="font-mono">django/db</code>, which is the one place that is the job;{" "}
            <code className="font-mono">rails runner</code> evaluates its input by contract. A scanner
            should say so, and the project is right to accept it.
          </p>
          <p>
            Generated {generated.toISOString().slice(0, 10)} by{" "}
            <code className="font-mono">{precision.source}</code> on engine v{precision.engineVersion}
            {precision.engineCommit && precision.engineCommit !== "unknown" ? ` @ ${precision.engineCommit}` : ""}.
            The corpus manifest and the runner are in the repository, so anyone can re-run the table.{" "}
            <Link href="/modules" className="text-accent hover:underline">
              What the {siteStats.modules.total} modules check &rarr;
            </Link>{" "}
            <Link href="/noise" className="text-accent hover:underline">
              Which rules teams silence &rarr;
            </Link>
          </p>
        </section>
      </Section>
    </main>
  );
}
