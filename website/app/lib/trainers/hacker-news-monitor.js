/**
 * Hacker News monitor — trainer #7 in the GateTest flywheel.
 *
 * Craig 2026-05-29:
 *   "we have a place on the flywheel for HN which monitors everything and
 *    we do a daily feedback so we can be the biggest painkiller... especially
 *    if this platform is mentioned we address the problem and then we answer
 *    to HN responses."
 *
 * What it does
 * ------------
 *   1. Searches Hacker News (via the public Algolia search API) for:
 *      - Direct mentions of GateTest / gatetest.ai
 *      - Mentions of competitors (Snyk, SonarQube, Semgrep, CodeQL,
 *        DeepSource, ESLint, Codacy)
 *      - Pain-point phrases in QA / SAST / CI tooling
 *        ("false positive", "too slow", "expensive", "missing", "hate")
 *   2. Classifies each GateTest mention into one of five intent buckets:
 *      bug / feature-request / criticism / question / praise
 *   3. For every GateTest mention, drafts a candidate response **clearly
 *      marked DRAFT FOR CRAIG REVIEW** — we never auto-post anywhere.
 *   4. Aggregates competitor pain-points so we can spot opportunities
 *      ("Snyk users complaining about lockfile false positives" =>
 *      promote our handling of that case).
 *   5. Returns a structured report. The flywheel's nightly workflow
 *      writes the report to `~/.gatetest/trainers/hacker-news-latest.json`
 *      and (when wired in) opens a draft PR for Craig's review.
 *
 * Boss-Rule respect
 * -----------------
 *   - This module READS the public HN Algolia API. No auth, no PII,
 *     no rate-limit issues at our volume.
 *   - This module NEVER posts to HN. All "responses" are DRAFTS. The
 *     act of posting is Craig's call (Boss Rule #8 — brand/public
 *     comms).
 *   - The HTTP client is injectable so unit tests run offline; in
 *     production the global fetch is used.
 *   - Production wiring into the nightly cron is held until Craig
 *     explicitly OKs the third-party API integration (Boss Rule #7).
 */

"use strict";

const HN_ALGOLIA_BASE = "https://hn.algolia.com/api/v1/search_by_date";

// Queries we always run on the nightly sweep
const DEFAULT_QUERIES = {
  gatetest: ["gatetest", "gatetest.ai"],
  competitors: [
    "Snyk",
    "SonarQube",
    "Semgrep",
    "CodeQL",
    "DeepSource",
    "Codacy",
    "Veracode",
    "Checkmarx",
  ],
  painPoints: [
    "false positive",
    "false positives",
    "too slow",
    "too expensive",
    "doesn't work",
    "doesnt work",
    "broken CI",
    "blocked my push",
    "hate SonarQube",
    "hate Snyk",
    "linter is broken",
  ],
  ourCategory: [
    "static analysis tool",
    "SAST tool",
    "code review AI",
    "auto-fix PR",
    "AI code review",
    "developer painkiller",
  ],
};

// Keyword sets for intent classification. Order matters: we check most
// specific first, fall through to least specific.
const INTENT_SIGNALS = {
  bug: [
    /\bbug\b/i,
    /\bbroken\b/i,
    /\bfalse positive/i,
    /\bcrash/i,
    /\bdoesn'?t work\b/i,
    /\bgave me an error\b/i,
    /\bfails on\b/i,
  ],
  "feature-request": [
    /\bwish (it|gatetest|this) (could|did|supported|handled)\b/i,
    /\bcan it (do|support|handle)\b/i,
    /\bwould be (nice|great|cool) if\b/i,
    /\bneeds? to support\b/i,
    /\bmissing\b.{0,30}\bfeature\b/i,
  ],
  criticism: [
    /\boverpriced\b/i,
    /\btoo expensive\b/i,
    /\bI hate\b/i,
    /\bworse than\b/i,
    /\bdon'?t recommend\b/i,
    /\bnot impressed\b/i,
    /\bmoney grab\b/i,
  ],
  question: [
    /^\s*how (do|does|can)\b/im,
    /\bcan someone explain\b/i,
    /\bdoes gatetest\b.{0,50}\?/i,
    /\bany experience with\b/i,
    /\bis (it|gatetest) (any )?good\b/i,
  ],
  praise: [
    /\blove (it|this|gatetest)\b/i,
    /\bsaved (me|us|my)\b/i,
    /\bgame[- ]changer\b/i,
    /\bbest (sast|linter|code review)\b/i,
    /\bgreat (tool|product)\b/i,
    /\bworth (it|every penny)\b/i,
  ],
};

const INTENT_ORDER = ["bug", "criticism", "feature-request", "question", "praise"];

// ---------------------------------------------------------------------------
// HN Algolia search
// ---------------------------------------------------------------------------

/**
 * Run a single search query against the HN Algolia API.
 *
 * @param {object} args
 * @param {string} args.query                 search query string
 * @param {number} [args.windowHours=24]      look-back window from now
 * @param {function} [args._fetch]            injectable fetch for tests
 * @param {function} [args._now]              injectable Date.now for tests
 * @param {number} [args.hitsPerPage=50]      capped at 1000 by HN
 * @returns {Promise<{ hits: Array<object>, queryUsed: string }>}
 */
async function searchHN({
  query,
  windowHours = 24,
  _fetch,
  _now,
  hitsPerPage = 50,
} = {}) {
  if (!query || typeof query !== "string") {
    throw new TypeError("searchHN: query is required");
  }
  const fetchImpl = _fetch || (typeof fetch === "function" ? fetch : null);
  if (!fetchImpl) {
    throw new Error("searchHN: no fetch available; pass _fetch for tests");
  }
  const now = _now ? _now() : Date.now();
  const sinceUnix = Math.floor((now - windowHours * 3600_000) / 1000);
  const params = new URLSearchParams({
    query,
    hitsPerPage: String(Math.min(hitsPerPage, 1000)),
    numericFilters: `created_at_i>${sinceUnix}`,
    tags: "(story,comment)",
  });
  const url = `${HN_ALGOLIA_BASE}?${params.toString()}`;
  const res = await fetchImpl(url);
  if (!res || !res.ok) {
    return { hits: [], queryUsed: url, error: `HN API returned ${res ? res.status : "no response"}` };
  }
  const data = await res.json();
  const hits = Array.isArray(data.hits) ? data.hits : [];
  return { hits, queryUsed: url };
}

// ---------------------------------------------------------------------------
// Intent classification
// ---------------------------------------------------------------------------

/**
 * Classify a mention's intent based on its body text.
 * Returns the strongest-matching intent or "neutral" if nothing matches.
 *
 * @param {string} text
 * @returns {"bug" | "criticism" | "feature-request" | "question" | "praise" | "neutral"}
 */
function classifyIntent(text) {
  if (!text || typeof text !== "string") return "neutral";
  for (const intent of INTENT_ORDER) {
    const signals = INTENT_SIGNALS[intent];
    for (const re of signals) {
      if (re.test(text)) return intent;
    }
  }
  return "neutral";
}

// ---------------------------------------------------------------------------
// Hit normalisation
// ---------------------------------------------------------------------------

/**
 * Strip HTML tags from an HN comment body (Algolia returns HTML).
 */
function stripHtml(s) {
  if (!s || typeof s !== "string") return "";
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pick the best text field for a hit (stories have title, comments have
 * comment_text, story-text stories have story_text).
 */
function hitText(hit) {
  if (!hit) return "";
  const raw = hit.comment_text || hit.story_text || hit.title || "";
  return stripHtml(raw);
}

function normaliseHit(hit) {
  return {
    objectId: hit.objectID || null,
    author: hit.author || "unknown",
    type: hit.comment_text ? "comment" : "story",
    title: hit.title ? stripHtml(hit.title) : null,
    text: hitText(hit),
    url: hit.url || (hit.objectID ? `https://news.ycombinator.com/item?id=${hit.objectID}` : null),
    points: typeof hit.points === "number" ? hit.points : null,
    numComments: typeof hit.num_comments === "number" ? hit.num_comments : null,
    storyId: hit.story_id || null,
    createdAt: hit.created_at || null,
    createdAtUnix: typeof hit.created_at_i === "number" ? hit.created_at_i : null,
  };
}

// ---------------------------------------------------------------------------
// Drafting candidate responses (NEVER posted automatically)
// ---------------------------------------------------------------------------

/**
 * Compose a DRAFT response for Craig's review. Tone is professional,
 * acknowledges the issue, offers concrete action. Always returns text
 * with a `DRAFT FOR CRAIG REVIEW — DO NOT POST` banner so nothing
 * leaks unreviewed.
 *
 * @param {object} mention   normalised hit + intent
 * @returns {string}
 */
function draftResponse(mention) {
  const banner = "[DRAFT FOR CRAIG REVIEW — DO NOT POST]";
  const handle = mention.author && mention.author !== "unknown" ? `@${mention.author}` : "Hi";
  let body;
  switch (mention.intent) {
    case "bug":
      body = `${handle}, thanks for flagging this — we'd like to dig in. ` +
        `If you can share a repo URL (or even just the module that fired falsely), we'll ship the fix in the next release. ` +
        `In the meantime you can suppress this rule on the offending line with a per-line marker (see docs).`;
      break;
    case "feature-request":
      body = `${handle}, we're tracking this. Would you mind opening a GitHub issue at ` +
        `https://github.com/crclabs-hq/gatetest/issues so the request lands in our public backlog? ` +
        `If we can replicate it from a small example we usually ship in days, not weeks.`;
      break;
    case "criticism":
      body = `${handle}, that's fair feedback. We hear "too expensive" specifically about the higher tiers; ` +
        `we have a free CLI and a $29 Quick Scan tier so you can try every check before any meaningful spend. ` +
        `If you can share the specific friction we'd like to fix it.`;
      break;
    case "question":
      body = `${handle}, happy to help. Short version: ${mention.text.slice(0, 60)}... — ` +
        `the long version is in the docs at https://gatetest.ai. Want a more specific answer? ` +
        `Drop the exact use case and we'll come back with a concrete walk-through.`;
      break;
    case "praise":
      body = `${handle}, really appreciated. If there's anything you wish we did differently, ` +
        `that's the feedback that makes the next sprint sharper.`;
      break;
    default:
      body = `${handle}, thanks for engaging with the thread. If there's specific friction ` +
        `with GateTest we'd love to hear about it directly — hello@gatetest.ai.`;
  }
  return `${banner}\n${body}`;
}

// ---------------------------------------------------------------------------
// Pain-point aggregation
// ---------------------------------------------------------------------------

/**
 * Count occurrences of each pain-point phrase across hits. Useful for
 * spotting competitor-customer dissatisfaction we could exploit.
 *
 * @param {Array<object>} hits   normalised hits
 * @param {Array<string>} painPoints  phrases to count
 * @returns {Array<{ phrase: string, count: number, examples: Array<object> }>}
 */
function aggregatePainPoints(hits, painPoints) {
  const result = [];
  for (const phrase of painPoints) {
    const re = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const examples = [];
    let count = 0;
    for (const hit of hits) {
      if (re.test(hit.text)) {
        count += 1;
        if (examples.length < 3) examples.push({ objectId: hit.objectId, url: hit.url, snippet: hit.text.slice(0, 200) });
      }
    }
    if (count > 0) result.push({ phrase, count, examples });
  }
  result.sort((a, b) => b.count - a.count);
  return result;
}

// ---------------------------------------------------------------------------
// Main entry: monitor()
// ---------------------------------------------------------------------------

/**
 * Run the full HN monitor sweep and return a structured report.
 *
 * @param {object} args
 * @param {object} [args.queries=DEFAULT_QUERIES]
 * @param {number} [args.windowHours=24]
 * @param {function} [args._fetch]
 * @param {function} [args._now]
 * @returns {Promise<object>}  the daily report
 */
async function monitor({
  queries = DEFAULT_QUERIES,
  windowHours = 24,
  _fetch,
  _now,
} = {}) {
  const now = _now ? _now() : Date.now();
  const gatetestHits = [];
  const competitorHits = {};
  const allHits = [];

  for (const q of queries.gatetest || []) {
    const { hits } = await searchHN({ query: q, windowHours, _fetch, _now });
    for (const raw of hits) {
      const hit = normaliseHit(raw);
      const text = hit.text.toLowerCase();
      if (text.includes("gatetest")) {
        const intent = classifyIntent(hit.text);
        gatetestHits.push({
          ...hit,
          intent,
          draftResponse: draftResponse({ ...hit, intent }),
        });
        allHits.push(hit);
      }
    }
  }

  for (const competitor of queries.competitors || []) {
    const { hits } = await searchHN({ query: competitor, windowHours, _fetch, _now });
    competitorHits[competitor] = [];
    for (const raw of hits) {
      const hit = normaliseHit(raw);
      const intent = classifyIntent(hit.text);
      competitorHits[competitor].push({ ...hit, intent });
      allHits.push(hit);
    }
  }

  const painPointAggregation = aggregatePainPoints(allHits, queries.painPoints || []);

  // De-duplicate hits before counting (a single comment can match
  // multiple queries; aggregate metrics should count it once).
  const dedupedHits = new Map();
  for (const h of allHits) {
    if (h.objectId) dedupedHits.set(h.objectId, h);
  }

  return {
    generatedAt: new Date(now).toISOString(),
    windowHours,
    summary: {
      totalUniqueHits: dedupedHits.size,
      gatetestMentions: gatetestHits.length,
      competitorMentions: Object.fromEntries(
        Object.entries(competitorHits).map(([k, v]) => [k, v.length])
      ),
      painPointsFound: painPointAggregation.length,
    },
    gatetestMentions: gatetestHits,
    competitorMentions: competitorHits,
    painPoints: painPointAggregation,
    // Action items are derived: every bug + criticism mention becomes
    // an action item for Craig's review.
    actionItems: gatetestHits
      .filter((m) => m.intent === "bug" || m.intent === "criticism" || m.intent === "feature-request")
      .map((m) => ({
        intent: m.intent,
        url: m.url,
        snippet: m.text.slice(0, 200),
        suggestedDraftResponse: m.draftResponse,
      })),
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering — same contract as the other trainers
// ---------------------------------------------------------------------------

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Hacker News monitor');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt} · window: last ${report.windowHours}h`);
  lines.push('');
  const s = report.summary || {};
  lines.push(`- **GateTest mentions:** ${s.gatetestMentions || 0}`);
  lines.push(`- **Unique hits scanned:** ${s.totalUniqueHits || 0}`);
  lines.push(`- **Competitor pain-points found:** ${s.painPointsFound || 0}`);
  lines.push('');

  if ((report.actionItems || []).length > 0) {
    lines.push('## Action items (drafts — FOR CRAIG REVIEW, never auto-posted)');
    lines.push('');
    for (const a of report.actionItems) {
      lines.push(`### ${a.intent} — ${a.url}`);
      lines.push('');
      lines.push(`> ${a.snippet.replace(/\n/g, ' ')}`);
      lines.push('');
      lines.push(`**Suggested draft:** ${a.suggestedDraftResponse}`);
      lines.push('');
    }
  } else {
    lines.push('_No GateTest bug / criticism / feature-request mentions in this window._');
    lines.push('');
  }

  const competitors = Object.entries(s.competitorMentions || {}).filter(([, n]) => n > 0);
  if (competitors.length > 0) {
    lines.push('## Competitor mention volume');
    lines.push('');
    lines.push('| Competitor | Mentions |');
    lines.push('| --- | --- |');
    for (const [name, n] of competitors) lines.push(`| ${name} | ${n} |`);
    lines.push('');
  }

  if ((report.painPoints || []).length > 0) {
    lines.push('## Aggregated pain-points (opportunity signals)');
    lines.push('');
    for (const p of report.painPoints.slice(0, 10)) {
      lines.push(`- **${p.painPoint || p.phrase || 'unknown'}** — ${p.count || p.hits?.length || 0} hits`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI entrypoint — mirrors the other trainers: print markdown to stdout,
// write the JSON report to ~/.gatetest/trainers/hacker-news-latest.json.
// Wired into trainer-nightly.yml + `gatetest train` per Craig's Boss Rule #7
// authorization 2026-06-12 (read-only HN Algolia API; drafts never posted).
// ---------------------------------------------------------------------------

async function main() {
  const report = await monitor();
  // eslint-disable-next-line no-console
  console.log(renderMarkdown(report)); // code-quality-ok — CLI trainer prints markdown report to stdout
  // eslint-disable-next-line global-require
  const fs = require('fs');
  // eslint-disable-next-line global-require
  const os = require('os');
  // eslint-disable-next-line global-require
  const path = require('path');
  const outDir = path.join(os.homedir(), '.gatetest', 'trainers');
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'hacker-news-latest.json'), JSON.stringify(report, null, 2));
  } catch { /* best-effort */ }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[hacker-news-monitor] fatal: ${err && err.message}\n`);
    process.exit(0);
  });
}

module.exports = {
  monitor,
  renderMarkdown,
  searchHN,
  classifyIntent,
  draftResponse,
  aggregatePainPoints,
  normaliseHit,
  stripHtml,
  hitText,
  DEFAULT_QUERIES,
  INTENT_SIGNALS,
};
