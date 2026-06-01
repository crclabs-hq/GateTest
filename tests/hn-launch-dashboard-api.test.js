"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const POLL_ROUTE_PATH = path.join(ROOT, "website/app/api/admin/hn-launch/poll/route.ts");
const DRAFT_ROUTE_PATH = path.join(ROOT, "website/app/api/admin/hn-launch/draft/route.ts");
const PAGE_PATH = path.join(ROOT, "website/app/admin/hn-launch/page.tsx");

// We can't import the .ts routes from node:test, so we assert the file
// shape — auth check present, no auto-post, correct imports, banner-
// enforced via the drafter.

test("poll route: enforces admin cookie check", () => {
  const src = fs.readFileSync(POLL_ROUTE_PATH, "utf8");
  assert.match(src, /gatetest_admin/);
  assert.match(src, /isAdminRequest/);
  assert.match(src, /status:\s*401/);
});

test("poll route: reads storyId + bounds per-poll Claude budget", () => {
  const src = fs.readFileSync(POLL_ROUTE_PATH, "utf8");
  assert.match(src, /HARD_LIMIT\s*=\s*10/);
  assert.match(src, /DEFAULT_LIMIT\s*=\s*5/);
  assert.match(src, /resolveStoryId/);
});

test("poll route: skips operator's own comments (no self-replies)", () => {
  const src = fs.readFileSync(POLL_ROUTE_PATH, "utf8");
  assert.match(src, /HN_AUTHOR\s*=\s*"McCracken49"/);
  assert.match(src, /c\.author !== HN_AUTHOR/);
});

test("poll route: uses the drafter library (banner-enforced)", () => {
  const src = fs.readFileSync(POLL_ROUTE_PATH, "utf8");
  assert.match(src, /hn-reply-assistant\/drafter\.js/);
  assert.match(src, /draftReply/);
});

test("poll route: emits HN reply + item URLs per draft", () => {
  const src = fs.readFileSync(POLL_ROUTE_PATH, "utf8");
  assert.match(src, /hnReplyUrl/);
  assert.match(src, /hnItemUrl/);
  assert.match(src, /news\.ycombinator\.com\/reply\?id=/);
});

test("poll route: does NOT contain any post-to-HN logic", () => {
  const src = fs.readFileSync(POLL_ROUTE_PATH, "utf8");
  assert.doesNotMatch(src, /POST.*news\.ycombinator\.com/);
  assert.doesNotMatch(src, /fetch.*news\.ycombinator\.com.*method:\s*"POST"/i);
});

test("draft route: enforces admin + uses drafter library", () => {
  const src = fs.readFileSync(DRAFT_ROUTE_PATH, "utf8");
  assert.match(src, /gatetest_admin/);
  assert.match(src, /draftReply/);
});

test("draft route: accepts operator hint", () => {
  const src = fs.readFileSync(DRAFT_ROUTE_PATH, "utf8");
  assert.match(src, /OPERATOR HINT/);
});

test("dashboard page: client-side seen-IDs persistence (localStorage)", () => {
  const src = fs.readFileSync(PAGE_PATH, "utf8");
  assert.match(src, /localStorage/);
  assert.match(src, /SEEN_KEY/);
  assert.match(src, /persistSeen/);
});

test("dashboard page: explicitly tells the operator nothing auto-posts", () => {
  const src = fs.readFileSync(PAGE_PATH, "utf8");
  assert.match(src, /never.*auto-posted/i);
});

test("dashboard page: surfaces over-cap warning when too many comments arrive", () => {
  const src = fs.readFileSync(PAGE_PATH, "utf8");
  assert.match(src, /overPerPollCap/);
});

test("dashboard page: uses \"use client\" directive", () => {
  const src = fs.readFileSync(PAGE_PATH, "utf8");
  assert.match(src, /^"use client"/);
});

test("dashboard page: auto-poll interval is 60 seconds", () => {
  const src = fs.readFileSync(PAGE_PATH, "utf8");
  assert.match(src, /POLL_INTERVAL_MS\s*=\s*60_000|POLL_INTERVAL_MS\s*=\s*60000/);
});

test("dashboard page: copy + open-HN buttons present", () => {
  const src = fs.readFileSync(PAGE_PATH, "utf8");
  assert.match(src, /handleCopy/);
  assert.match(src, /Open HN reply form/);
});
