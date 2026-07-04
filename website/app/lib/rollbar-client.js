/**
 * Re-export shim — the canonical Rollbar client lives at
 * src/core/rollbar-client.js (Craig-authorized 2026-07-04, Boss Rule #7).
 * Same lift-and-shim pattern as sentry-client.js / datadog-client.js.
 *
 * Keep this a one-line re-export: tests/lib-shims.test.js asserts function
 * IDENTITY between this module and the src/core canonical.
 */
module.exports = require('../../../src/core/rollbar-client.js');
