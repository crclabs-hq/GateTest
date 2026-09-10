import type { Metadata } from "next";
import Link from "next/link";
import { siteUrl, badgeUrl as badgeUrlFor } from "@/app/lib/site-url";
import CopyButton from "@/app/components/CopyButton";
import PageHero from "../components/site/PageHero";
import Section from "../components/site/Section";

export const metadata: Metadata = {
  title: "README Badge — GateTest",
  description:
    "Add a live GateTest health score badge to your GitHub README. Shows your grade (A–F) and updates automatically after every scan.",
};

const BADGE_GRADES = [
  { grade: "A", score: 94, color: "#059669" },
  { grade: "B", score: 78, color: "#0d9488" },
  { grade: "C", score: 63, color: "#d97706" },
  { grade: "D", score: 45, color: "#ea580c" },
  { grade: "F", score: 22, color: "#dc2626" },
];

function BadgePreview({ grade, score, color }: { grade: string; score: number; color: string }) {
  const label = "GateTest";
  const value = `${grade} (${score})`;
  const labelW = label.length * 6.8 + 12;
  const valueW = value.length * 7.5 + 14;
  const total = labelW + valueW;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img">
  <title>${label}: ${value}</title>
  <clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelW}" height="20" fill="#555"/>
    <rect x="${labelW}" width="${valueW}" height="20" fill="${color}"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,sans-serif" font-size="11">
    <text x="${labelW / 2}" y="14">${label}</text>
    <text x="${labelW + valueW / 2}" y="14">${value}</text>
  </g>
</svg>`;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
      alt={`GateTest ${grade}`}
      height={20}
    />
  );
}

// Snippets are what the README renders, so they stay dark panels.
const SNIPPET = "flex-1 block rounded-xl bg-panel text-panel-foreground border border-panel-border p-3 font-mono text-xs break-all";

function StepNumber({ n }: { n: number }) {
  return (
    <span className="w-7 h-7 rounded-full bg-accent/10 text-accent text-xs font-bold flex items-center justify-center">{n}</span>
  );
}

export default function BadgePage() {
  // These snippets get pasted into READMEs we can never edit — the domain
  // comes from site-url, never a literal (the Bible: THE DOMAIN).
  const exampleRepo = "crclabs-hq/GateTest";
  const badgeUrl    = badgeUrlFor(`/badge/${exampleRepo}.svg`);
  const target      = siteUrl("/playground");
  const markdownEmbed = `[![GateTest](${badgeUrl})](${target})`;
  const htmlEmbed     = `<a href="${target}"><img src="${badgeUrl}" alt="GateTest"></a>`;
  const rstEmbed      = `.. image:: ${badgeUrl}\n   :target: ${target}\n   :alt: GateTest`;

  return (
    <main>
      <PageHero
        eyebrow="README badge"
        title={<>Add a live <span className="text-accent">health score badge</span> to your README</>}
        lede="One line of Markdown. Your grade updates automatically after every scan. Signals code quality to contributors, users, and hiring managers instantly."
        actions={
          <Link href="/playground" className="btn-cta px-6 py-3 text-sm font-semibold rounded-xl">
            Scan your repo for free →
          </Link>
        }
      >
        {/* Live badge preview */}
        <div className="card p-6">
          <p className="text-xs font-mono uppercase tracking-widest text-muted mb-4">Every grade, live</p>
          <div className="flex flex-wrap items-center gap-4">
            {BADGE_GRADES.map((g) => (
              <BadgePreview key={g.grade} {...g} />
            ))}
          </div>
        </div>
      </PageHero>

      <Section narrow title="Quick start">
        <div className="space-y-4">
          {/* Step 1 */}
          <div className="card p-6 space-y-3">
            <div className="flex items-center gap-3">
              <StepNumber n={1} />
              <h3 className="text-sm font-bold text-foreground">Run your first scan</h3>
            </div>
            <p className="text-xs text-muted ml-10">
              Paste your GitHub repo URL in the playground for a free preview. The badge shows a grade once a paid scan (from $29) is on record.
            </p>
            <div className="ml-10">
              <Link href="/playground" className="btn-cta inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-xl">
                Open Playground →
              </Link>
            </div>
          </div>

          {/* Step 2 */}
          <div className="card p-6 space-y-3">
            <div className="flex items-center gap-3">
              <StepNumber n={2} />
              <h3 className="text-sm font-bold text-foreground">Copy the badge snippet</h3>
            </div>
            <p className="text-xs text-muted ml-10">
              Replace <code className="text-foreground font-mono">owner/repo</code> with your GitHub repo path.
            </p>

            <div className="ml-10 space-y-3">
              {/* Markdown */}
              <div className="space-y-1">
                <p className="text-xs text-muted font-mono uppercase tracking-widest">Markdown (README.md)</p>
                <div className="flex items-start gap-2">
                  <code className={SNIPPET}>
                    {`[![GateTest](${badgeUrlFor("/badge/")}`}<span className="text-emerald-400">owner/repo</span>{`.svg)](${target})`}
                  </code>
                  <CopyButton text={markdownEmbed} />
                </div>
              </div>

              {/* HTML */}
              <div className="space-y-1">
                <p className="text-xs text-muted font-mono uppercase tracking-widest">HTML</p>
                <div className="flex items-start gap-2">
                  <code className={SNIPPET}>
                    {`<a href="${target}"><img src="${badgeUrlFor("/badge/")}`}
                    <span className="text-emerald-400">owner/repo</span>
                    {`" alt="GateTest"></a>`}
                  </code>
                  <CopyButton text={htmlEmbed} />
                </div>
              </div>

              {/* RST */}
              <div className="space-y-1">
                <p className="text-xs text-muted font-mono uppercase tracking-widest">reStructuredText</p>
                <div className="flex items-start gap-2">
                  <code className={`${SNIPPET} whitespace-pre-wrap`}>
                    {`.. image:: ${badgeUrlFor("/badge/")}`}<span className="text-emerald-400">owner/repo</span>{`.svg\n   :target: ${target}\n   :alt: GateTest`}
                  </code>
                  <CopyButton text={rstEmbed} />
                </div>
              </div>
            </div>
          </div>

          {/* Step 3 */}
          <div className="card p-6 space-y-3">
            <div className="flex items-center gap-3">
              <StepNumber n={3} />
              <h3 className="text-sm font-bold text-foreground">Commit and push</h3>
            </div>
            <p className="text-xs text-muted ml-10">
              The badge updates automatically after every GateTest scan. No re-configuration needed.
            </p>
          </div>
        </div>
      </Section>

      <Section alt narrow title="Badge API">
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-5 py-3 text-xs text-muted font-mono uppercase tracking-widest">Parameter</th>
                <th className="text-left px-5 py-3 text-xs text-muted font-mono uppercase tracking-widest">Description</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              <tr>
                <td className="px-5 py-3 font-mono text-xs text-accent">repo</td>
                <td className="px-5 py-3 text-xs text-muted">GitHub repo in <code className="font-mono">owner/name</code> format (required). Shows <code className="font-mono">not scanned</code> until a scan is on record.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted font-mono mt-4">
          Endpoint: <span className="text-foreground">GET {badgeUrlFor("/badge/owner/repo.svg")}</span>
        </p>
        <p className="text-xs text-muted font-mono mt-1">
          Cache: <span className="text-foreground">5 minutes (max-age=300, public)</span>
        </p>
      </Section>

      <Section>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[
            {
              icon: "🏷️",
              title: "Signal quality instantly",
              body: "Contributors and users see your code quality grade before they read a single line of code.",
            },
            {
              icon: "🔄",
              title: "Always up to date",
              body: "The badge reflects the latest completed scan. Run a scan → badge updates. No manual steps.",
            },
            {
              icon: "📈",
              title: "Accountability built in",
              body: "A declining grade is visible to everyone. Teams with a public badge fix issues faster.",
            },
          ].map((card) => (
            <div key={card.title} className="card p-5 space-y-2">
              <span className="text-2xl">{card.icon}</span>
              <h3 className="text-sm font-bold text-foreground">{card.title}</h3>
              <p className="text-xs text-muted leading-relaxed">{card.body}</p>
            </div>
          ))}
        </div>

        {/* CTA */}
        <div className="text-center space-y-4 pt-16">
          <p className="text-muted text-sm">Ready to earn your badge?</p>
          <Link href="/playground" className="btn-cta inline-flex items-center gap-2 px-8 py-4 text-sm font-semibold rounded-xl">
            Scan your repo for free →
          </Link>
        </div>
      </Section>
    </main>
  );
}
