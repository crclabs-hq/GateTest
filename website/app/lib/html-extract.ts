// DUPLICATE — source of truth is `src/core/html-extract.js`.
//
// Turbopack locks the website to its own directory tree
// (next.config.ts: turbopack.root; see the same note in
// mutation-driven-test-strengthener.js), and no website `.ts` file imports
// directly from `src/core/*` today — every existing bridge to `src/core/`
// is a plain `.js` wrapper (`module.exports = require('../../../src/core/...')`)
// consumed from other `.js` files, not from TypeScript. Rather than be the
// first `.ts` file to reach across that boundary, these two functions are
// duplicated here per #653. Keep them byte-for-byte equivalent to
// `src/core/html-extract.js` (`extractTitle` / `extractMetaDescription`) —
// `tests/website-html-extract-parity.test.js` diffs the two on a fixed set
// of cases and fails the suite if they drift.
//
// Both accept attributes in any order, whitespace/newlines inside the tag,
// and are case-insensitive; a <title> nested inside <svg>...</svg> is
// ignored (it is SVG accessibility text, not the document's title).

const SVG_REGION_RE = /<svg\b[^>]*>[\s\S]*?<\/svg>/gi;

function stripSvgRegions(html: string): string {
  return html.replace(SVG_REGION_RE, "");
}

const TITLE_TAG_RE = /<title\b[^>]*>([\s\S]*?)<\/title>/i;

/** Raw (untrimmed) text of the first non-svg <title> tag, or `undefined` if none exists. */
export function matchTitleTag(html: string): string | undefined {
  const m = TITLE_TAG_RE.exec(stripSvgRegions(html));
  return m ? m[1] : undefined;
}

/** Trimmed title text, or `null` if there is no non-empty <title>. */
export function extractTitle(html: string): string | null {
  const raw = matchTitleTag(html);
  const text = (raw === undefined ? "" : raw).trim();
  return text.length > 0 ? text : null;
}

/**
 * Raw (untrimmed) content= value of a <meta name="description" ...> tag,
 * regardless of attribute order or any attribute sitting between `name`
 * and `content`. Returns `undefined` if no such tag exists.
 */
export function matchMetaDescriptionTag(html: string): string | undefined {
  const metaTagRe = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = metaTagRe.exec(html)) !== null) {
    const tag = m[0];
    const nameMatch = tag.match(/\bname\s*=\s*["']\s*description\s*["']/i);
    if (!nameMatch) continue;
    const contentMatch = tag.match(/\bcontent\s*=\s*["']([\s\S]*?)["']/i);
    if (!contentMatch) continue;
    return contentMatch[1];
  }
  return undefined;
}

/** Trimmed meta description text, or `null` if no matching tag is present. */
export function extractMetaDescription(html: string): string | null {
  const raw = matchMetaDescriptionTag(html);
  return raw === undefined ? null : raw.trim();
}
