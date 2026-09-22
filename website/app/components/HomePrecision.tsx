import Link from "next/link";
import precision from "../data/precision.json";

/**
 * <HomePrecision> — the proof that decides adoption: does the gate cry wolf?
 *
 * Every number here is read from website/app/data/precision.json, which
 * scripts/real-world-precision.js writes from its own measurement of pinned
 * commits of repositories we do not control. Nothing is typed by hand
 * (doctrine §7); tests/precision-page-sync.test.js fails the build if the
 * JSON and the corpus manifest disagree. The same file feeds /precision.
 */

type Row = {
  name: string;
  url: string;
  sha: string;
  why?: string;
  blocking: number;
  ceiling?: number;
  floor?: number;
};

const rows = precision.repos as Row[];
const precisionRows = rows.filter((r) => typeof r.ceiling === "number");
const recallRows = rows.filter((r) => typeof r.floor === "number");
const clean = precisionRows.filter((r) => r.blocking === 0);
const generated = new Date(precision.generatedAt);
const generatedLabel = generated.toISOString().slice(0, 10);
const repoUrl = (r: Row) => r.url.replace(/\.git$/, "");

export default function HomePrecision() {
  if (precisionRows.length === 0) return null;
  return (
    <section id="precision" className="max-w-6xl mx-auto my-20 px-4">
      <div className="text-center mb-10">
        <p className="text-xs uppercase tracking-widest text-[var(--accent)] font-semibold mb-3">
          Measured on code we didn&apos;t write
        </p>
        <h2 className="text-3xl md:text-4xl font-semibold text-[var(--foreground)] tracking-tight max-w-3xl mx-auto" style={{ textWrap: "balance" }}>
          A gate that blocks clean code gets uninstalled. So we publish the numbers.
        </h2>
        <p className="text-[var(--muted)] mt-4 max-w-2xl mx-auto">
          Every push runs a full scan of {precisionRows.length} pinned commits of repositories we do not
          control. Each is held to a ceiling that only ever goes down. If a rule starts
          over-firing on express or Django, our CI goes red before yours does.
        </p>
      </div>

      <div className="grid sm:grid-cols-3 gap-4 mb-8">
        <Stat num={String(clean.length)} label={`of ${precisionRows.length} real repositories pass with zero blocking findings`} />
        <Stat num={String(precisionRows.length)} label="pinned commits of repositories we do not control, every language the engine scans" />
        <Stat
          num={recallRows.length > 0 ? String(recallRows[0].blocking) : "—"}
          label={recallRows.length > 0 ? `blocking findings on ${recallRows[0].name}, the deliberately vulnerable app — recall is a floor, not a target` : "recall floor"}
        />
      </div>

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-solid)] overflow-x-auto shadow-sm">
        <table className="w-full text-sm" style={{ fontVariantNumeric: "tabular-nums" }}>
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-[var(--muted)] border-b border-[var(--border)]">
              <th className="px-5 py-3 font-semibold">Repository</th>
              <th className="px-5 py-3 font-semibold text-right">Blocking</th>
              <th className="px-5 py-3 font-semibold text-right">Ceiling</th>
              <th className="px-5 py-3 font-semibold hidden md:table-cell">What we learned there</th>
            </tr>
          </thead>
          <tbody>
            {precisionRows.map((r) => (
              <tr key={r.name} className="border-b border-[var(--border)] last:border-0">
                <td className="px-5 py-3">
                  <a href={repoUrl(r)} className="font-semibold text-[var(--foreground)] hover:text-[var(--accent)]" rel="noopener noreferrer" target="_blank">
                    {r.name}
                  </a>
                </td>
                <td className={`px-5 py-3 text-right font-mono ${r.blocking === 0 ? "text-[var(--accent)] font-bold" : "text-[var(--foreground)]"}`}>{r.blocking}</td>
                <td className="px-5 py-3 text-right font-mono text-[var(--muted)]">{r.ceiling}</td>
                <td className="px-5 py-3 text-[var(--muted)] hidden md:table-cell max-w-[48ch]">
                  <span className="line-clamp-2">{r.why}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 mt-4 text-xs text-[var(--muted)]">
        <span>
          Full suite, pinned commits, measured {generatedLabel}. What still blocks on these repos is real:
          a committed private key, an unauthenticated route, a query built from request input.
        </span>
        <Link href="/precision" className="font-semibold text-[var(--accent)] hover:underline">
          Every repository, every commit, every ceiling →
        </Link>
      </div>
    </section>
  );
}

function Stat({ num, label }: { num: string; label: string }) {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--background-alt)] p-6 text-center">
      <div className="text-4xl font-semibold text-[var(--foreground)]" style={{ fontVariantNumeric: "tabular-nums" }}>{num}</div>
      <div className="text-xs text-[var(--muted)] mt-2 leading-relaxed">{label}</div>
    </div>
  );
}
