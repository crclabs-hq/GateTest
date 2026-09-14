'use strict';

/**
 * The platform GateTest runs on and dispatches to — ONE definition.
 *
 * The platform is being renamed Vapron → Tallrig and every hostname moves
 * (announced by the Vapron session on Craig's instruction, 2026-09-13):
 * product/API → tallrig.com / api.tallrig.com, ops/staging → tallrig.io,
 * mail/infra → tallrig.net, the product name → "Tallrig", the entity →
 * "Tallrig Labs LLC". Nothing has moved yet; each target is announced when it
 * answers, and vapron.* stays live for a transition window with a sunset
 * date Craig sets.
 *
 * So: every hostname and the product name is read HERE, defaulting to
 * today's Vapron values, and the flip is an env change on the box — no
 * literal anywhere else, no rebuild-to-rename (doctrine §4: one definition,
 * imported). Same shape as site-url.js for gatetest.io.
 *
 * Env precedence (the order the platform's own SDK uses):
 *   TALLRIG_<NAME> → VAPRON_<NAME> → CRONTECH_<NAME> (legacy) → default
 *
 * Client-visible values (`NEXT_PUBLIC_*`) are read as static member
 * expressions so Next.js inlines them into client bundles at build time —
 * do not read them through a helper or a computed key.
 *
 * Zero-dependency on purpose: required by plain CJS (mail-transport.js,
 * platform-siblings.js, integrations/smoke/empire-smoke.js, scripts/ops)
 * and by TS routes alike.
 */

/** Today's values. Change these ONLY when the platform announces the sunset. */
const PLATFORM_DEFAULTS = Object.freeze({
  id: 'vapron',
  name: 'Vapron',
  entity: 'Vapron',
  siteUrl: 'https://vapron.ai',
  apiUrl: 'https://api.vapron.ai',
  mailUrl: 'https://vapron.ai/api/platform/email/send',
  statusUrl: 'https://vapron.ai/api/health/status',
  /** systemd unit prefix on the box: <prefix>-web, <prefix>-api, <prefix>-bun-gateway */
  servicePrefix: 'vapron',
  /** Where the legacy crontech.ai redirect must finally land. */
  canonicalHost: 'vapron.ai',
});

/** Env-var prefixes in precedence order. */
const ENV_PREFIXES = Object.freeze(['TALLRIG_', 'VAPRON_', 'CRONTECH_']);

function normaliseOrigin(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return null;
  }
}

/**
 * The first set value of TALLRIG_<name>, VAPRON_<name>, CRONTECH_<name>.
 * @param {string} name   e.g. 'BASE_URL', 'API_TOKEN', 'DISPATCH_SECRET'
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|undefined}
 */
function platformEnv(name, env = process.env) {
  for (const prefix of ENV_PREFIXES) {
    // The key is built here, so no static reader can see it — the marker
    // tells envVars every declared TALLRIG_/VAPRON_/CRONTECH_ key is read.
    // env: TALLRIG_* VAPRON_* CRONTECH_*
    const v = env[`${prefix}${name}`];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

/** All aliases for a canonical VAPRON_<name>, most-preferred first. */
function platformEnvNames(name) {
  return ENV_PREFIXES.map((p) => `${p}${name}`);
}

// ── Client-visible (inlined at build): the product name and links ──────────
const PLATFORM_ID = (process.env.NEXT_PUBLIC_PLATFORM_ID || PLATFORM_DEFAULTS.id).trim();
const PLATFORM_NAME = (process.env.NEXT_PUBLIC_PLATFORM_NAME || PLATFORM_DEFAULTS.name).trim();
const PLATFORM_ENTITY = (process.env.NEXT_PUBLIC_PLATFORM_ENTITY || PLATFORM_DEFAULTS.entity).trim();
const PLATFORM_SITE_URL = normaliseOrigin(process.env.NEXT_PUBLIC_PLATFORM_URL) || PLATFORM_DEFAULTS.siteUrl;
const PLATFORM_API_URL = normaliseOrigin(process.env.NEXT_PUBLIC_PLATFORM_API_URL) || PLATFORM_DEFAULTS.apiUrl;
/** Bare host of the site, for copy like "vapron.ai →" and cert probes. */
const PLATFORM_HOST = new URL(PLATFORM_SITE_URL).hostname;

// ── Server-side, resolved per call so a deploy can repoint without a rebuild ─

/** Platform e-mail send endpoint. */
function platformMailUrl(env = process.env) {
  return platformEnv('MAIL_URL', env) || PLATFORM_DEFAULTS.mailUrl;
}

/** Public, unauthenticated health URL other products poll. */
function platformStatusUrl(env = process.env) {
  return platformEnv('STATUS_URL', env) || PLATFORM_DEFAULTS.statusUrl;
}

/** systemd unit prefix on the production box. */
function platformServicePrefix(env = process.env) {
  const v = env.PLATFORM_SERVICE_PREFIX;
  return typeof v === 'string' && /^[a-z][a-z0-9-]*$/.test(v.trim()) ? v.trim() : PLATFORM_DEFAULTS.servicePrefix;
}

/** Host the legacy crontech.ai redirect must finally reach. */
function platformCanonicalHost(env = process.env) {
  const v = env.PLATFORM_CANONICAL_HOST;
  if (typeof v === 'string' && v.trim()) return v.trim().toLowerCase();
  const site = normaliseOrigin(env.NEXT_PUBLIC_PLATFORM_URL);
  return site ? new URL(site).hostname : PLATFORM_DEFAULTS.canonicalHost;
}

/**
 * Which brand each platform variable is currently pointed at — names only,
 * never values — so /api/status can show mid-rename whether the box has
 * been flipped. `pointed_at` is the verdict for the three dispatch vars:
 * 'tallrig' | 'vapron' | 'crontech' when all three resolve from the same
 * prefix, 'mixed' when they do not, 'unset' when none resolves.
 *
 * @param {Record<string, string|undefined>} [env]
 */
function platformPointing(env = process.env) {
  const brandOf = (name) => {
    for (const prefix of ENV_PREFIXES) {
      const v = env[`${prefix}${name}`];
      if (typeof v === 'string' && v.trim()) return prefix.slice(0, -1).toLowerCase();
    }
    return null;
  };
  const dispatch = { BASE_URL: brandOf('BASE_URL'), API_TOKEN: brandOf('API_TOKEN'), DISPATCH_SECRET: brandOf('DISPATCH_SECRET') };
  const brands = new Set(Object.values(dispatch));
  let pointedAt;
  if (brands.size === 1 && !brands.has(null)) [pointedAt] = brands;
  else if (brands.size === 1) pointedAt = 'unset';
  else pointedAt = 'mixed';
  return {
    name: PLATFORM_NAME,
    pointed_at: pointedAt,
    dispatch,
    mail_url: brandOf('MAIL_URL') || 'default',
    status_url: brandOf('STATUS_URL') || 'default',
  };
}

module.exports = {
  PLATFORM_DEFAULTS,
  platformPointing,
  ENV_PREFIXES,
  platformEnv,
  platformEnvNames,
  PLATFORM_ID,
  PLATFORM_NAME,
  PLATFORM_ENTITY,
  PLATFORM_SITE_URL,
  PLATFORM_API_URL,
  PLATFORM_HOST,
  platformMailUrl,
  platformStatusUrl,
  platformServicePrefix,
  platformCanonicalHost,
};
