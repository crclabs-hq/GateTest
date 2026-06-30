import type { Metadata } from "next";
import Link from "next/link";
import CopyButton from "@/app/components/CopyButton";

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

export default function BadgePage() {
  const exampleRepo = "crclabs-hq/GateTest";
  const badgeUrl    = `https://gatetest.ai/api/badge?repo=${exampleRepo}`;
  const markdownEmbed = `[![GateTest](${badgeUrl})](https://gatetest.ai/playground)`;
  const htmlEmbed     = `<a href="https://gatetest.ai/playground"><img src="${badgeUrl}" alt="GateTest"></a>`;
  const rstEmbed      = `.. image:: ${badgeUrl}\n   :target: https://gatetest.ai/playground\n   :alt: GateTest`;

  return (
    <div className="min-h-screen bg-[#050505] text-white">
      <div className="border-b border-white/[0.06]">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center gap-2 text-sm text-white/40">
          <Link href="/" className="hover:text-white/70 transition-colors">GateTest</Link>
          <span>/</span>
          <span className="text-white/70">Badge</span>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-16 space-y-16">

        {/* Hero */}
        <div className="space-y-4">
          <h1 className="text-4xl font-black tracking-tight">
            Add a live{" "}
            <span className="bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
              health score badge
            </span>
            {" "}to your README
          </h1>
          <p className="text-lg text-white/50 max-w-xl">
            One line of Markdown. Your grade updates automatically after every scan.
            Signals code quality to contributors, users, and hiring managers instantly.
          </p>

          {/* Live badge preview */}
          <div className="flex flex-wrap items-center gap-4 pt-2">
            {BADGE_GRADES.map((g) => (
              <BadgePreview key={g.grade} {...g} />
            ))}
          </div>
        </div>

        {/* Quick start */}
        <div className="space-y-6">
          <h2 className="text-xl font-bold text-white/80">Quick start</h2>

          <div className="space-y-4">
            {/* Step 1 */}
            <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 space-y-3">
              <div className="flex items-center gap-3">
                <span className="w-7 h-7 rounded-full bg-emerald-500/20 text-emerald-400 text-xs font-bold flex items-center justify-center">1</span>
                <h3 className="text-sm font-bold text-white/80">Run your first scan</h3>
              </div>
              <p className="text-xs text-white/40 ml-10">
                Paste your GitHub repo URL in the playground to get a grade. Or buy a full scan from $29.
              </p>
              <div className="ml-10">
                <Link
                  href="/playground"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold text-white transition-all"
                  style={{ background: "linear-gradient(135deg, #059669, #0891b2)" }}
                >
                  Open Playground →
                </Link>
              </div>
            </div>

            {/* Step 2 */}
            <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 space-y-3">
              <div className="flex items-center gap-3">
                <span className="w-7 h-7 rounded-full bg-emerald-500/20 text-emerald-400 text-xs font-bold flex items-center justify-center">2</span>
                <h3 className="text-sm font-bold text-white/80">Copy the badge snippet</h3>
              </div>
              <p className="text-xs text-white/40 ml-10">
                Replace <code className="text-white/60 font-mono">owner/repo</code> with your GitHub repo path.
              </p>

              <div className="ml-10 space-y-3">
                {/* Markdown */}
                <div className="space-y-1">
                  <p className="text-xs text-white/30 font-mono uppercase tracking-widest">Markdown (README.md)</p>
                  <div className="flex items-start gap-2">
                    <code className="flex-1 block rounded-xl bg-black/40 border border-white/10 p-3 font-mono text-xs text-white/60 break-all">
                      {`[![GateTest](https://gatetest.ai/api/badge?repo=`}<span className="text-emerald-400">owner/repo</span>{`)](https://gatetest.ai/playground)`}
                    </code>
                    <CopyButton text={markdownEmbed} />
                  </div>
                </div>

                {/* HTML */}
                <div className="space-y-1">
                  <p className="text-xs text-white/30 font-mono uppercase tracking-widest">HTML</p>
                  <div className="flex items-start gap-2">
                    <code className="flex-1 block rounded-xl bg-black/40 border border-white/10 p-3 font-mono text-xs text-white/60 break-all">
                      {`<a href="https://gatetest.ai/playground"><img src="https://gatetest.ai/api/badge?repo=`}
                      <span className="text-emerald-400">owner/repo</span>
                      {`" alt="GateTest"></a>`}
                    </code>
                    <CopyButton text={htmlEmbed} />
                  </div>
                </div>

                {/* RST */}
                <div className="space-y-1">
                  <p className="text-xs text-white/30 font-mono uppercase tracking-widest">reStructuredText</p>
                  <div className="flex items-start gap-2">
                    <code className="flex-1 block rounded-xl bg-black/40 border border-white/10 p-3 font-mono text-xs text-white/60 whitespace-pre-wrap break-all">
                      {`.. image:: https://gatetest.ai/api/badge?repo=`}<span className="text-emerald-400">owner/repo</span>{`\n   :target: https://gatetest.ai/playground\n   :alt: GateTest`}
                    </code>
                    <CopyButton text={rstEmbed} />
                  </div>
                </div>
              </div>
            </div>

            {/* Step 3 */}
            <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 space-y-3">
              <div className="flex items-center gap-3">
                <span className="w-7 h-7 rounded-full bg-emerald-500/20 text-emerald-400 text-xs font-bold flex items-center justify-center">3</span>
                <h3 className="text-sm font-bold text-white/80">Commit and push</h3>
              </div>
              <p className="text-xs text-white/40 ml-10">
                The badge updates automatically after every GateTest scan. No re-configuration needed.
              </p>
            </div>
          </div>
        </div>

        {/* Badge API reference */}
        <div className="space-y-4">
          <h2 className="text-xl font-bold text-white/80">Badge API</h2>
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10">
                  <th className="text-left px-5 py-3 text-xs text-white/40 font-mono uppercase tracking-widest">Parameter</th>
                  <th className="text-left px-5 py-3 text-xs text-white/40 font-mono uppercase tracking-widest">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                <tr>
                  <td className="px-5 py-3 font-mono text-xs text-emerald-400">repo</td>
                  <td className="px-5 py-3 text-xs text-white/50">GitHub repo in <code className="font-mono">owner/name</code> format (required)</td>
                </tr>
                <tr>
                  <td className="px-5 py-3 font-mono text-xs text-white/40">style</td>
                  <td className="px-5 py-3 text-xs text-white/50">Badge style — <code className="font-mono">flat</code> (default) or <code className="font-mono">shields</code></td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-xs text-white/30 font-mono">
            Endpoint: <span className="text-white/50">GET https://gatetest.ai/api/badge?repo=owner/repo</span>
          </p>
          <p className="text-xs text-white/30 font-mono">
            Cache: <span className="text-white/50">5 minutes (CDN) · Stale-while-revalidate</span>
          </p>
        </div>

        {/* Why badge matters */}
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
            <div
              key={card.title}
              className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5 space-y-2"
            >
              <span className="text-2xl">{card.icon}</span>
              <h3 className="text-sm font-bold text-white/80">{card.title}</h3>
              <p className="text-xs text-white/40 leading-relaxed">{card.body}</p>
            </div>
          ))}
        </div>

        {/* CTA */}
        <div className="text-center space-y-4 py-8">
          <p className="text-white/40 text-sm">Ready to earn your badge?</p>
          <Link
            href="/playground"
            className="inline-flex items-center gap-2 px-8 py-4 rounded-2xl font-bold text-sm text-white"
            style={{ background: "linear-gradient(135deg, #059669, #0891b2)" }}
          >
            Scan your repo for free →
          </Link>
        </div>
      </div>
    </div>
  );
}
