/**
 * HN reply assistant — thread watcher.
 *
 * Polls the HN Algolia API for new comments on a specific submission
 * (a "Show HN" post) and returns the new ones since the last poll.
 *
 * Endpoints used (all free, no auth, no rate-limit at our volume):
 *   - Item tree:       https://hn.algolia.com/api/v1/items/<id>
 *   - Item via search: https://hn.algolia.com/api/v1/search_by_date?tags=comment,story_<id>
 *
 * Approach: tree-walk the recursive `children` array, flatten to a list
 * of comments, compare against the set of IDs we've already seen. New
 * IDs become the return value; the caller updates the seen-set.
 *
 * The watcher is pure logic — fetch is injectable for tests. Production
 * uses Node's global fetch.
 */

"use strict";

const HN_ITEM_BASE = "https://hn.algolia.com/api/v1/items";
const HN_SEARCH_BASE = "https://hn.algolia.com/api/v1/search_by_date";

/**
 * Fetch the full comment tree for a story.
 *
 * @param {object} args
 * @param {number|string} args.storyId
 * @param {function} [args._fetch]
 * @returns {Promise<{ story: object, error?: string }>}
 */
async function fetchStoryTree({ storyId, _fetch }) {
  if (!storyId) throw new TypeError("storyId is required");
  const fetchImpl = _fetch || (typeof fetch === "function" ? fetch : null);
  if (!fetchImpl) throw new Error("no fetch available; pass _fetch for tests");
  const url = `${HN_ITEM_BASE}/${storyId}`;
  try {
    const res = await fetchImpl(url);
    if (!res || !res.ok) {
      return { story: null, error: `HN API returned ${res ? res.status : "no response"}` };
    }
    return { story: await res.json() };
  } catch (err) {
    return { story: null, error: err.message || String(err) };
  }
}

/**
 * Flatten a recursive HN comment tree into a list, oldest-first by
 * created_at_i. Skips items where text is null/empty (deleted).
 *
 * @param {object} node      root story or comment
 * @param {object} [parent]  parent context (used to thread author into child)
 * @returns {Array<object>}  flat list of comments
 */
function flattenComments(node, parent = null) {
  const out = [];
  if (!node) return out;
  // The root story itself isn't a "comment" — only emit if depth > 0.
  if (parent !== null && node.text && node.author) {
    out.push({
      id: node.id,
      author: node.author,
      text: stripHtml(node.text),
      createdAtUnix: node.created_at_i || null,
      parentId: parent.id || null,
      parentAuthor: parent.author || null,
      parentText: parent.text ? stripHtml(parent.text).slice(0, 400) : null,
      storyId: node.story_id || parent.story_id || null,
    });
  }
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) {
    out.push(...flattenComments(child, node));
  }
  return out;
}

function stripHtml(s) {
  if (!s || typeof s !== "string") return "";
  return s
    .replace(/<p>/g, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/g, "/")
    .trim();
}

/**
 * Poll for new comments. Caller maintains the seen-set across polls.
 *
 * @param {object} args
 * @param {number|string} args.storyId
 * @param {Set<number>} [args.seenCommentIds]  ids previously surfaced
 * @param {string} [args.authorFilter]         only surface replies to this author
 *                                             (the launch author — typically Craig)
 * @param {function} [args._fetch]
 * @returns {Promise<{
 *   newComments: Array<object>,
 *   allCommentsCount: number,
 *   storyMeta: object|null,
 *   error?: string,
 * }>}
 */
async function pollForNewComments({
  storyId,
  seenCommentIds,
  authorFilter,
  _fetch,
}) {
  const tree = await fetchStoryTree({ storyId, _fetch });
  if (tree.error || !tree.story) {
    return { newComments: [], allCommentsCount: 0, storyMeta: null, error: tree.error || "no-story" };
  }
  const seen = seenCommentIds instanceof Set ? seenCommentIds : new Set();
  const flat = flattenComments(tree.story);
  const newComments = [];
  for (const c of flat) {
    if (seen.has(c.id)) continue;
    // If authorFilter is set, only surface comments whose parent author
    // matches (i.e. someone replied to Craig).
    if (authorFilter && c.parentAuthor !== authorFilter) continue;
    newComments.push(c);
  }
  // Sort oldest-first so drafts are processed in conversation order
  newComments.sort((a, b) => (a.createdAtUnix || 0) - (b.createdAtUnix || 0));
  return {
    newComments,
    allCommentsCount: flat.length,
    storyMeta: {
      id: tree.story.id,
      title: tree.story.title || null,
      author: tree.story.author || null,
      points: tree.story.points || null,
      url: tree.story.url || null,
      createdAtUnix: tree.story.created_at_i || null,
    },
  };
}

/**
 * Resolve a story ID from a hacker-news URL OR a numeric ID string.
 *
 * Accepted forms:
 *   "12345"
 *   12345
 *   "https://news.ycombinator.com/item?id=12345"
 */
function resolveStoryId(input) {
  if (input === undefined || input === null) return null;
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const m = trimmed.match(/[?&]id=(\d+)/);
  if (m) return Number(m[1]);
  return null;
}

/**
 * Fetch the author's recent comments — used to bootstrap voice
 * examples for the drafter.
 *
 * @param {object} args
 * @param {string} args.author             HN username (e.g. "McCracken49")
 * @param {number} [args.limit=15]         max comments to return
 * @param {function} [args._fetch]
 * @returns {Promise<Array<{ text: string, createdAtUnix: number }>>}
 */
async function fetchAuthorRecentComments({ author, limit = 15, _fetch }) {
  if (!author || typeof author !== "string") {
    throw new TypeError("author is required");
  }
  const fetchImpl = _fetch || (typeof fetch === "function" ? fetch : null);
  if (!fetchImpl) throw new Error("no fetch available; pass _fetch for tests");
  const url = `${HN_SEARCH_BASE}?author=${encodeURIComponent(author)}&tags=comment&hitsPerPage=${Math.min(limit, 50)}`;
  let res;
  try {
    res = await fetchImpl(url);
  } catch (err) {
    return [];
  }
  if (!res || !res.ok) return [];
  const data = await res.json();
  const hits = Array.isArray(data.hits) ? data.hits : [];
  return hits
    .map((h) => ({
      text: stripHtml(h.comment_text || ""),
      createdAtUnix: h.created_at_i || null,
      objectId: h.objectID || null,
    }))
    .filter((h) => h.text.length > 20); // drop very short responses
}

module.exports = {
  fetchStoryTree,
  pollForNewComments,
  flattenComments,
  resolveStoryId,
  fetchAuthorRecentComments,
  stripHtml,
};
