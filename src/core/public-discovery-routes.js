'use strict';
/**
 * Public-by-design discovery endpoints — ONE definition (issue #771, GT-11).
 *
 * A handful of routes are meant to answer without authentication by
 * convention, not by oversight: a load balancer's `/health` probe, a
 * crawler's `/robots.txt`, a client's `/.well-known/*` lookup, an API
 * client's `/openapi.json` schema fetch, a version-pin check at
 * `/api/version`, and the API's own front door — a bare `GET /` or
 * `GET /v1` that answers a capability index (what the prefix is, where the
 * docs are, how to authenticate). `authBypass` (src/modules/auth-bypass.js)
 * reported these as unprotected routes on AlecRae.com (`GET /`, `GET /v1`,
 * `GET /openapi.yaml`, `ROUTE /v1/uptime` in apps/api/src/server.ts) — the
 * rule had no notion of a route that is CORRECTLY public, only routes it
 * happened to recognise by substring (`/health`, `/webhook`, ...) with this
 * exact family missing.
 *
 * `/api/admin/users` is not on this list and must never be added to it by
 * pattern-widening: a path that merely LOOKS like a discovery endpoint
 * (`/api/versions/1/users`, `/status/orders/42`, `/v1/users`) is not
 * exempted — every entry below is matched as the WHOLE path (an optional
 * `/v<n>` or `/api` prefix, then one discovery segment, then nothing), not
 * as a prefix of something else. See the GT-11 block in
 * tests/auth-bypass-precision.test.js for the control pair.
 */

// Whole-path match, trailing slash tolerated. Two shapes:
//   1. the API root or a bare version prefix: `/`, `/v1`, `/v2/`
//   2. one discovery segment, optionally under `/v<n>` or `/api`:
//      `/healthz`, `/v1/uptime`, `/api/version`, `/openapi.yaml`,
//      `/.well-known/<anything>`
// `/status-page`, `/order-status`, `/v1/users`, `/api/versions/1` do not
// match — the segment must be the LAST thing in the path and match exactly.
const PUBLIC_DISCOVERY_PATH_RE =
  /^\/(?:v\d+\/?)?$|^\/(?:(?:v\d+|api)\/)?(?:\.well-known(?:\/.*)?|healthz?|status|uptime|version|robots\.txt|openapi\.(?:json|ya?ml))\/?$/i;

/**
 * Is `routePath` one of the public-by-design discovery endpoints? Anchored
 * on the whole path so a path that only CONTAINS one of these words as a
 * segment of something bigger (`/api/admin/users`, `/api/versions/1`,
 * `/v1/users`) is never exempted.
 * @param {string} routePath
 * @returns {boolean}
 */
function isPublicDiscoveryRoute(routePath) {
  if (typeof routePath !== 'string' || !routePath) return false;
  return PUBLIC_DISCOVERY_PATH_RE.test(routePath);
}

module.exports = { PUBLIC_DISCOVERY_PATH_RE, isPublicDiscoveryRoute };
