import siteStats from "./data/site-stats.json";
import precision from "./data/precision.json";
import { appInstallUrl } from "./lib/github-app-permissions";
import { Rail } from "./preview/_components/Rail";
import { LiveRun } from "./preview/_components/LiveRun";
import { Numbers } from "./preview/_components/Numbers";
import { Artifacts } from "./preview/_components/Artifacts";
import { PrecisionChart } from "./preview/_components/PrecisionChart";
import { Runs } from "./preview/_components/Runs";
import { Pricing } from "./preview/_components/Pricing";
import { Faq } from "./preview/_components/Faq";

/**
 * Homepage (issue #686 phase 3, owner decision 2026-09-23: "much better; we
 * need the same on all the other pages"). This is the v2 design reviewed
 * live at /preview (#636), promoted here once the buyer-walk defects
 * (#678/#688), the shared design system (#696) and the sitewide restyle
 * (#712) had all merged. Sections carry data-stage so the rail can follow:
 * push (hero) -> gate (numbers) -> findings -> fix (artifacts) -> merge
 * (runs, pricing, faq). Every figure is imported from a data file the
 * nightly jobs regenerate; none is typed.
 *
 * Theme: this page follows the site-wide light/dark/system toggle (#690)
 * like every other page. /preview forced `data-theme="dark"` via an inline
 * script in its own layout so reviewers always saw the same look before
 * launch — that forcing script belonged to the review harness, not the
 * product, and was deliberately NOT carried over here.
 */
export const metadata = { alternates: { canonical: "/" } };

export default function Home() {
  const modules = siteStats.modules.total;
  const corpusSize = precision.repos.filter((r) => typeof r.ceiling === "number").length;
  const clean = precision.repos.filter((r) => typeof r.ceiling === "number" && r.blocking === 0).length;

  return (
    <main>
      <Rail />

      {/* ── push: hero + the live run ─────────────────────────────────── */}
      <section id="push" data-stage="push" className="v2-section pt-16 lg:pt-24">
        <div className="v2-wrap">
          <div className="v2-kicker mb-6 flex flex-wrap gap-x-4 gap-y-1">
            <span>v{siteStats.version}</span>
            <span>{modules} modules</span>
            <span>beta</span>
            <span>github · gitlab · circleci · gluecron</span>
          </div>
          <h1 className="v2-h1 max-w-4xl">
            {modules} checks, one CI gate.
            <br />
            <span className="text-[var(--v2-muted)]">Fails on the diff, not the backlog.</span>
          </h1>
          <p className="mt-6 max-w-2xl text-[17px] leading-relaxed text-[var(--v2-muted)]">
            Deterministic static analysis on every push, scored against a baseline file you commit, so the job
            fails only on new findings. Every report lists what was not checked. Precision is measured nightly on{" "}
            {corpusSize} pinned third-party repositories and published, misses included.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a href={appInstallUrl()} className="v2-btn v2-btn-primary">Install the GitHub App</a>
            <a href="/quickstart" className="v2-btn">Quickstart, four steps</a>
            <code className="v2-mono self-center text-[13px] text-[var(--v2-muted)]">npx -p @gatetest/cli gatetest --suite quick</code>
          </div>
          <div className="mt-14">
            <LiveRun />
          </div>
        </div>
      </section>

      {/* ── gate: the numbers, with their files ───────────────────────── */}
      <section id="gate" data-stage="gate" className="v2-section">
        <div className="v2-wrap">
          <Numbers
            items={[
              { value: modules, label: "modules in the gate", source: "site-stats.json · gatetest --list" },
              { value: corpusSize, label: "pinned third-party repositories in the corpus", source: "precision.json · nightly" },
              { value: clean, label: "of them with zero blocking findings", source: "precision.json · ceilings only ratchet down" },
              { value: siteStats.tests.passing, label: "tests passing on our own repo, every commit", source: "site-stats.json · scripts/run-tests.js" },
            ]}
          />
        </div>
      </section>

      {/* ── findings + fix: the three artifacts ───────────────────────── */}
      <section className="v2-section">
        <div className="v2-wrap">
          <div className="v2-kicker mb-3">what your team receives</div>
          <h2 className="v2-h2 max-w-2xl">Three artifacts. Nothing to log in to.</h2>
          <div className="mt-12">
            <Artifacts />
          </div>
        </div>
      </section>

      {/* ── merge: precision, where it runs, pricing, faq ─────────────── */}
      <section id="merge" data-stage="merge" className="v2-section">
        <div className="v2-wrap">
          <div className="v2-kicker mb-3">measured on code we did not write</div>
          <h2 className="v2-h2 max-w-2xl">A gate that blocks clean code gets uninstalled. So the numbers are public.</h2>
          <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-[var(--v2-muted)]">
            Every push runs the full suite on {corpusSize} pinned commits of repositories we do not control. Each has a
            ceiling that only goes down. Hover a row for what that repository taught the rules.
          </p>
          <div className="mt-10">
            <PrecisionChart />
          </div>
          <a href="/precision" className="mt-4 inline-block text-sm underline decoration-[var(--v2-line-strong)] underline-offset-4 hover:decoration-[var(--v2-fg)]">
            Every repository, every commit, every ceiling
          </a>
        </div>
      </section>

      <section className="v2-section">
        <div className="v2-wrap">
          <div className="v2-kicker mb-3">one engine</div>
          <h2 className="v2-h2">Where it runs</h2>
          <div className="mt-10">
            <Runs />
          </div>
        </div>
      </section>

      <section className="v2-section">
        <div className="v2-wrap">
          <div className="v2-kicker mb-3">pay per run</div>
          <h2 className="v2-h2">Pricing</h2>
          <div className="mt-10">
            <Pricing />
          </div>
        </div>
      </section>

      <section className="v2-section">
        <div className="v2-wrap">
          <div className="v2-kicker mb-3">before you install</div>
          <h2 className="v2-h2">The questions engineers ask first</h2>
          <div className="mt-10">
            <Faq />
          </div>
        </div>
      </section>
    </main>
  );
}
