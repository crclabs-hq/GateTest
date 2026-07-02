/**
 * Shared SVG badge rendering — shields.io-style badges for README embeds.
 *
 * Extracted from the pre-existing api/badge/[repo]/route.ts (which had its
 * own copy of scoreToGrade + a 2-segment renderBadge) so /badge/:owner/:repo
 * doesn't duplicate the grade-color scale a third time.
 */

export interface GradeInfo {
  letter: string;
  color: string;
  bgColor: string;
}

export function scoreToGrade(score: number): GradeInfo {
  if (score >= 95) return { letter: "A+", color: "#fff", bgColor: "#059669" };
  if (score >= 90) return { letter: "A", color: "#fff", bgColor: "#059669" };
  if (score >= 85) return { letter: "A-", color: "#fff", bgColor: "#10b981" };
  if (score >= 80) return { letter: "B+", color: "#fff", bgColor: "#0d9488" };
  if (score >= 75) return { letter: "B", color: "#fff", bgColor: "#0891b2" };
  if (score >= 70) return { letter: "B-", color: "#fff", bgColor: "#2563eb" };
  if (score >= 65) return { letter: "C+", color: "#fff", bgColor: "#7c3aed" };
  if (score >= 60) return { letter: "C", color: "#fff", bgColor: "#9333ea" };
  if (score >= 55) return { letter: "C-", color: "#fff", bgColor: "#c026d3" };
  if (score >= 50) return { letter: "D+", color: "#fff", bgColor: "#d97706" };
  if (score >= 40) return { letter: "D", color: "#fff", bgColor: "#ea580c" };
  if (score >= 30) return { letter: "D-", color: "#fff", bgColor: "#dc2626" };
  return { letter: "F", color: "#fff", bgColor: "#991b1b" };
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface BadgeSegment {
  text: string;
  bg: string;
  fg?: string;
}

/**
 * Renders an N-segment shields.io-style badge (first segment is always the
 * grey label; the rest are caller-supplied value segments). Used for
 * "GateTest | B | 4 issues · 3d ago" (grade + issue count + last-scan-date
 * in one glance) rather than burying two of the three requested metrics in
 * a hover-only tooltip.
 */
export function renderBadge(segments: BadgeSegment[], ariaLabel: string): string {
  const widths = segments.map((s) => escapeXml(s.text).length * 6.8 + 14);
  const totalWidth = widths.reduce((a, b) => a + b, 0);

  let x = 0;
  const rects = segments.map((s, i) => {
    const rect = `<rect x="${x}" width="${widths[i]}" height="20" fill="${s.bg}"/>`;
    x += widths[i];
    return rect;
  });

  x = 0;
  const texts = segments.map((s, i) => {
    const cx = x + widths[i] / 2;
    x += widths[i];
    const fg = s.fg || "#fff";
    const label = escapeXml(s.text);
    return `<text aria-hidden="true" x="${cx}" y="15" fill="#010101" fill-opacity=".3">${label}</text>` +
      `<text x="${cx}" y="14" fill="${fg}">${label}</text>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${escapeXml(ariaLabel)}">
  <title>${escapeXml(ariaLabel)}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${totalWidth}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    ${rects.join("\n    ")}
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11" text-anchor="middle">
    ${texts.join("\n    ")}
  </g>
</svg>`;
}

/** "3d ago" / "2h ago" / "just now" — compact, badge-width-friendly relative time. */
export function relativeTimeShort(iso: string | Date): string {
  const then = typeof iso === "string" ? new Date(iso) : iso;
  const diffMs = Date.now() - then.getTime();
  if (diffMs < 0) return "just now";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}
