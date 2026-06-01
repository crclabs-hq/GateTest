// =============================================================================
// Watchdog freshness-gate tests
// =============================================================================
// Cover the changes that stop the watchdog from auto-fixing months-old code:
//   1. /api/admin/repos returns latestRunAgeDays + pushedAgeDays + "stale" status
//   2. /api/admin/repos requests workflow runs filtered to the default branch
//   3. WatchdogPanel.fixAllFailing excludes stale repos from batch fix
//   4. WatchdogPanel renders the run age explicitly in the meta line
//   5. /api/watches/tick has an inactivity check before auto-fix
// =============================================================================

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const REPOS_ROUTE = path.join(ROOT, "website/app/api/admin/repos/route.ts");
const TICK_ROUTE = path.join(ROOT, "website/app/api/watches/tick/route.ts");
const ADMIN_PANEL = path.join(ROOT, "website/app/admin/AdminPanel.tsx");

test("repos route: requests workflow runs filtered to default branch", () => {
  const src = fs.readFileSync(REPOS_ROUTE, "utf8");
  assert.match(src, /branch=\$\{branch\}/);
  assert.match(src, /encodeURIComponent\(repo\.default_branch/);
  // The old "exclude_pull_requests=false" path took stale PR runs in too —
  // the new code uses `=true` so only direct branch CI counts.
  assert.match(src, /exclude_pull_requests=true/);
  assert.doesNotMatch(src, /exclude_pull_requests=false/);
});

test("repos route: declares a 30-day stale-run threshold + 60-day inactive-push threshold", () => {
  const src = fs.readFileSync(REPOS_ROUTE, "utf8");
  assert.match(src, /STALE_RUN_DAYS\s*=\s*30/);
  assert.match(src, /INACTIVE_PUSH_DAYS\s*=\s*60/);
});

test("repos route: computes latestRunAgeDays + pushedAgeDays per repo", () => {
  const src = fs.readFileSync(REPOS_ROUTE, "utf8");
  assert.match(src, /latestRunAgeDays/);
  assert.match(src, /pushedAgeDays/);
  // Both are returned in the per-repo payload so the UI can render them.
  assert.match(src, /latestRunAgeDays,?\s*$/m);
  assert.match(src, /pushedAgeDays,?\s*$/m);
});

test("repos route: ciStatus union includes 'stale'", () => {
  const src = fs.readFileSync(REPOS_ROUTE, "utf8");
  assert.match(src, /"passing"\s*\|\s*"failing"\s*\|\s*"pending"\s*\|\s*"none"\s*\|\s*"stale"/);
  assert.match(src, /ciStatus\s*=\s*"stale"/);
});

test("repos route: response carries staleCount + freshness window", () => {
  const src = fs.readFileSync(REPOS_ROUTE, "utf8");
  assert.match(src, /const stale\s*=\s*enriched\.filter/);
  assert.match(src, /freshness:\s*\{/);
  assert.match(src, /staleRunDays/);
  assert.match(src, /inactivePushDays/);
});

test("admin panel: RepoInfo type carries the new freshness fields", () => {
  const src = fs.readFileSync(ADMIN_PANEL, "utf8");
  assert.match(src, /latestRunAgeDays:\s*number\s*\|\s*null/);
  assert.match(src, /pushedAgeDays:\s*number\s*\|\s*null/);
  assert.match(src, /ciStatus:\s*"passing"\s*\|\s*"failing"\s*\|\s*"pending"\s*\|\s*"none"\s*\|\s*"stale"/);
});

test("admin panel: fixAllFailing excludes stale repos from the batch", () => {
  const src = fs.readFileSync(ADMIN_PANEL, "utf8");
  // The batch filter must reference the same freshness window.
  assert.match(src, /STALE_RUN_DAYS\s*=\s*30/);
  // And the batch must check latestRunAgeDays <= STALE_RUN_DAYS.
  const batchSection = src.slice(src.indexOf("async function fixAllFailing"), src.indexOf("const displayed = filter"));
  assert.match(batchSection, /latestRunAgeDays/);
  assert.match(batchSection, /STALE_RUN_DAYS/);
});

test("admin panel: per-repo scan confirms before scanning a stale repo", () => {
  const src = fs.readFileSync(ADMIN_PANEL, "utf8");
  const scanSection = src.slice(src.indexOf("async function scanAndFix"), src.indexOf("async function fixAllFailing"));
  assert.match(scanSection, /repo\.ciStatus === "stale"/);
  assert.match(scanSection, /window\.confirm/);
});

test("admin panel: run-meta line surfaces a human age label", () => {
  const src = fs.readFileSync(ADMIN_PANEL, "utf8");
  // ageLabel is constructed from latestRunAgeDays and rendered next to the date.
  assert.match(src, /const ageLabel\s*=/);
  assert.ok(
    src.includes("ageLabel ? ` (${ageLabel})` : \"\""),
    "expected ageLabel to be rendered next to the date as ` (X days ago)`"
  );
});

test("admin panel: stale repos render a STALE badge + gray accent", () => {
  const src = fs.readFileSync(ADMIN_PANEL, "utf8");
  assert.match(src, /"STALE"/);
  assert.match(src, /border-l-gray-400/);
});

test("tick route: declares the INACTIVE_PUSH_DAYS window + helper", () => {
  const src = fs.readFileSync(TICK_ROUTE, "utf8");
  assert.match(src, /INACTIVE_PUSH_DAYS\s*=\s*60/);
  assert.match(src, /repoIsActiveOnGitHub/);
});

test("tick route: skips auto-fix when repoIsActiveOnGitHub returns false", () => {
  const src = fs.readFileSync(TICK_ROUTE, "utf8");
  const fixBlock = src.slice(src.indexOf("auto-fix for repos if issues found"), src.indexOf("await sql`\n      UPDATE watches\n      SET last_checked_at = NOW()"));
  assert.match(fixBlock, /const isActive = await repoIsActiveOnGitHub/);
  assert.match(fixBlock, /if \(isActive === false\)/);
  assert.match(fixBlock, /skipped-stale/);
  // The skip path must still write a heal_history row so the operator sees why.
  assert.match(fixBlock, /INSERT INTO heal_history/);
  assert.match(fixBlock, /repo inactive/);
});

test("tick route: skip path advances last_checked_at so we don't re-tick the same dead repo every cycle", () => {
  const src = fs.readFileSync(TICK_ROUTE, "utf8");
  const fixBlock = src.slice(src.indexOf("auto-fix for repos if issues found"), src.indexOf("await sql`\n      UPDATE watches\n      SET last_checked_at = NOW()"));
  // The skip-stale path must also UPDATE the watches row so the next tick
  // doesn't immediately re-pick the same inactive repo.
  assert.match(fixBlock, /UPDATE watches[\s\S]*last_checked_at = NOW\(\)/);
});
