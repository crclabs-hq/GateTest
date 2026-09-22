'use strict';

// One definition of "what is this page's <title>" and "what is this page's
// meta description" — read from raw HTML text (source files, or a fetched
// page body). Both accept attributes in any order, extra attributes in
// between the ones being matched, and whitespace/newlines inside the tag or
// around the captured text. Case-insensitive throughout.
//
// #641 / #653: a bare `/<title>([^<]*)<\/title>/i` (or an order-sensitive
// `<meta name="description" content="...">` pattern) requires an
// attribute-free tag written in exactly one attribute order. Framework-
// rendered pages commonly emit `<title data-sm="...">` or
// `<title lang="en">`, and a meta tag can carry `id`/`data-*` attributes
// between `name` and `content` — none of that changes what the browser (or a
// search engine) treats as the page's title/description, so none of it
// should change what this scanner sees. `src/modules/live-crawler-http-helpers.js`
// (extractTitle, #641/#646) was the first fix for this bug class; this module
// is the one home for it, imported by the crawler, `src/modules/seo.js` and
// (duplicated, see `website/app/lib/html-extract.ts`) the website's quick
// URL scan.

// A <title> nested inside an inline <svg> (e.g. `<svg><title>Icon</title></svg>`,
// used for SVG accessibility text) is never the document's own title — strip
// svg regions before matching so one is never mistaken for the other.
const SVG_REGION_RE = /<svg\b[^>]*>[\s\S]*?<\/svg>/gi;

function stripSvgRegions(html) {
  return html.replace(SVG_REGION_RE, '');
}

// `[^>]*` (not `.*`) so attributes are matched without needing a `dotAll`
// flag, and `[\s\S]*?` (not `[^<]*`) so the captured text can itself span
// multiple lines without breaking on an embedded newline-adjacent `<`.
const TITLE_TAG_RE = /<title\b[^>]*>([\s\S]*?)<\/title>/i;

// Returns the RAW (untrimmed) text of the first non-svg <title> tag, or
// `undefined` if no such tag exists at all. Separate from `extractTitle()`
// so a caller that must distinguish "no <title> tag" from "a <title> tag
// that is empty/whitespace-only" (two different findings in `seo.js`) can.
function matchTitleTag(html) {
  const m = TITLE_TAG_RE.exec(stripSvgRegions(html));
  return m ? m[1] : undefined;
}

// Returns the trimmed title text, or `null` if there is no non-empty
// <title> — either no tag at all, or a tag whose content is blank. This is
// the crawler's original contract (`live-crawler-http-helpers.js`, #641):
// both cases are reported as "missing" and callers that don't need the
// finer distinction can treat `null` as one thing.
function extractTitle(html) {
  const raw = matchTitleTag(html);
  const text = raw === undefined ? '' : raw.trim();
  return text.length > 0 ? text : null;
}

// Matches a <meta name="description" content="..."> tag regardless of
// attribute order (`content` before `name`) or any other attribute sitting
// between the two (`<meta name="description" lang="en" content="...">`).
// Scoped to one <meta ...> tag at a time so a `name=` on one tag can never
// pair with a `content=` on another. Returns the RAW (untrimmed) content
// value, or `undefined` if no matching tag exists.
function matchMetaDescriptionTag(html) {
  const metaTagRe = /<meta\b[^>]*>/gi;
  let m;
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

// Returns the trimmed meta description text, or `null` if no
// `<meta name="description" content="...">` tag is present. A tag present
// with an empty `content=""` returns `''` (not `null`) — present-but-empty
// is a different finding from missing, same distinction as `matchTitleTag`.
function extractMetaDescription(html) {
  const raw = matchMetaDescriptionTag(html);
  return raw === undefined ? null : raw.trim();
}

module.exports = {
  extractTitle,
  extractMetaDescription,
  matchTitleTag,
  matchMetaDescriptionTag,
};
