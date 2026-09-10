"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { UrlScanFlow } from "./UrlScanFlow";

/**
 * The hero's one action, for every audience we sell to (Craig 2026-09-10:
 * "pull everybody in, including WordPress users"). Three doors in the first
 * screen instead of one URL box that only fitted website owners:
 *   Repository → the free playground scan (public repos, no signup)
 *   Website    → the live URL scan that already ran here
 *   WordPress  → the same flow with the WordPress suite
 */

type Door = "repo" | "web" | "wp";

const DOORS: { id: Door; label: string; hint: string }[] = [
  { id: "repo", label: "Repository", hint: "GitHub or Gluecron. Public repos scan free." },
  { id: "web", label: "Website", hint: "Any URL. Security, accessibility, performance." },
  { id: "wp", label: "WordPress", hint: "Your WordPress site. No plugin, no code." },
];

const SAMPLES: Record<Door, { label: string; value: string }[]> = {
  repo: [
    { label: "octocat/Hello-World", value: "https://github.com/octocat/Hello-World" },
    { label: "expressjs/express", value: "https://github.com/expressjs/express" },
  ],
  web: [
    { label: "example.com", value: "https://example.com" },
    { label: "nextjs.org", value: "https://nextjs.org" },
    { label: "vercel.com", value: "https://vercel.com" },
  ],
  wp: [
    { label: "wordpress.org", value: "https://wordpress.org" },
    { label: "woocommerce.com", value: "https://woocommerce.com" },
  ],
};

const PILL = "replace-pill px-3 py-1.5 rounded-full text-gray-600 hover:text-gray-900 hover:border-[#0f766e]/30 transition-colors font-mono";

export default function HeroScanTabs() {
  const [door, setDoor] = useState<Door>("repo");
  const [seed, setSeed] = useState<{ url: string; nonce: number }>({ url: "", nonce: 0 });
  const [repo, setRepo] = useState("");
  const router = useRouter();

  function prefill(value: string) {
    if (door === "repo") { setRepo(value); return; }
    setSeed((s) => ({ url: value, nonce: s.nonce + 1 }));
    requestAnimationFrame(() => {
      const el = document.getElementById("url-scan-input") as HTMLInputElement | null;
      if (el) el.focus();
    });
  }

  function goRepo(e: React.FormEvent) {
    e.preventDefault();
    const v = repo.trim();
    if (!v) return;
    router.push(`/playground?repo=${encodeURIComponent(v)}`);
  }

  return (
    <div>
      <div role="tablist" aria-label="What do you want to scan?" className="inline-flex rounded-xl border border-black/10 bg-white/70 p-1 mb-4 shadow-sm">
        {DOORS.map((d) => {
          const active = d.id === door;
          return (
            <button
              key={d.id}
              role="tab"
              type="button"
              id={`door-${d.id}`}
              aria-selected={active}
              aria-controls={`door-panel-${d.id}`}
              onClick={() => setDoor(d.id)}
              className={`px-4 py-2 text-sm font-semibold rounded-lg transition-colors ${active ? "bg-accent text-white shadow-sm" : "text-gray-600 hover:text-gray-900"}`}
            >
              {d.label}
            </button>
          );
        })}
      </div>
      <p className="text-sm text-gray-500 mb-3">{DOORS.find((d) => d.id === door)?.hint}</p>

      <div id={`door-panel-${door}`} role="tabpanel" aria-labelledby={`door-${door}`}>
        {door === "repo" ? (
          <form onSubmit={goRepo} className="flex flex-col sm:flex-row gap-3">
            <label htmlFor="repo-scan-input" className="sr-only">Repository URL</label>
            <input
              id="repo-scan-input"
              type="url"
              required
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="https://github.com/owner/repo — free, no signup"
              className="flex-1 min-w-0 rounded-2xl border border-black/10 bg-white px-5 py-4 text-base text-gray-900 placeholder:text-gray-400 shadow-sm focus:outline-none focus:ring-2 focus:ring-[#0f766e]/40"
            />
            <button type="submit" className="hero-cta rounded-2xl px-7 py-4 text-base font-semibold whitespace-nowrap">
              Scan my repo
            </button>
          </form>
        ) : door === "web" ? (
          <UrlScanFlow
            key={`web-${seed.nonce}`}
            suite="web"
            endpoint="/api/web/scan"
            streamEndpoint="/api/web/scan/stream"
            recommendEndpoint="/api/scan/recommend"
            placeholderUrl="https://yoursite.com — free preview, no signup"
            brandLabel="GateTest"
            initialUrl={seed.url}
          />
        ) : (
          <UrlScanFlow
            key={`wp-${seed.nonce}`}
            suite="wp"
            endpoint="/api/wp/scan"
            streamEndpoint="/api/wp/scan/stream"
            placeholderUrl="https://your-wordpress-site.com — free preview"
            brandLabel="GateTest"
            initialUrl={seed.url}
          />
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-gray-400 uppercase tracking-wider font-semibold">Try a sample</span>
        {SAMPLES[door].map((s) => (
          <button key={s.value} type="button" onClick={() => prefill(s.value)} className={PILL}>{s.label}</button>
        ))}
      </div>
    </div>
  );
}
