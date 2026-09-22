'use strict';

/**
 * The engine build stamp — one definition (Doctrine #4), so a web-scan
 * result can carry the SAME value `/api/platform-status` reports as
 * `commit` (issue #661).
 *
 * Precedence matches `/api/platform-status/route.ts`: an env var an
 * external deploy platform might inject wins, otherwise the git SHA the
 * website's `prebuild` step bakes into `app/data/build-info.json`
 * (`scripts/generate-build-info.js`), otherwise `'unknown'` rather than a
 * silent falsy value.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const buildInfo = require('../data/build-info.json');

function engineBuild() {
  return process.env.GIT_COMMIT ?? buildInfo.commit ?? 'unknown';
}

module.exports = { engineBuild };
