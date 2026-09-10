import type { Metadata } from "next";
import Link from "next/link";
import { contentMetadata, breadcrumbSchema, jsonLd } from "../lib/seo/schema";
import { getSlugForModuleName } from "../components/howitworks/module-slugs";
import changelog from "../data/changelog.json";
import PageHero from "../components/site/PageHero";
import Section from "../components/site/Section";
import StatTiles from "../components/site/StatTiles";

// Every entry on this page comes from website/app/data/changelog.json, which
// scripts/generate-changelog.js writes from the main branch's first-parent
// history — the same contract as site-stats.json and precision.json. Nothing
// here is typed by hand; tests/changelog-sync.test.js fails the build if the
// file stops matching the repository (version, shape, order) or if this page
// stops importing it.

export const metadata: Metadata = contentMetadata({
  title: "Changelog — every change to GateTest, in the order it merged",
  description:
    "The GateTest changelog, generated from the main branch: each pull request that merged, the date, which part of the product it touched and which scan modules it changed. No entry is typed by hand.",
  path: "/changelog",
  keywords: ["gatetest changelog", "gatetest release notes", "code quality gate updates"],
});

type Entry = {
  sha: string;
  short: string;
  date: string;
  pr: number | null;
  title: string;
  area: string;
  areas: Record<string, number>;
  files: number;
  modules: string[];
  version: string | null;
};

const REPO = "https://github.com/crclabs-hq/GateTest";
const entries = changelog.entries as Entry[];
const generated = new Date(changelog.generatedAt);

const AREA_LABEL: Record<string, string> = {
  engine: "engine",
  website: "website",
  integrations: "CI integration",
  ci: "our CI",
  tests: "tests",
  corpus: "precision corpus",
  tooling: "tooling",
  docs: "docs",
  other: "repo",
};

const AREA_TONE: Record<string, string> = {
  engine: "border-accent/40 text-accent",
  website: "border-sky-500/40 text-sky-600",
  integrations: "border-warning/40 text-warning",
  corpus: "border-fuchsia-500/40 text-fuchsia-600",
};

function groupByDate(list: Entry[]): Array<[string, Entry[]]> {
  const out: Array<[string, Entry[]]> = [];
  for (const e of list) {
    const last = out[out.length - 1];
    if (last && last[0] === e.date) last[1].push(e);
    else out.push([e.date, [e]]);
  }
  return out;
}

const longDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

function ModuleChip({ name }: { name: string }) {
  const slug = getSlugForModuleName(name);
  const cls = "font-mono text-[11px] px-1.5 py-0.5 rounded border border-border text-muted";
  if (!slug) return <span className={cls}>{name}</span>;
  return (
    <Link href={`/modules/${slug}`} className={`${cls} hover:border-accent/50 hover:text-accent transition-colors`}>
      {name}
    </Link>
  );
}

function EntryRow({ e }: { e: Entry }) {
  const tone = AREA_TONE[e.area] ?? "border-border-strong text-muted";
  const otherAreas = Object.keys(e.areas).filter((a) => a !== e.area);
  return (
    <li className="py-4 border-b border-border last:border-0">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <span className={`shrink-0 mt-0.5 text-[11px] font-mono uppercase tracking-[0.08em] px-2 py-0.5 rounded-full border ${tone}`}>
          {AREA_LABEL[e.area] ?? e.area}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] leading-snug text-foreground" style={{ textWrap: "pretty" }}>
            {e.title}
          </p>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted font-mono tabular-nums">
            {e.pr !== null ? (
              <a href={`${REPO}/pull/${e.pr}`} className="hover:text-accent transition-colors" rel="noopener">
                #{e.pr}
              </a>
            ) : (
              <span title="Committed directly to main">direct to main</span>
            )}
            <a href={`${REPO}/commit/${e.sha}`} className="hover:text-accent transition-colors" rel="noopener">
              {e.short}
            </a>
            <span>{e.files} {e.files === 1 ? "file" : "files"}</span>
            {otherAreas.length > 0 && <span>also {otherAreas.map((a) => AREA_LABEL[a] ?? a).join(", ")}</span>}
            {e.version && (
              <span className="text-success border border-success/40 rounded px-1.5">v{e.version}</span>
            )}
          </p>
          {e.modules.length > 0 && (
            <p className="mt-2 flex flex-wrap gap-1.5">
              {e.modules.map((m) => (
                <ModuleChip key={m} name={m} />
              ))}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

export default function ChangelogPage() {
  const groups = groupByDate(entries);
  const oldest = entries[entries.length - 1];
  const prCount = entries.filter((e) => e.pr !== null).length;
  const moduleCount = new Set(entries.flatMap((e) => e.modules)).size;

  return (
    <main>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLd(breadcrumbSchema([{ name: "GateTest", path: "/" }, { name: "Changelog" }])),
        }}
      />

      <PageHero
        eyebrow="Generated"
        title="Every change, in the order it merged"
        lede={
          <>
            This is the main branch of the engine, read back as a list. Each entry is a commit that
            reached <code className="font-mono text-foreground text-[0.92em]">main</code>: the pull request
            it came from, the part of the product it touched most, and the scan modules it changed. It is
            written by a script from the repository history, so it cannot describe a change that did not
            ship or omit one that did.
          </>
        }
        actions={
          <Link href="/precision" className="btn-secondary px-5 py-2.5 text-sm">
            Precision benchmark &rarr;
          </Link>
        }
      />

      <Section>
        <StatTiles
          items={[
            { value: `v${changelog.currentVersion}`, label: "Engine version" },
            { value: `${entries.length}`, label: "Changes listed" },
            { value: `${prCount}`, label: "Via pull request" },
            { value: `${moduleCount}`, label: "Modules touched" },
          ]}
        />

        <p className="mt-4 text-xs text-muted font-mono tabular-nums">
          Regenerated {generated.toISOString().slice(0, 10)} at{" "}
          <a href={`${REPO}/commit/${changelog.head}`} className="hover:text-accent transition-colors" rel="noopener">
            {String(changelog.head).slice(0, 7)}
          </a>
          {oldest && <> · history shown from {oldest.date}</>} · the narrative behind each release is in{" "}
          <a href={`${REPO}/blob/main/docs/HISTORY.md`} className="hover:text-accent transition-colors" rel="noopener">
            docs/HISTORY.md
          </a>
        </p>

        <div className="mt-14">
          {groups.map(([date, list]) => (
            <div key={date} className="md:grid md:grid-cols-[180px_1fr] md:gap-8 mb-10">
              <h2 className="font-display text-sm font-semibold text-accent md:sticky md:top-20 md:self-start mb-2 md:mb-0 tabular-nums">
                {longDate(date)}
              </h2>
              <ul>
                {list.map((e) => (
                  <EntryRow key={e.sha} e={e} />
                ))}
              </ul>
            </div>
          ))}
        </div>

        <p className="mt-6 text-sm text-muted max-w-[62ch] leading-relaxed">
          Older history lives in{" "}
          <a href={`${REPO}/blob/main/docs/HISTORY.md`} className="text-foreground-secondary hover:text-accent transition-colors" rel="noopener">
            docs/HISTORY.md
          </a>
          , which also records the measurement behind each release. Want to see the engine on code it
          does not control? The <Link href="/precision" className="text-foreground-secondary hover:text-accent transition-colors">precision benchmark</Link> is
          regenerated nightly.
        </p>
      </Section>
    </main>
  );
}
