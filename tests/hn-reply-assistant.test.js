"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  resolveStoryId,
  flattenComments,
  pollForNewComments,
  fetchAuthorRecentComments,
  stripHtml,
} = require("../website/app/lib/hn-reply-assistant/watcher.js");

const {
  draftReply,
  composeSystemPrompt,
  composeUserPrompt,
  DRAFT_BANNER,
  MAX_VOICE_EXAMPLES,
} = require("../website/app/lib/hn-reply-assistant/drafter.js");

const {
  loadState,
  saveState,
  saveDraft,
  loadDraft,
  setDraftState,
  listDrafts,
  VALID_STATES,
} = require("../website/app/lib/hn-reply-assistant/queue-store.js");

// ---------------------------------------------------------------------------
// In-memory fs adapter
// ---------------------------------------------------------------------------

function makeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const dirs = new Set();
  function trackDirs(p) {
    let d = path.dirname(p);
    while (d && d !== "." && d !== "/") {
      dirs.add(d);
      d = path.dirname(d);
    }
  }
  for (const p of files.keys()) trackDirs(p);
  return {
    files,
    existsSync: (p) => files.has(p) || dirs.has(p),
    mkdirSync: (p) => { dirs.add(p); },
    readFileSync: (p) => {
      if (!files.has(p)) {
        const e = new Error("ENOENT " + p);
        e.code = "ENOENT";
        throw e;
      }
      return files.get(p);
    },
    writeFileSync: (p, data) => { files.set(p, data); trackDirs(p); },
    readdirSync: (p) => {
      const out = new Set();
      for (const f of files.keys()) {
        if (f.startsWith(p + "/") || f.startsWith(p + path.sep)) {
          const rest = f.slice(p.length + 1);
          out.add(rest.split(/[\\/]/)[0]);
        }
      }
      return Array.from(out);
    },
  };
}

// ---------------------------------------------------------------------------
// stripHtml + resolveStoryId
// ---------------------------------------------------------------------------

test("stripHtml: removes tags and decodes entities", () => {
  assert.equal(stripHtml("<p>hello <b>world</b></p>"), "hello world");
  assert.equal(stripHtml("&quot;quoted&quot;"), '"quoted"');
  assert.equal(stripHtml(null), "");
});

test("resolveStoryId: handles URL, numeric string, integer", () => {
  assert.equal(resolveStoryId("12345"), 12345);
  assert.equal(resolveStoryId(67890), 67890);
  assert.equal(resolveStoryId("https://news.ycombinator.com/item?id=42"), 42);
  assert.equal(resolveStoryId("not a url"), null);
  assert.equal(resolveStoryId(null), null);
  assert.equal(resolveStoryId(undefined), null);
});

// ---------------------------------------------------------------------------
// flattenComments
// ---------------------------------------------------------------------------

test("flattenComments: skips the root story, includes nested children", () => {
  const tree = {
    id: 1, title: "Show HN: X", author: "craig", text: null,
    children: [
      {
        id: 2, author: "alice", text: "<p>Looks cool</p>", created_at_i: 1000,
        children: [
          { id: 3, author: "craig", text: "<p>Thanks!</p>", created_at_i: 1100, children: [] },
        ],
      },
      {
        id: 4, author: "bob", text: "<p>Question about pricing</p>", created_at_i: 1200, children: [],
      },
    ],
  };
  const flat = flattenComments(tree);
  assert.equal(flat.length, 3);
  assert.equal(flat[0].author, "alice");
  assert.equal(flat[0].text, "Looks cool");
  assert.equal(flat[1].author, "craig");
  assert.equal(flat[1].parentAuthor, "alice");
  assert.equal(flat[2].author, "bob");
});

test("flattenComments: skips deleted comments (no text)", () => {
  const tree = {
    id: 1, text: null, children: [
      { id: 2, author: "[deleted]", text: null, children: [] },
      { id: 3, author: "carol", text: "<p>still here</p>", children: [] },
    ],
  };
  const flat = flattenComments(tree);
  assert.equal(flat.length, 1);
  assert.equal(flat[0].author, "carol");
});

// ---------------------------------------------------------------------------
// pollForNewComments
// ---------------------------------------------------------------------------

test("pollForNewComments: returns only NEW comments (delta against seenSet)", async () => {
  const tree = {
    id: 100, title: "Show HN", author: "craig", text: null,
    children: [
      { id: 1, author: "a", text: "first", created_at_i: 1, children: [] },
      { id: 2, author: "b", text: "second", created_at_i: 2, children: [] },
      { id: 3, author: "c", text: "third", created_at_i: 3, children: [] },
    ],
  };
  const _fetch = async () => ({ ok: true, status: 200, json: async () => tree });
  const seen = new Set([1, 2]);
  const r = await pollForNewComments({ storyId: 100, seenCommentIds: seen, _fetch });
  assert.equal(r.newComments.length, 1);
  assert.equal(r.newComments[0].id, 3);
  assert.equal(r.allCommentsCount, 3);
});

test("pollForNewComments: authorFilter only surfaces replies to the named author", async () => {
  const tree = {
    id: 100, author: "craig", text: null,
    children: [
      { id: 1, author: "a", text: "to craig", parent_id: 100, created_at_i: 1,
        children: [{ id: 2, author: "craig", text: "reply", created_at_i: 2, children: [] }] },
      { id: 3, author: "b", text: "to a",     created_at_i: 3, children: [] },
    ],
  };
  // The root has author=craig so child id=1's parentAuthor=craig (matches filter).
  // Child id=2's parentAuthor=a (does not match). Child id=3's parentAuthor=craig
  // (matches filter; sibling of id=1).
  const _fetch = async () => ({ ok: true, status: 200, json: async () => tree });
  const r = await pollForNewComments({
    storyId: 100,
    authorFilter: "craig",
    _fetch,
  });
  const ids = r.newComments.map((c) => c.id).sort();
  assert.deepEqual(ids, [1, 3]);
});

test("pollForNewComments: HN API error surfaces gracefully", async () => {
  const _fetch = async () => ({ ok: false, status: 503 });
  const r = await pollForNewComments({ storyId: 1, _fetch });
  assert.equal(r.newComments.length, 0);
  assert.match(r.error, /503/);
});

// ---------------------------------------------------------------------------
// fetchAuthorRecentComments
// ---------------------------------------------------------------------------

test("fetchAuthorRecentComments: returns text + timestamps, filters very short ones", async () => {
  const _fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({
      hits: [
        { objectID: "1", comment_text: "<p>This is a substantive comment about software</p>", created_at_i: 1000 },
        { objectID: "2", comment_text: "<p>ok</p>", created_at_i: 1100 }, // too short → filtered
        { objectID: "3", comment_text: "<p>Another reasonably long take on Node performance</p>", created_at_i: 1200 },
      ],
    }),
  });
  const r = await fetchAuthorRecentComments({ author: "alice", _fetch });
  assert.equal(r.length, 2);
  assert.equal(r[0].objectId, "1");
});

test("fetchAuthorRecentComments: requires author", async () => {
  await assert.rejects(fetchAuthorRecentComments({}), TypeError);
});

test("fetchAuthorRecentComments: API failure returns []", async () => {
  const r = await fetchAuthorRecentComments({
    author: "x",
    _fetch: async () => ({ ok: false, status: 500 }),
  });
  assert.deepEqual(r, []);
});

// ---------------------------------------------------------------------------
// composeSystemPrompt
// ---------------------------------------------------------------------------

test("composeSystemPrompt: includes Craig's voice examples", () => {
  const prompt = composeSystemPrompt({
    voiceExamples: [
      { text: "We built this on weekends. Tests are at /tests." },
      { text: "Honest answer: CodeQL beats us on multi-hop taint." },
    ],
  });
  assert.match(prompt, /McCracken49/);
  assert.match(prompt, /weekends/);
  assert.match(prompt, /CodeQL beats us/);
});

test("composeSystemPrompt: caps voice examples at MAX_VOICE_EXAMPLES", () => {
  const examples = Array.from({ length: 20 }, (_, i) => ({ text: `example ${i}` }));
  const prompt = composeSystemPrompt({ voiceExamples: examples });
  // Should include first MAX_VOICE_EXAMPLES, not all 20
  assert.match(prompt, new RegExp(`example ${MAX_VOICE_EXAMPLES - 1}`));
  assert.doesNotMatch(prompt, /example 15/);
});

test("composeSystemPrompt: includes honest limitations", () => {
  const prompt = composeSystemPrompt({});
  assert.match(prompt, /CodeQL/);
  assert.match(prompt, /Mutation testing/);
});

// ---------------------------------------------------------------------------
// composeUserPrompt
// ---------------------------------------------------------------------------

test("composeUserPrompt: includes new comment + parent context", () => {
  const prompt = composeUserPrompt({
    comment: {
      id: 42,
      author: "alice",
      text: "How does this compare to Snyk?",
      parentText: "Show HN body text here",
      parentAuthor: "craig",
    },
  });
  assert.match(prompt, /alice/);
  assert.match(prompt, /Snyk/);
  assert.match(prompt, /Show HN body text/);
});

test("composeUserPrompt: handles missing parent gracefully", () => {
  const prompt = composeUserPrompt({
    comment: { id: 1, author: "x", text: "first reply" },
  });
  assert.match(prompt, /first reply/);
  assert.doesNotMatch(prompt, /Parent comment by/);
});

// ---------------------------------------------------------------------------
// draftReply
// ---------------------------------------------------------------------------

test("draftReply: ALWAYS prefixes with the DRAFT banner", async () => {
  const r = await draftReply({
    comment: { id: 1, author: "alice", text: "test comment with enough length" },
    _anthropicCall: async () => ({ text: "This is the body of the reply", model: "test" }),
  });
  assert.ok(r.draft.startsWith(DRAFT_BANNER));
  assert.match(r.draft, /This is the body of the reply/);
});

test("draftReply: passes voice examples + product context through", async () => {
  let capturedSystem;
  await draftReply({
    comment: { id: 1, author: "a", text: "test comment with enough length" },
    voiceExamples: [{ text: "voice sample" }],
    productContext: { productName: "FlavorTest" },
    _anthropicCall: async ({ systemPrompt }) => {
      capturedSystem = systemPrompt;
      return { text: "ok", model: "test" };
    },
  });
  assert.match(capturedSystem, /voice sample/);
  assert.match(capturedSystem, /FlavorTest/);
});

test("draftReply: throws on invalid comment", async () => {
  await assert.rejects(
    draftReply({ comment: {} }),
    TypeError
  );
});

// ---------------------------------------------------------------------------
// queue-store
// ---------------------------------------------------------------------------

test("loadState: returns defaults when no state file", () => {
  const fs = makeFs({});
  const state = loadState({ queueDir: "/q", _fs: fs });
  assert.deepEqual(state.seenCommentIds, []);
  assert.equal(state.lastPollUnix, null);
});

test("saveState + loadState: round-trip", () => {
  const fs = makeFs({});
  saveState({ queueDir: "/q", state: { seenCommentIds: [1, 2, 3], lastPollUnix: 1000 }, _fs: fs });
  const got = loadState({ queueDir: "/q", _fs: fs });
  assert.deepEqual(got.seenCommentIds, [1, 2, 3]);
  assert.equal(got.lastPollUnix, 1000);
});

test("saveDraft: defaults state to pending", () => {
  const fs = makeFs({});
  const rec = saveDraft({
    queueDir: "/q",
    draftRecord: {
      draft: "[DRAFT] hello",
      comment: { id: 42, author: "alice" },
    },
    _fs: fs,
  });
  assert.equal(rec.state, "pending");
  assert.ok(rec.draftedAt);
});

test("saveDraft: invalid state throws", () => {
  const fs = makeFs({});
  assert.throws(() => saveDraft({
    queueDir: "/q",
    draftRecord: { state: "weird", draft: "x", comment: { id: 1 } },
    _fs: fs,
  }), TypeError);
});

test("setDraftState: transitions persist", () => {
  const fs = makeFs({});
  saveDraft({
    queueDir: "/q",
    draftRecord: { draft: "x", comment: { id: 7 } },
    _fs: fs,
  });
  const r = setDraftState({ queueDir: "/q", commentId: 7, state: "approved", _fs: fs });
  assert.equal(r.state, "approved");
  const reloaded = loadDraft({ queueDir: "/q", commentId: 7, _fs: fs });
  assert.equal(reloaded.state, "approved");
});

test("setDraftState: invalid state throws", () => {
  const fs = makeFs({});
  assert.throws(() => setDraftState({ queueDir: "/q", commentId: 1, state: "bogus", _fs: fs }), TypeError);
});

test("listDrafts: returns all drafts, filterable by state", () => {
  const fs = makeFs({});
  for (let i = 1; i <= 3; i++) {
    saveDraft({
      queueDir: "/q",
      draftRecord: { draft: `draft ${i}`, comment: { id: i }, state: i === 2 ? "approved" : "pending" },
      _fs: fs,
    });
  }
  assert.equal(listDrafts({ queueDir: "/q", _fs: fs }).length, 3);
  assert.equal(listDrafts({ queueDir: "/q", stateFilter: "pending", _fs: fs }).length, 2);
  assert.equal(listDrafts({ queueDir: "/q", stateFilter: "approved", _fs: fs }).length, 1);
});

test("VALID_STATES: covers the 4-state machine", () => {
  assert.ok(VALID_STATES.has("pending"));
  assert.ok(VALID_STATES.has("approved"));
  assert.ok(VALID_STATES.has("posted"));
  assert.ok(VALID_STATES.has("skipped"));
  assert.equal(VALID_STATES.size, 4);
});
