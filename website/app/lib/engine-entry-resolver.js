/**
 * Resolves the absolute path to the CLI engine's entry point
 * (`src/index.js`, one level above `website/`) so the four callers that
 * `require(/* turbopackIgnore: true *(/) engineEntry)` it — web/scan,
 * web/scan/stream, wp/scan, wp/scan/stream, and cli-engine-runner.js
 * (used by /api/scan/run) — all resolve it the same, correct way.
 *
 * No single anchor works in every context this file's callers run in:
 *   - `__dirname`-relative is correct for a plain `node --test` /
 *     direct-require invocation (this file keeps its real location).
 *   - `process.cwd()`-relative is correct for the Next.js SERVER at
 *     runtime — both `next dev`/`next start` (cwd = website/) and Vercel
 *     (cwd = /var/task/website) — because Turbopack bundles this file
 *     into a `.next/server/chunks/...` location where `__dirname` no
 *     longer matches the source tree, but the process cwd still does.
 *   - `process.cwd()` with NO `..` covers being required with cwd
 *     already at the repo root (e.g. this repo's own test suite, run
 *     via `node --test tests/*.test.js` from `/opt/gatetest`).
 *
 * Rather than guess which context we're in, try each candidate and use
 * whichever actually exists on disk — same resilience pattern already
 * used by resolvePlaywright() in form-testing.js / console-errors.js /
 * design-system-compliance.js / cross-browser.js.
 */

'use strict';

const path = require('path');
const fs = require('fs');

function candidatePaths() {
  return [
    path.join(__dirname, '..', '..', '..', 'src', 'index.js'),
    path.join(process.cwd(), '..', 'src', 'index.js'),
    path.join(process.cwd(), 'src', 'index.js'),
  ];
}

/**
 * @returns {string} absolute path to src/index.js
 * @throws {Error} if none of the candidate locations exist
 */
function resolveEngineEntry() {
  const candidates = candidatePaths();
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `GateTest CLI engine entry not found. Tried:\n${candidates.map((c) => `  - ${c}`).join('\n')}`
  );
}

module.exports = { resolveEngineEntry, candidatePaths };
