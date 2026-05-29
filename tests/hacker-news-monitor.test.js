"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  monitor,
  searchHN,
  classifyIntent,
  draftResponse,
  aggregatePainPoints,
  normaliseHit,
  stripHtml,
  hitText,
  DEFAULT_QUERIES,
} = require("../website/app/lib/trainers/hacker-news-monitor.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockFetch(responsesByQuery) {
  return async (url) => {
    const m = url.match(/[?&]query=([^&]+)/);
    const query = m ? decodeURIComponent(m[1]) : "";
    const hits = responsesByQuery[query] || [];
    return {
      ok: true,
      status: 200,
      json: async () => ({ hits }),
    };
  };
}

function fixtureHit({ objectID, author = "alice", text, title, points = 10, comments = 0 } = {}) {
  return {
    objectID: objectID || `${Math.random()}`,
    author,
    comment_text: text,
    title,
    points,
    num_comments: comments,
    created_at: "2026-05-29T00:00:00Z",
    created_at_i: Math.floor(Date.now() / 1000) - 600,
  };
}

// ---------------------------------------------------------------------------
// Shape / utilities
// ---------------------------------------------------------------------------

test("stripHtml: removes tags and decodes common entities", () => {
  assert.equal(stripHtml('<p>hello <b>world</b> &quot;quoted&quot;</p>'), 'hello world "quoted"');
  assert.equal(stripHtml(null), "");
  assert.equal(stripHtml(undefined), "");
});

test("hitText: picks comment_text, then story_text, then title", () => {
  assert.equal(hitText({ comment_text: "<b>c</b>", title: "t" }), "c");
  assert.equal(hitText({ story_text: "<b>s</b>", title: "t" }), "s");
  assert.equal(hitText({ title: "<b>t</b>" }), "t");
});

test("normaliseHit: returns the expected shape", () => {
  const hit = normaliseHit({
    objectID: "123",
    author: "alice",
    comment_text: "<p>hello</p>",
    points: 5,
    num_comments: 3,
    created_at: "2026-01-01T00:00:00Z",
    created_at_i: 1735689600,
  });
  assert.equal(hit.objectId, "123");
  assert.equal(hit.author, "alice");
  assert.equal(hit.type, "comment");
  assert.equal(hit.text, "hello");
  assert.equal(hit.url, "https://news.ycombinator.com/item?id=123");
  assert.equal(hit.points, 5);
});

test("DEFAULT_QUERIES: includes gatetest, competitors, painPoints buckets", () => {
  assert.ok(Array.isArray(DEFAULT_QUERIES.gatetest));
  assert.ok(DEFAULT_QUERIES.gatetest.length > 0);
  assert.ok(DEFAULT_QUERIES.competitors.includes("Snyk"));
  assert.ok(DEFAULT_QUERIES.competitors.includes("SonarQube"));
  assert.ok(DEFAULT_QUERIES.painPoints.some((p) => p.includes("false positive")));
});

// ---------------------------------------------------------------------------
// Intent classification
// ---------------------------------------------------------------------------

test("classifyIntent: bug signals", () => {
  assert.equal(classifyIntent("This gave me an error when I tried to run it"), "bug");
  assert.equal(classifyIntent("Got a crash on startup"), "bug");
  assert.equal(classifyIntent("It's a false positive"), "bug");
  assert.equal(classifyIntent("This is broken"), "bug");
});

test("classifyIntent: feature-request signals", () => {
  assert.equal(classifyIntent("Would be nice if it supported python too"), "feature-request");
  assert.equal(classifyIntent("Wish it could handle monorepos"), "feature-request");
  assert.equal(classifyIntent("Can it support GitLab?"), "feature-request");
});

test("classifyIntent: criticism signals", () => {
  assert.equal(classifyIntent("This is overpriced for what you get"), "criticism");
  assert.equal(classifyIntent("I hate using this thing"), "criticism");
  assert.equal(classifyIntent("Worse than SonarQube honestly"), "criticism");
});

test("classifyIntent: question signals", () => {
  assert.equal(classifyIntent("How do I install this on a fresh repo?"), "question");
  assert.equal(classifyIntent("Does GateTest support TypeScript projects?"), "question");
  assert.equal(classifyIntent("Is it any good for large monorepos?"), "question");
});

test("classifyIntent: praise signals", () => {
  assert.equal(classifyIntent("I love this tool, saved me hours"), "praise");
  assert.equal(classifyIntent("Game-changer for our team"), "praise");
  assert.equal(classifyIntent("Worth every penny"), "praise");
});

test("classifyIntent: neutral when no signal matches", () => {
  assert.equal(classifyIntent("Random comment about the weather"), "neutral");
  assert.equal(classifyIntent(""), "neutral");
  assert.equal(classifyIntent(null), "neutral");
});

test("classifyIntent: bug wins over question when both signals present", () => {
  // "broken" (bug) is stronger than "how do I" (question) when both are in
  // the same comment — bug intent is checked first in INTENT_ORDER.
  assert.equal(classifyIntent("How do I fix this? It's broken"), "bug");
});

// ---------------------------------------------------------------------------
// Draft response composition
// ---------------------------------------------------------------------------

test("draftResponse: ALWAYS includes the DRAFT FOR CRAIG REVIEW banner", () => {
  for (const intent of ["bug", "feature-request", "criticism", "question", "praise", "neutral"]) {
    const resp = draftResponse({ author: "alice", text: "test", intent });
    assert.match(resp, /DRAFT FOR CRAIG REVIEW/);
    assert.match(resp, /DO NOT POST/);
  }
});

test("draftResponse: bug intent → asks for repo URL", () => {
  const r = draftResponse({ author: "bob", text: "false positive", intent: "bug" });
  assert.match(r, /@bob/);
  assert.match(r, /repo URL|repo url/i);
});

test("draftResponse: feature-request intent → points to GitHub issues", () => {
  const r = draftResponse({ author: "cathy", text: "wish it had X", intent: "feature-request" });
  assert.match(r, /github\.com\/crclabs-hq\/gatetest\/issues/);
});

test("draftResponse: criticism intent → mentions cheaper tiers", () => {
  const r = draftResponse({ author: "dan", text: "too expensive", intent: "criticism" });
  assert.match(r, /free CLI|\$29|Quick Scan/i);
});

test("draftResponse: handles missing author gracefully", () => {
  const r = draftResponse({ author: "unknown", text: "test", intent: "bug" });
  assert.doesNotMatch(r, /@unknown/);
  assert.match(r, /^\[DRAFT.+?\]\n.*Hi,/s);
});

// ---------------------------------------------------------------------------
// Pain-point aggregation
// ---------------------------------------------------------------------------

test("aggregatePainPoints: counts phrase occurrences and sorts by count", () => {
  const hits = [
    { text: "got a false positive", objectId: "1", url: "u1" },
    { text: "another false positive case", objectId: "2", url: "u2" },
    { text: "too slow to run", objectId: "3", url: "u3" },
    { text: "general happy comment", objectId: "4", url: "u4" },
  ];
  const result = aggregatePainPoints(hits, ["false positive", "too slow"]);
  assert.equal(result.length, 2);
  assert.equal(result[0].phrase, "false positive");
  assert.equal(result[0].count, 2);
  assert.equal(result[0].examples.length, 2);
  assert.equal(result[1].phrase, "too slow");
  assert.equal(result[1].count, 1);
});

test("aggregatePainPoints: caps examples at 3 per phrase", () => {
  const hits = Array.from({ length: 10 }, (_, i) => ({
    text: "false positive again",
    objectId: `${i}`,
    url: `u${i}`,
  }));
  const result = aggregatePainPoints(hits, ["false positive"]);
  assert.equal(result[0].count, 10);
  assert.equal(result[0].examples.length, 3);
});

test("aggregatePainPoints: phrase with regex meta-chars is escaped", () => {
  const hits = [{ text: "this is C++ specific", objectId: "1", url: "u1" }];
  const result = aggregatePainPoints(hits, ["C++"]);
  assert.equal(result[0].count, 1);
});

test("aggregatePainPoints: omits phrases with zero matches", () => {
  const hits = [{ text: "all good", objectId: "1", url: "u1" }];
  const result = aggregatePainPoints(hits, ["false positive", "too slow"]);
  assert.equal(result.length, 0);
});

// ---------------------------------------------------------------------------
// searchHN — HTTP layer
// ---------------------------------------------------------------------------

test("searchHN: missing query throws", async () => {
  await assert.rejects(searchHN({ _fetch: async () => ({}) }), TypeError);
});

test("searchHN: uses windowHours to compute the numericFilters cut-off", async () => {
  let capturedUrl;
  const _fetch = async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, json: async () => ({ hits: [] }) };
  };
  const now = 2_000_000_000_000;
  await searchHN({ query: "gatetest", windowHours: 12, _fetch, _now: () => now });
  assert.match(capturedUrl, /created_at_i%3E\d+/);
  // Verify the cut-off is roughly now - 12 hours
  const sinceMatch = capturedUrl.match(/created_at_i%3E(\d+)/);
  const since = Number(sinceMatch[1]);
  const expected = Math.floor((now - 12 * 3600_000) / 1000);
  assert.equal(since, expected);
});

test("searchHN: non-ok response returns empty hits + error", async () => {
  const _fetch = async () => ({ ok: false, status: 503 });
  const r = await searchHN({ query: "x", _fetch });
  assert.equal(r.hits.length, 0);
  assert.match(r.error, /503/);
});

test("searchHN: tags filter restricts to story + comment", async () => {
  let capturedUrl;
  const _fetch = async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, json: async () => ({ hits: [] }) };
  };
  await searchHN({ query: "x", _fetch });
  // URLSearchParams encodes parens
  assert.match(capturedUrl, /tags=%28story%2Ccomment%29/);
});

// ---------------------------------------------------------------------------
// monitor() — end-to-end with mocked fetch
// ---------------------------------------------------------------------------

test("monitor: returns report with gatetest mentions, competitor mentions, pain-points", async () => {
  const _fetch = makeMockFetch({
    "gatetest": [
      fixtureHit({ objectID: "1", text: "Tried GateTest, got a false positive on line 42" }),
    ],
    "gatetest.ai": [
      fixtureHit({ objectID: "2", text: "GateTest.ai looks promising, would love python support" }),
    ],
    "Snyk": [
      fixtureHit({ objectID: "3", text: "Snyk gave me too many false positives this month" }),
    ],
    "SonarQube": [],
    "Semgrep": [],
    "CodeQL": [],
    "DeepSource": [],
    "Codacy": [],
    "Veracode": [],
    "Checkmarx": [],
  });
  const report = await monitor({
    queries: {
      gatetest: ["gatetest", "gatetest.ai"],
      competitors: ["Snyk", "SonarQube", "Semgrep", "CodeQL", "DeepSource", "Codacy", "Veracode", "Checkmarx"],
      painPoints: ["false positive", "too slow"],
    },
    _fetch,
    _now: () => 1_700_000_000_000,
  });
  assert.ok(report);
  assert.equal(typeof report.generatedAt, "string");
  assert.equal(report.summary.gatetestMentions, 2);
  assert.equal(report.summary.competitorMentions.Snyk, 1);
  assert.ok(report.summary.painPointsFound >= 1);
  assert.ok(report.gatetestMentions[0].draftResponse);
  assert.match(report.gatetestMentions[0].draftResponse, /DRAFT FOR CRAIG/);
});

test("monitor: actionItems pulled from bug/criticism/feature-request mentions only", async () => {
  const _fetch = makeMockFetch({
    "gatetest": [
      fixtureHit({ objectID: "1", text: "GateTest game-changer for our team" }),   // praise — no action
      fixtureHit({ objectID: "2", text: "GateTest is broken, gave me an error" }), // bug — action
      fixtureHit({ objectID: "3", text: "GateTest is overpriced honestly" }),      // criticism — action
    ],
  });
  const report = await monitor({
    queries: { gatetest: ["gatetest"], competitors: [], painPoints: [] },
    _fetch,
  });
  assert.equal(report.summary.gatetestMentions, 3);
  assert.equal(report.actionItems.length, 2);
  const intents = report.actionItems.map((a) => a.intent).sort();
  assert.deepEqual(intents, ["bug", "criticism"]);
});

test("monitor: filters out hits where gatetest is NOT mentioned in the text", async () => {
  // HN may return hits for the query that don't literally include the
  // word in the text (matched on title only or fuzzy match). The
  // gatetest bucket should only count true mentions.
  const _fetch = makeMockFetch({
    "gatetest": [
      fixtureHit({ objectID: "1", text: "GateTest is great", title: null }),
      fixtureHit({ objectID: "2", text: "Talking about SonarQube only", title: null }),
    ],
  });
  const report = await monitor({
    queries: { gatetest: ["gatetest"], competitors: [], painPoints: [] },
    _fetch,
  });
  assert.equal(report.summary.gatetestMentions, 1);
  assert.equal(report.gatetestMentions[0].objectId, "1");
});

test("monitor: de-duplicates hits in summary totalUniqueHits", async () => {
  const sharedHit = fixtureHit({ objectID: "dup", text: "Both Snyk and SonarQube are fine" });
  const _fetch = makeMockFetch({
    "Snyk": [sharedHit],
    "SonarQube": [sharedHit],
    "gatetest": [],
  });
  const report = await monitor({
    queries: { gatetest: ["gatetest"], competitors: ["Snyk", "SonarQube"], painPoints: [] },
    _fetch,
  });
  // Both queries returned the same hit; unique count should be 1
  assert.equal(report.summary.totalUniqueHits, 1);
  // But each competitor bucket counts the hit independently
  assert.equal(report.summary.competitorMentions.Snyk, 1);
  assert.equal(report.summary.competitorMentions.SonarQube, 1);
});

test("monitor: never auto-posts — draftResponse banner is on every mention", async () => {
  const _fetch = makeMockFetch({
    "gatetest": Array.from({ length: 5 }, (_, i) =>
      fixtureHit({ objectID: `g${i}`, text: "GateTest comment", title: null })
    ),
  });
  const report = await monitor({
    queries: { gatetest: ["gatetest"], competitors: [], painPoints: [] },
    _fetch,
  });
  for (const m of report.gatetestMentions) {
    assert.match(m.draftResponse, /DRAFT FOR CRAIG REVIEW/);
    assert.match(m.draftResponse, /DO NOT POST/);
  }
});
