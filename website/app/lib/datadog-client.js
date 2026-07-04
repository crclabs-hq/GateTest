/**
 * Re-export shim — the canonical Datadog client lives at
 * src/core/datadog-client.js so the MCP server (CLI-side) and the website
 * share ONE implementation. Lifted 2026-07-04 (eyes/ears/hands build).
 *
 * Keep this a one-line re-export: tests/lib-shims.test.js asserts function
 * IDENTITY between this module and the src/core canonical — forking it
 * back into a copy fails the suite.
 */
module.exports = require('../../../src/core/datadog-client.js');
