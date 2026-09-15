/**
 * Cross-product platform registry — ONE definition of where each sibling
 * product's status API lives.
 *
 * Why this file exists: the same three URLs were written out twice, in
 * `app/api/platform-status/route.ts` (the PUBLIC map every client and sibling
 * discovers us through) and `app/api/admin/platform-siblings/route.ts` (the
 * admin health aggregator). They drifted, in the worst possible direction:
 *
 *   - 2026-07-27 someone measured `vapron.ai/api/platform-status` → 404, found
 *     the real endpoint on `api.vapron.ai`, and fixed *the admin copy*, leaving
 *     a comment explaining the 404.
 *   - The public copy kept serving `https://vapron.ai/api/platform-status`.
 *     Re-measured 2026-09-01: still 404. So for five weeks our public platform
 *     map pointed anyone discovering Vapron through GateTest at a dead URL,
 *     while a file two directories away documented that it was dead.
 *
 * Knowing a URL is broken in one file and advertising it in another is the
 * defect. The fix is not "update the second copy" — it is to stop having a
 * second copy. Both routes import this module; `tests/platform-siblings.test.js`
 * fails if a sibling URL literal reappears in either route.
 *
 * `requiresAuth` is deliberately part of the record: Vapron's platform API
 * answers 401 (`KEY_MISSING`, wants `Authorization: Bearer vpk_live_…`) rather
 * than serving health anonymously. A consumer that treats every entry here as
 * an anonymously-pollable health URL will read that 401 as "Vapron is down".
 * The flag lets a caller tell "unreachable" apart from "reachable, needs a key".
 */

// resolveSiteUrl (not siteUrl) because it accepts an env object. siteUrl()
// closes over an origin resolved once at module load, which cannot be
// exercised in a test and cannot follow an env change after boot.
const { resolveSiteUrl } = require('./site-url');

/**
 * Ordered registry. `defaultUrl: null` means the URL is derived at call time
 * (our own entry follows the canonical-domain env var — never a literal, per
 * the Bible's THE DOMAIN rule).
 *
 * Measurements below are from 2026-09-01 and are the reason each URL is what
 * it is. Re-measure before changing one; do not "tidy" a URL because it looks
 * inconsistent with the others.
 */
const {
  PLATFORM_ID,
  PLATFORM_NAME,
  PLATFORM_DEFAULTS,
  platformEnvNames,
} = require('./platform-config');

const SIBLING_REGISTRY = [
  {
    // Id, name and default URL come from platform-config.js — the platform
    // was renamed (Vapron → Tallrig, 2026-09-14; defaults flipped 2026-09-15
    // after measuring tallrig.com/api/health/status → 200) and any further
    // move is an env change.
    id: PLATFORM_ID,
    name: PLATFORM_NAME,
    envVar: 'TALLRIG_STATUS_URL',
    /** Every env name honoured for the override, most-preferred first. */
    envVars: platformEnvNames('STATUS_URL'),
    // Measured 2026-09-01, in conversation with the Vapron session:
    //   vapron.ai/api/platform-status                → 404
    //   api.vapron.ai/api/platform-status            → 404
    //   vapron.ai/api/health/status                  → 200, public, real body
    // Re-measured 2026-09-15 on the renamed host:
    //   tallrig.com/api/health/status                → 200, public, `overall`
    //   api.tallrig.com/api/health/status            → 200 (same document)
    //
    // `/api/platform-status` has NEVER existed in Vapron — zero grep hits
    // across their apps/packages/services. Both of our old URLs were built on
    // a path nobody ever shipped.
    //
    // The trap, and the reason this comment is long: the previous "fix" pointed
    // at api.vapron.ai/api/platform/api/platform-status because it answered 401
    // rather than 404, which was read as "alive, just needs a key". It is not.
    // EVERY path under /api/platform/ answers an identical 401 — the auth gate
    // fires before routing. Verified here by requesting an invented path:
    //   /api/platform/status                       → 401
    //   /api/platform/api/platform-status          → 401
    //   /api/platform/DEFINITELY-NOT-A-ROUTE-zzz999 → 401
    // A 401 from that host is therefore evidence of nothing. Do not treat a
    // non-404 as proof a URL exists.
    //
    // /api/health/status is the real inter-platform contract: public,
    // unauthenticated, deliberately projected (allowlisted customer-facing
    // services with status + latency only, no internal detail), and it carries
    // `overall` so a degraded platform reports degraded instead of hiding
    // behind a 200. Source: apps/api/src/routes/health-status.ts.
    // NOT `/api/health` — that is a bare liveness ping with nothing in it.
    defaultUrl: PLATFORM_DEFAULTS.statusUrl,
    requiresAuth: false,
  },
  {
    id: 'gluecron',
    name: 'Gluecron',
    envVar: 'GLUECRON_STATUS_URL',
    // Resolves to <box-ip> — the same host GateTest production runs on.
    // NOTE: there is a second Gluecron instance (gluecron.vapron.ai) that the
    // Vapron box treats as canonical. It is NOT publicly resolvable (NXDOMAIN
    // from off-tailnet, 2026-09-01), so it cannot be used here until it has a
    // public API hostname. Do not repoint this without re-measuring DNS.
    defaultUrl: 'https://gluecron.com/api/platform-status',
    requiresAuth: false,
  },
  {
    id: 'gatetest',
    name: 'GateTest',
    envVar: 'GATETEST_STATUS_URL',
    defaultUrl: null, // derived — see resolveSiblingUrl
    requiresAuth: false,
  },
];

/** Path of our own status endpoint, used to derive the self entry. */
const SELF_STATUS_PATH = '/api/platform-status';

/**
 * Resolve one sibling's status URL. An explicit env var always wins, so a
 * staging or self-hosted deployment can repoint without a code change.
 */
function resolveSiblingUrl(sibling, env = process.env) {
  const names = Array.isArray(sibling.envVars) && sibling.envVars.length ? sibling.envVars : [sibling.envVar];
  for (const name of names) {
    const override = env[name];
    if (override) return override;
  }
  if (sibling.defaultUrl) return sibling.defaultUrl;
  // Our own entry is derived, never typed — it was a `https://gatetest.ai`
  // literal once, and production served that dead domain here long after the
  // domain moved, sending clients to NXDOMAIN.
  return `${resolveSiteUrl(env)}${SELF_STATUS_PATH}`;
}

/**
 * The public `siblings` map: { id -> url }.
 *
 * Shape is a flat string map on purpose — it is a published contract that
 * other products already consume. Richer per-sibling metadata belongs on
 * SIBLING_REGISTRY, not in this response.
 */
function siblingUrlMap(env = process.env) {
  const map = {};
  for (const sibling of SIBLING_REGISTRY) {
    map[sibling.id] = resolveSiblingUrl(sibling, env);
  }
  return map;
}

module.exports = {
  SIBLING_REGISTRY,
  SELF_STATUS_PATH,
  resolveSiblingUrl,
  siblingUrlMap,
};
