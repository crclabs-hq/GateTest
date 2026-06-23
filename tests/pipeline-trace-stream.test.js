"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ROUTE = path.join(ROOT, "website/app/api/admin/pipeline-trace/stream/route.ts");
const FEED = path.join(ROOT, "website/app/admin/pipeline-trace/LiveScanFeed.tsx");
const PAGE = path.join(ROOT, "website/app/admin/pipeline-trace/page.tsx");

// ── Stream route ──────────────────────────────────────────────────────────────

test("stream route: file exists", () => {
  assert.ok(fs.existsSync(ROUTE), `expected route at ${ROUTE}`);
});

test("stream route: exports GET handler", () => {
  const src = fs.readFileSync(ROUTE, "utf8");
  assert.match(src, /export\s+async\s+function\s+GET\s*\(/);
});

test("stream route: admin-only — calls isAdminRequest and returns 401 on failure", () => {
  const src = fs.readFileSync(ROUTE, "utf8");
  assert.match(src, /isAdminRequest/);
  assert.match(src, /401/);
});

test("stream route: imports isAdminRequest from admin-auth", () => {
  const src = fs.readFileSync(ROUTE, "utf8");
  assert.match(src, /import[^;]+isAdminRequest[^;]+admin-auth/);
});

test("stream route: uses ReadableStream", () => {
  const src = fs.readFileSync(ROUTE, "utf8");
  assert.match(src, /new\s+ReadableStream\s*\(/);
});

test("stream route: Content-Type is text/event-stream", () => {
  const src = fs.readFileSync(ROUTE, "utf8");
  assert.match(src, /text\/event-stream/);
});

test("stream route: sends scan events via SSE", () => {
  const src = fs.readFileSync(ROUTE, "utf8");
  // sse() helper is called with "scan" as event name
  assert.match(src, /sse\s*\(\s*["']scan["']/);
  // The sse helper serialises using the event variable in the SSE format
  assert.match(src, /event:\s*\$\{event\}/);
});

test("stream route: has heartbeat comment to keep proxies alive", () => {
  const src = fs.readFileSync(ROUTE, "utf8");
  assert.match(src, /ping/);
  assert.match(src, /heartbeatId/);
});

test("stream route: closes after timeout for Vercel budget", () => {
  const src = fs.readFileSync(ROUTE, "utf8");
  assert.match(src, /closeTimeoutId/);
  assert.match(src, /55[_,]?000/);
  assert.match(src, /ctrl\.close\(\)/);
});

test("stream route: cancel() clears all intervals and timeouts", () => {
  const src = fs.readFileSync(ROUTE, "utf8");
  assert.match(src, /cancel\s*\(\s*\)/);
  assert.match(src, /cleanup\s*\(\s*\)/);
  assert.match(src, /clearInterval/);
  assert.match(src, /clearTimeout/);
});

test("stream route: guards against enqueue-after-close with closed flag", () => {
  const src = fs.readFileSync(ROUTE, "utf8");
  assert.match(src, /\bclosed\b/);
});

test("stream route: handles missing scans table gracefully (no throw)", () => {
  const src = fs.readFileSync(ROUTE, "utf8");
  assert.match(src, /does not exist/);
});

test("stream route: polls for new scans since last seen timestamp", () => {
  const src = fs.readFileSync(ROUTE, "utf8");
  assert.match(src, /since/);
  assert.match(src, /created_at\s*>\s*\$\{since/);
});

test("stream route: disables response buffering via X-Accel-Buffering header", () => {
  const src = fs.readFileSync(ROUTE, "utf8");
  assert.match(src, /X-Accel-Buffering/);
  assert.match(src, /no/);
});

// ── LiveScanFeed component ────────────────────────────────────────────────────

test("LiveScanFeed: file exists", () => {
  assert.ok(fs.existsSync(FEED), `expected component at ${FEED}`);
});

test("LiveScanFeed: starts with \"use client\"", () => {
  const src = fs.readFileSync(FEED, "utf8");
  const firstLine = src.split("\n").find((l) => l.trim().length > 0);
  assert.match(String(firstLine), /^"use client";?$/);
});

test("LiveScanFeed: opens EventSource to the stream route", () => {
  const src = fs.readFileSync(FEED, "utf8");
  assert.match(src, /new\s+EventSource\s*\(/);
  assert.match(src, /\/api\/admin\/pipeline-trace\/stream/);
});

test("LiveScanFeed: sends cookies with withCredentials", () => {
  const src = fs.readFileSync(FEED, "utf8");
  assert.match(src, /withCredentials\s*:\s*true/);
});

test("LiveScanFeed: cleans up EventSource on unmount", () => {
  const src = fs.readFileSync(FEED, "utf8");
  assert.match(src, /es\.close\(\)/);
  assert.match(src, /return\s*\(\s*\)\s*=>\s*\{/);
});

test("LiveScanFeed: listens for named scan events", () => {
  const src = fs.readFileSync(FEED, "utf8");
  assert.match(src, /addEventListener\s*\(\s*["']scan["']/);
});

test("LiveScanFeed: listens for named close event to handle graceful stream end", () => {
  const src = fs.readFileSync(FEED, "utf8");
  assert.match(src, /addEventListener\s*\(\s*["']close["']/);
});

test("LiveScanFeed: caps event buffer at 50 to avoid unbounded memory growth", () => {
  const src = fs.readFileSync(FEED, "utf8");
  assert.match(src, /slice\s*\(\s*-\s*50\s*\)/);
});

test("LiveScanFeed: has aria-live for screen-reader accessibility", () => {
  const src = fs.readFileSync(FEED, "utf8");
  assert.match(src, /aria-live/);
  assert.match(src, /role=["']log["']/);
});

test("LiveScanFeed: shows connection status indicator", () => {
  const src = fs.readFileSync(FEED, "utf8");
  assert.match(src, /connected/);
  assert.match(src, /animate-pulse/);
});

test("LiveScanFeed: dark-mode terminal — bg-gray-900 container", () => {
  const src = fs.readFileSync(FEED, "utf8");
  assert.match(src, /bg-gray-900/);
  assert.match(src, /font-mono/);
});

// ── Integration: page wires in LiveScanFeed ───────────────────────────────────

test("pipeline-trace page: imports LiveScanFeed component", () => {
  const src = fs.readFileSync(PAGE, "utf8");
  assert.match(src, /import[^;]+LiveScanFeed[^;]+LiveScanFeed/);
});

test("pipeline-trace page: renders <LiveScanFeed /> in the JSX", () => {
  const src = fs.readFileSync(PAGE, "utf8");
  assert.match(src, /<LiveScanFeed\s*\/>/);
});
