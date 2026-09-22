import type { Metadata } from "next";
import "./preview.css";

/**
 * /preview — homepage v2, reviewed live before it replaces /.
 *
 * The page is the pipeline: a rail down the left (push → gate → findings →
 * fix → merge) lights as the reader scrolls, the hero replays a real scan
 * ending in exit 1, the corpus chart is drawn from precision.json, and every
 * count comes from site-stats.json. Graphite dark edge to edge: the site's
 * own dark tokens are switched on for this route so the shared header and
 * footer follow. No new dependencies; motion is CSS + one state machine and
 * stops under prefers-reduced-motion.
 */
export const metadata: Metadata = {
  title: "GateTest — CI quality gate for AI-written code",
  description:
    "Deterministic checks in one CI gate. Fails on the diff, not the backlog. Precision published on pinned third-party repos. Optional fix PR with a regression test. Pay per run.",
  robots: { index: false, follow: false },
};

// Switch the site's opt-in dark tokens on for this route before first paint.
// Inline so it runs while the document is still parsing; nothing else on the
// page depends on JavaScript having loaded.
const THEME_SCRIPT = `document.documentElement.setAttribute('data-theme','dark');`;

export default function PreviewLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      <div className="gt-v2">{children}</div>
    </>
  );
}
