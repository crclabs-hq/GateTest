'use strict';
/**
 * The body of GET /api (#810). One definition, imported by app/api/route.ts
 * and by tests/signin-gate.test.js.
 *
 * People probe the root of an API to find out where it lives. The answer is a
 * pointer, not a 404: the docs URL and the fact that trips people up — the API
 * is a path on the site's own origin, not a separate host.
 */

function apiRootBody(origin) {
  const host = new URL(origin).host;
  return {
    ok: true,
    docs: `${origin}/developers`,
    note: `the API lives under ${host}/api; api.${host} is not a host`,
  };
}

module.exports = { apiRootBody };
