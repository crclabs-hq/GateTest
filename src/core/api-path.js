'use strict';

/**
 * Is this URL an API / GraphQL endpoint rather than a content page?
 *
 * One definition (Doctrine §4) for the live modules that audit a fetched page
 * as a document (accessibility landmarks / lang, SEO metadata): a GraphQL
 * playground or an `/api/...` route is served HTML by a tool, not authored as
 * a content page, so "missing <main>", "no lang attribute" and "no meta
 * description" are not defects of the site. Seen on gluecron.com
 * (2026-10-03, /api/graphql).
 *
 * Segments, never substrings (Doctrine §5): `/apiary` and `/graphqlish` do
 * not match.
 *   - first path segment is `api`                       /api, /api/v1/x
 *   - last segment is `graphql` or `graphiql`           /graphql, /graphiql
 *   - last segment is `playground` UNDER an api path    /api/playground
 *     (a bare /playground is a plausible content page; /api/... already
 *     matches by its first segment, so this is covered by the first rule)
 *
 * @param {string} urlOrPath  absolute URL or a /path; anything else is "no"
 * @returns {boolean}
 */
function isApiEndpointPath(urlOrPath) {
  if (typeof urlOrPath !== 'string' || !urlOrPath) return false;
  if (!urlOrPath.startsWith('/') && !/^[a-z][a-z0-9+.-]*:\/\//i.test(urlOrPath)) return false;
  let pathname;
  try {
    pathname = new URL(urlOrPath, 'http://placeholder.invalid').pathname;
  } catch {
    return false;
  }
  const segs = pathname.split('/').filter(Boolean).map((s) => s.toLowerCase());
  if (segs.length === 0) return false;
  if (segs[0] === 'api') return true;
  const last = segs[segs.length - 1];
  return last === 'graphql' || last === 'graphiql';
}

module.exports = { isApiEndpointPath };
