import type { Metadata } from "next";
import Link from "next/link";
import { contentMetadata, breadcrumbSchema, jsonLd } from "../lib/seo/schema";
import precision from "../data/precision.json";
import headToHead from "../data/head-to-head.json";
import siteStats from "../data/site-stats.json";
import { buildTable } from "../lib/head-to-head";
import PageHero from "../components/site/PageHero";
import Section from "../components/site/Section";
import RuleTable from "./RuleTable";
import { NonceScript } from "@/app/lib/seo/NonceScript";

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

type PrecisionRule = {
  rule: string;
  module: string | null;
  findings: number;
  onZeroCeilingRepos: number;
  controlPairs: number;
  repos: Array<{ name: string; sha: string }>;
};

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
// By-rule aggregate (the Fifty, move 02): rules[] is written by the same
// script and run as repos[] above. Present-but-empty (never omitted) when a
// snapshot predates the field or the nightly hasn't re-run yet — the section
// says so rather than silently disappearing.
const ruleRows = ((precision as { rules?: PrecisionRule[] }).rules ?? []) as PrecisionRule[];
const rulesNote = (precision as { rulesNote?: string }).rulesNote ?? "";
const commitUrl = (r: Row) => `${r.url.replace(/\.git$/, "")}/commit/${r.sha}`;
const generated = new Date(precision.generatedAt);

// The head-to-head table: GateTest, Semgrep and ESLint (eslint-plugin-security)
// on the same pinned clones, written by scripts/head-to-head.js and rendered
// through the same module that validated it. A cell for a tool that was not
// run, timed out, or is not measured yet carries that text — never a blank.
// tests/head-to-head.test.js proves it on a fixture with every kind of null.
const h2h = buildTable(headToHead);
const h2hGenerated = new Date(headToHead.generatedAt);
const h2hMeasured = headToHead.repos.length;
const h2hCorpus = headToHead.corpusSize;
const cellClass: Record<string, string> = {
  clean: "text-[var(--v2-ok)]",
  measured: "text-[var(--v2-fg)]",
  failed: "text-[var(--v2-warn)]",
  unavailable: "text-[var(--v2-muted)] italic",
  "not-measured": "text-[var(--v2-muted)] italic",
  "not-run": "text-[var(--v2-muted)] italic",
};

const label = "v2-kicker text-[var(--v2-accent)] mb-4";
const numCell = "v2-mono text-right";

export default function PrecisionPage() {
  return (
    <main>
      <NonceScript
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
          <div className="overflow-x-auto">
            <table className="v2-table min-w-[640px]">
              <thead>
                <tr>
                  <th>Repository</th>
                  <th>Commit</th>
                  <th className="text-right">Blocking</th>
                  <th className="text-right">Ceiling</th>
                  <th>Why it is in the corpus</th>
                </tr>
              </thead>
              <tbody>
                {precisionRows.map((r) => (
                  <tr key={r.name}>
                    <td className="font-medium">{r.name}</td>
                    <td className="v2-mono text-[var(--v2-muted)]">
                      <a href={commitUrl(r)} className="hover:text-[var(--v2-accent)] transition-colors" rel="noopener">
                        {r.sha.slice(0, 8)}
                      </a>
                    </td>
                    <td className={`${numCell} ${r.blocking === 0 ? "text-[var(--v2-ok)]" : "text-[var(--v2-fg)]"}`}>{r.blocking}</td>
                    <td className={`${numCell} text-[var(--v2-muted)]`}>{r.ceiling}</td>
                    <td className="max-w-[38ch]">{r.why}</td>
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
          <div className="overflow-x-auto">
            <table className="v2-table min-w-[520px]">
              <thead>
                <tr>
                  <th>Repository</th>
                  <th>Commit</th>
                  <th className="text-right">Blocking</th>
                  <th className="text-right">Floor</th>
                </tr>
              </thead>
              <tbody>
                {recallRows.map((r) => (
                  <tr key={r.name}>
                    <td className="font-medium">{r.name}</td>
                    <td className="v2-mono text-[var(--v2-muted)]">
                      <a href={commitUrl(r)} className="hover:text-[var(--v2-accent)] transition-colors" rel="noopener">
                        {r.sha.slice(0, 8)}
                      </a>
                    </td>
                    <td className={`${numCell} text-[var(--v2-bad)]`}>{r.blocking}</td>
                    <td className={`${numCell} text-[var(--v2-muted)]`}>{r.floor}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-12">
          <h2 className={label}>By rule — what a senior developer actually checks</h2>
          <p className="text-foreground-secondary max-w-[62ch] leading-relaxed mb-4">
            A per-repository table proves the corpus was run; it does not show which rule is trustworthy. This
            table groups every error-severity finding of the same run by rule: how many fired across the twenty
            repositories, how many of those landed on a repository held to a <em>zero</em> ceiling &mdash; our
            cleanest controls, so a finding there is the shape of a false positive even when a confidence signal
            kept it from blocking &mdash; and how many tests under <code className="font-mono">tests/</code> are
            tagged as that rule&rsquo;s control pair (Doctrine #3: no rule ships without one). Sort any column by
            clicking its header.
          </p>
          {ruleRows.length > 0 ? (
            <RuleTable rules={ruleRows} />
          ) : (
            <p className="text-sm text-warning max-w-[62ch]">
              {rulesNote || "Not measured on this snapshot."}
            </p>
          )}
          <p className="mt-4 text-sm text-[var(--v2-muted)] max-w-[66ch] leading-relaxed">
            Engine v{precision.engineVersion}
            {precision.engineCommit && precision.engineCommit !== "unknown" ? ` @ ${precision.engineCommit}` : ""},
            generated {generated.toISOString().slice(0, 10)}. This table is regenerated by the nightly corpus run
            (<code className="font-mono">.github/workflows/dogfood-nightly.yml</code>) whenever the numbers
            change &mdash; not on every merge &mdash; and rides the same rolling PR as the repository table above.
          </p>
        </section>

        <section className="mt-12">
          <h2 className={label}>Head to head — the same commits, other scanners</h2>
          <p className="text-foreground-secondary max-w-[66ch] leading-relaxed mb-4">
            The same pinned clones, handed to Semgrep (its default <code className="font-mono">auto</code>{" "}
            ruleset) and, where the repository is JavaScript or TypeScript, to ESLint with
            eslint-plugin-security&rsquo;s recommended rules. The counts are not comparable one-to-one:
            GateTest&rsquo;s <em>blocking</em> is a gate verdict &mdash; error-severity findings at or above the
            confidence threshold, across code quality, security, infrastructure and documentation &mdash; while
            Semgrep&rsquo;s <em>error</em> is the label a rule author chose, eslint-plugin-security reports
            fourteen security rules, and CodeQL&rsquo;s count comes from its own CLI running the official{" "}
            <code className="font-mono">*-security-extended</code> query suite for the repository&rsquo;s language
            (e.g. <code className="font-mono">javascript-security-extended.qls</code>), with a result counted as
            blocking-equivalent at SARIF level error or a security-severity of 7.0 or above. Read each column as
            what that tool says about that commit and how long it took to say it. Each
            tool is time-boxed at {Math.round(headToHead.toolTimeoutSeconds / 60)} minutes per repository. SonarQube
            has not been run yet; CodeQL runs where its CLI is installed and the repository&rsquo;s language has a
            security-extended suite. Either column says so, and why, instead of a number when it was not measured.{" "}
            {h2hMeasured} of {h2hCorpus} corpus repositories measured on{" "}
            {h2hGenerated.toISOString().slice(0, 10)} with GateTest <code className="font-mono">--suite {headToHead.suite}</code>.
          </p>
          <div className="overflow-x-auto">
            <table className="v2-table min-w-[960px]">
              <thead>
                <tr>
                  <th>Repository</th>
                  <th>Language</th>
                  {h2h.columns.map((c) => (
                    <th key={c.key}>
                      {c.label}
                      {c.version ? <span className="ml-2 v2-mono text-[11px] text-[var(--v2-muted)]">v{c.version}</span> : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {h2h.rows.map((r) => (
                  <tr key={r.name}>
                    <td className="font-medium whitespace-nowrap">
                      {r.name}{" "}
                      <a
                        href={`${r.url.replace(/\.git$/, "")}/commit/${r.sha}`}
                        className="ml-1 v2-mono text-[11px] text-[var(--v2-muted)] hover:text-[var(--v2-accent)] transition-colors"
                        rel="noopener"
                      >
                        {r.sha.slice(0, 8)}
                      </a>
                    </td>
                    <td className="whitespace-nowrap">{r.language}</td>
                    {r.cells.map((cell, i) => (
                      <td key={h2h.columns[i].key} className={`align-top ${cellClass[cell.kind] ?? "text-[var(--v2-fg)]"}`}>
                        <span className="v2-mono">{cell.text}</span>
                        {cell.detail ? <span className="ml-2 text-[11px] text-[var(--v2-muted)]">{cell.detail}</span> : null}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-sm text-[var(--v2-muted)] max-w-[66ch] leading-relaxed">
            Generated {h2hGenerated.toISOString().slice(0, 10)} by{" "}
            <code className="font-mono">{headToHead.source}</code> on engine v{headToHead.engineVersion}. Every tool
            saw the same bytes; a run that hit the time box is written as timed out with the seconds it used, and a
            tool the runner could not install is written as unavailable. The script and the manifest are in the
            repository, so anyone can re-run the table.
          </p>
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
              <div className="overflow-x-auto">
                <table className="v2-table min-w-[520px]">
                  <thead>
                    <tr>
                      <th>Block at confidence ≥</th>
                      <th className="text-right">Blocking on clean repos</th>
                      <th className="text-right">Still caught on NodeGoat</th>
                    </tr>
                  </thead>
                  <tbody>
                    {calibration.sweep.map((s) => (
                      <tr key={s.threshold} className={s.shipped ? "bg-[var(--v2-accent)]/10" : ""}>
                        <td className="v2-mono">
                          {s.threshold.toFixed(2)}
                          {s.shipped && <span className="ml-2 text-[11px] uppercase tracking-[0.08em] text-[var(--v2-accent)]">shipped</span>}
                        </td>
                        <td className={numCell}>{s.precisionBlocking}</td>
                        <td className={`${numCell} text-[var(--v2-bad)]`}>{s.recallBlocking}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-4 text-sm text-[var(--v2-muted)] max-w-[66ch] leading-relaxed">
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
