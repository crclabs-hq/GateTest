'use strict';
/**
 * The environment catalogue — ONE definition of which variables the website
 * deployment needs, how badly, and why.
 *
 * Moved here from website/app/api/status/route.ts (2026-09-30) so it can be
 * required by plain CommonJS: the admin secrets panel
 * (website/app/lib/secrets/panel.js), the node test suite and the catalogue
 * drift test cannot import a Next route file. /api/status and the admin
 * Overview checklist import these same arrays (Doctrine #4 — no second
 * hand-typed copy).
 *
 * Each list:
 *   REQUIRED  — absence BREAKS a core user flow (scan / auth / payment);
 *               drives /api/status `ready`.
 *   IMPORTANT — absence DEGRADES a feature.
 *   OPTIONAL  — purely optional integrations (names only; `why` lives in
 *               OPTIONAL_WHY so the existing string[] shape is unchanged).
 *   IGNORED   — names the code reads that are NOT deployment configuration
 *               for this website (runtime-injected, the engine reading a
 *               CUSTOMER's environment, tunables). Only the drift test reads
 *               it: a `process.env.X` in website/app or src that is in none
 *               of these lists fails tests/env-catalogue-drift.test.js.
 */

const { inspectEnvValue } = require('./env-placeholder');

// Vars whose absence BREAKS a core user flow (scan / auth / payment).
const REQUIRED = [
  { name: "ANTHROPIC_API_KEY", why: "AI review, auto-fix, and the watch cron all throw without it" },
  { name: "DATABASE_URL", why: "no scan results, sessions, customers, or API keys persist" },
  { name: "SESSION_SECRET", why: "customer + admin login (OAuth) fails to encrypt sessions" },
  { name: "STRIPE_SECRET_KEY", why: "checkout / payment cannot be created" },
  // No NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: checkout is Stripe-hosted (a
  // server-created session + redirect); nothing loads Stripe.js, so nothing
  // reads the publishable key (envVars, 2026-09-13).
  { name: "NEXT_PUBLIC_BASE_URL", why: "redirect + callback URLs resolve wrong" },
];

// Vars whose absence DEGRADES a feature but doesn't break the core flow.
const IMPORTANT = [
  { name: "STRIPE_WEBHOOK_SECRET", why: "Stripe webhooks can't be verified (subscription lifecycle)" },
  { name: "GITHUB_CLIENT_ID", why: "customer 'Sign in with GitHub' disabled" },
  { name: "GITHUB_CLIENT_SECRET", why: "pairs with GITHUB_CLIENT_ID" },
  { name: "GOOGLE_CLIENT_ID", why: "customer 'Continue with Google' returns 503 (login modal button dead)" },
  { name: "GOOGLE_CLIENT_SECRET", why: "pairs with GOOGLE_CLIENT_ID — needed for the Google token exchange" },
  { name: "GATETEST_ADMIN_PASSWORD", why: "admin console password login disabled ('Admin access is not configured')" },
  { name: "CRON_SECRET", why: "background cron jobs (watch tick, scan worker) exit early in prod" },
  { name: "RESEND_API_KEY", why: "MCP $29/mo API-key emails can't send — subscriber pays, key never arrives (webhook 500s until set)" },
  { name: "TALLRIG_BASE_URL", why: "runtime-scan dispatch to the Tallrig worker tier disabled — /web and /wp scans ship static probes only" },
  { name: "TALLRIG_API_TOKEN", why: "pairs with TALLRIG_BASE_URL — Tallrig rejects unauthenticated dispatch" },
  { name: "TALLRIG_DISPATCH_SECRET", why: "pairs with TALLRIG_BASE_URL — signs outbound jobs and verifies Tallrig's result callbacks" },
  { name: "TALLRIG_PUSH_SECRET", why: "Tallrig's deploy-event push to POST /api/integrations/tallrig/events is refused with 503 — the admin never hears about Tallrig-side deploys. Issued by Tallrig when the push endpoint is registered" },
  { name: "GATETEST_RECIPE_STORE_TOKEN", why: "fix-recipe WRITES (PUT /api/recipes) are refused with 503 until set — the flywheel cannot learn from CLI fixes; must equal the token CLI users set as GATETEST_RECIPE_STORE_TOKEN" },
  // ── Gluecron: the PREFERRED git host (Craig 2026-08-29 — customers may use
  // GitHub, but we steer them to Gluecron). These were classified "purely
  // optional" while GitHub was the only door, which is no longer true: this
  // is now the host we actively want customers on, so its ingress going dark
  // has to be visible here. Confirmed dead in production on 2026-08-29 —
  // POST /api/events/push returned 503 and nothing in this probe said so.
  { name: "GLUECRON_EMITTER_SECRET", why: "the Gluecron push ingress (POST /api/events/push) fails closed with 503 — every push from our PREFERRED git host is rejected, so no scan is ever queued for a Gluecron customer" },
  { name: "GLUECRON_BASE_URL", why: "Gluecron API base URL (defaults to https://gluecron.com) — set it explicitly when pointing at a non-default deployment" },
  { name: "GLUECRON_API_TOKEN", why: "no Gluecron PAT means repo reads fall back to a GitHub token, and private Gluecron repos cannot be scanned at all" },
  { name: "GLUECRON_OAUTH_CLIENT_ID", why: "customer 'Sign in with Gluecron' button is absent from /login until set (the OAuth app is registered at gluecron.com/settings/applications with redirect URI {NEXT_PUBLIC_BASE_URL}/api/auth/gluecron/callback)" },
  // ── The GitHub App credentials. Previously listed ONLY in the extras array
  // handed to findPlaceholders, so they could be reported as fake while no
  // classified list contained them — nothing could act on the finding.
  // IMPORTANT, not REQUIRED, and deliberately so: a Gluecron-only deployment
  // legitimately has no GitHub App, and flipping `ready` false there would be
  // the same over-correction this file just fixed in the other direction.
  { name: "GATETEST_APP_ID", why: "GitHub App JWT cannot be minted — commit statuses, PR comments, and the App-installed fix path all fail" },
  { name: "GATETEST_PRIVATE_KEY", why: "pairs with GATETEST_APP_ID. Confirmed dead in production 2026-08-31: the pasted documentation example was still in place, GitHub returned 401 Bad credentials, and EVERY private-repo scan 502'd on both hosts" },
  // ── The admin secrets panel's own master key (docs/ops/secrets-panel.md).
  // Lives ONLY in the box's app env file, typed by the owner — it is a
  // reserved name the panel can never store (website/app/lib/secrets/reserved.js).
  { name: "GATETEST_SECRETS_MASTER_KEY", why: "admin secrets panel is read-only ('store unavailable') — nothing can be stored, revealed or applied from /admin/secrets until a dedicated 32-byte key is set (openssl rand -base64 32)" },
];

// Purely optional integrations.
const OPTIONAL = [
  "SLACK_WEBHOOK_URL",
  "GITLAB_CLIENT_ID", "GITLAB_CLIENT_SECRET",
  // Gluecron sign-in works as a public client (PKCE only) without these two;
  // the secret adds client_secret_post, the base URL re-points the OAuth
  // server away from GLUECRON_BASE_URL / https://gluecron.com.
  "GLUECRON_OAUTH_CLIENT_SECRET", "GLUECRON_OAUTH_BASE_URL",
  "SENTRY_AUTH_TOKEN", "DATADOG_API_KEY", "ROLLBAR_READ_TOKEN",
  "GATETEST_FIX_MODEL", "CONTINUOUS_AI_BUDGET_USD",
  // Added 2026-09-30 by the catalogue drift test: credentials the web app
  // already reads that no list named, so the secrets panel could not show them.
  "GITHUB_WEBHOOK_SECRET", "GITHUB_MARKETPLACE_WEBHOOK_SECRET",
  "GITHUB_TOKEN", "GATETEST_GITHUB_TOKEN", "GITHUB_OAUTH_REDIRECT_URI",
  "GLUECRON_CALLBACK_SECRET", "GLUECRON_CALLBACK_URL",
  "GATETEST_INTERNAL_TOKEN", "GATETEST_INTERNAL_API_KEY",
  "INTEGRATIONS_SECRET", "INDEXNOW_KEY", "OPENAI_API_KEY",
  "SENTRY_CLIENT_ID", "SENTRY_CLIENT_SECRET", "SENTRY_WEBHOOK_SECRET_HEAL",
  "SLACK_SIGNING_SECRET", "RESEND_FROM", "GATETEST_ADMIN_USERNAMES", "GATETEST_ADMIN_EMAILS",
  "GATETEST_STATUS_TOKEN",
  "GATETEST_SSH_HOST", "GATETEST_SSH_PORT", "GATETEST_SSH_USER", "GATETEST_SSH_KEY", "GATETEST_SSH_PASSWORD",
  "GATETEST_SSH_HOSTNAMES",
  "GATETEST_SECRETS_MASTER_KEY_NEXT",
  // The sales switch (lib/sales-pause.js) — listed so the panel shows and sets it.
  "GATETEST_SALES_PAUSED",
  // Added 2026-10-01: read through an injected `env` object or platformEnv(),
  // which the drift test could not see until then — TALLRIG_PUSH_SECRET was
  // read in production and listed nowhere.
  "TALLRIG_PUSH_KEY_ID", "TALLRIG_API_KEY", "MAIL_PROVIDER", "MAIL_FROM",
  "GATETEST_HMAC_SECRET", "GATETEST_ADMIN_ORGS",
  "SENTRY_ORG", "SENTRY_PROJECT", "DATADOG_APP_KEY", "DD_SITE", "DD_SERVICE",
];

// One `why` per OPTIONAL name — the secrets panel shows it next to the row.
// An array of { name, why } like REQUIRED / IMPORTANT, not a name-keyed
// object: `SOME_SECRET: "text"` reads as a hardcoded credential to the
// secrets module (and to every other scanner a customer runs on this repo).
const OPTIONAL_WHY_LIST = [
  { name: "GATETEST_SALES_PAUSED", why: "the sales switch: paid checkout is CLOSED unless this is exactly 0 — unset keeps every paid plan off sale (Craig 2026-10-01)" },
  { name: "TALLRIG_PUSH_KEY_ID", why: "pairs with TALLRIG_PUSH_SECRET — when set, a Tallrig push whose X-Tallrig-Key-Id differs is refused (key rotation)" },
  { name: "TALLRIG_API_KEY", why: "Tallrig platform mail transport bearer (MAIL_PROVIDER=tallrig) — falls back to TALLRIG_API_TOKEN when unset" },
  { name: "MAIL_PROVIDER", why: "which service sends e-mail: 'resend' or 'tallrig' — unset sends through Resend while RESEND_API_KEY is set" },
  { name: "MAIL_FROM", why: "From-address for outgoing mail — unset uses watchdog@ on the site domain" },
  { name: "GATETEST_HMAC_SECRET", why: "alternative to GLUECRON_CALLBACK_SECRET: signs scan-result callbacks to Gluecron with X-GateTest-Signature" },
  { name: "GATETEST_ADMIN_ORGS", why: "admin allowlist by GitHub org: members of these orgs pass the admin GitHub sign-in" },
  { name: "SENTRY_ORG", why: "pairs with SENTRY_AUTH_TOKEN — which Sentry org production-error correlation reads" },
  { name: "SENTRY_PROJECT", why: "pairs with SENTRY_AUTH_TOKEN — which Sentry project production-error correlation reads" },
  { name: "DATADOG_APP_KEY", why: "pairs with DATADOG_API_KEY — Datadog requires both to read errors" },
  { name: "DD_SITE", why: "Datadog site (e.g. datadoghq.eu) — unset uses datadoghq.com" },
  { name: "DD_SERVICE", why: "Datadog service name to read errors for" },
  { name: "SLACK_WEBHOOK_URL", why: "scan-result notifications to Slack are skipped" },
  { name: "GITLAB_CLIENT_ID", why: "customer 'Sign in with GitLab' disabled" },
  { name: "GITLAB_CLIENT_SECRET", why: "pairs with GITLAB_CLIENT_ID" },
  { name: "GLUECRON_OAUTH_CLIENT_SECRET", why: "Gluecron sign-in runs as a public PKCE client without it (still works)" },
  { name: "GLUECRON_OAUTH_BASE_URL", why: "re-points Gluecron OAuth away from GLUECRON_BASE_URL — unset means the default host" },
  { name: "SENTRY_AUTH_TOKEN", why: "production-error correlation (src/core/production-errors.js) skips Sentry" },
  { name: "DATADOG_API_KEY", why: "production-error correlation skips Datadog" },
  { name: "ROLLBAR_READ_TOKEN", why: "production-error correlation skips Rollbar" },
  { name: "GATETEST_FIX_MODEL", why: "fix model override — unset uses the engine default" },
  { name: "CONTINUOUS_AI_BUDGET_USD", why: "Continuous tier monthly AI allowance — unset defaults to 10 USD" },
  { name: "GITHUB_WEBHOOK_SECRET", why: "GitHub App webhook deliveries (/api/webhook) are refused with 503 — no push/PR scans from GitHub" },
  { name: "GITHUB_MARKETPLACE_WEBHOOK_SECRET", why: "GitHub Marketplace purchase webhook fails closed with 503" },
  { name: "GITHUB_TOKEN", why: "server GitHub token for fleet scans, build status and the watch tick (GATETEST_GITHUB_TOKEN is tried first in some routes)" },
  { name: "GATETEST_GITHUB_TOKEN", why: "preferred server GitHub token for fleet/heal routes — falls back to GITHUB_TOKEN" },
  { name: "GITHUB_OAUTH_REDIRECT_URI", why: "admin GitHub OAuth redirect override — unset derives it from NEXT_PUBLIC_BASE_URL" },
  { name: "GLUECRON_CALLBACK_SECRET", why: "bearer for the scan-result callback to Gluecron — without it (or GLUECRON_CALLBACK_URL) the callback is skipped" },
  { name: "GLUECRON_CALLBACK_URL", why: "where scan results are posted back to Gluecron — unset skips the callback" },
  { name: "GATETEST_INTERNAL_TOKEN", why: "internal /api/fixes and /api/releases/notify fall back to the admin password as their bearer" },
  { name: "GATETEST_INTERNAL_API_KEY", why: "Slack events route calls the scan API without an Authorization bearer" },
  { name: "INTEGRATIONS_SECRET", why: "external integration credentials cannot be encrypted — the integrations store refuses to save" },
  { name: "INDEXNOW_KEY", why: "IndexNow search-engine submission disabled" },
  { name: "OPENAI_API_KEY", why: "Nuclear-tier opt-in consensus second opinion disabled" },
  { name: "SENTRY_CLIENT_ID", why: "Sentry integration OAuth connect disabled" },
  { name: "SENTRY_CLIENT_SECRET", why: "pairs with SENTRY_CLIENT_ID" },
  { name: "SENTRY_WEBHOOK_SECRET_HEAL", why: "Sentry self-heal webhook deliveries cannot be verified" },
  { name: "SLACK_SIGNING_SECRET", why: "Slack events route cannot verify requests" },
  { name: "RESEND_FROM", why: "legacy From-address name for outgoing mail (MAIL_FROM is preferred)" },
  { name: "GATETEST_ADMIN_USERNAMES", why: "admin allowlist: GitHub logins for the admin GitHub OAuth; an entry with @ counts as an admin email — empty means nobody gets in that way" },
  { name: "GATETEST_ADMIN_EMAILS", why: "admin allowlist by email: a Google / GitHub / Gluecron / email+password sign-in whose provider-verified address is listed opens /admin — unset means only the password or the GitHub admin login do" },
  { name: "GATETEST_STATUS_TOKEN", why: "optional total lock in front of /api/status" },
  { name: "GATETEST_SSH_HOST", why: "self-heal SSH route disabled" },
  { name: "GATETEST_SSH_PORT", why: "self-heal SSH port — defaults to 22" },
  { name: "GATETEST_SSH_USER", why: "self-heal SSH user" },
  { name: "GATETEST_SSH_KEY", why: "self-heal SSH key (preferred over the password)" },
  { name: "GATETEST_SSH_PASSWORD", why: "self-heal SSH password fallback" },
  { name: "GATETEST_SSH_HOSTNAMES", why: "comma list of the public hostnames GATETEST_SSH_HOST serves — self-heal runs only for a scan of one of these; unset means it never runs (so scanning someone else's domain cannot run playbooks on our box)" },
  { name: "GATETEST_SECRETS_MASTER_KEY_NEXT", why: "only during a master-key rotation: new writes use it, reads accept both (docs/ops/secrets-panel.md)" },
];
const OPTIONAL_WHY = Object.freeze(Object.fromEntries(OPTIONAL_WHY_LIST.map((v) => [v.name, v.why])));

// Older env names still honored by the code that reads the canonical var
// (vapron-dispatch.js reads TALLRIG_* → VAPRON_* → CRONTECH_* through
// platform-config). A var counts as set when either the canonical name or
// any alias is set — otherwise this probe would report "missing" for a
// deployment that actually works. TALLRIG_* is canonical since the rename
// (Craig 2026-09-14); VAPRON_* is the pre-rename name a not-yet-flipped box
// still carries, CRONTECH_* the one before that.
const ALIASES = {
  TALLRIG_BASE_URL: ["VAPRON_BASE_URL", "CRONTECH_BASE_URL"],
  TALLRIG_API_TOKEN: ["VAPRON_API_TOKEN", "CRONTECH_API_TOKEN"],
  TALLRIG_DISPATCH_SECRET: ["VAPRON_DISPATCH_SECRET", "CRONTECH_DISPATCH_SECRET"],
  TALLRIG_API_KEY: ["VAPRON_API_KEY", "CRONTECH_API_KEY"],
  // gluecron-callback.js reads either name of each pair (one-definition merge
  // of the .ts and .js callbacks, which had each used one of them).
  GLUECRON_CALLBACK_SECRET: ["GATETEST_CALLBACK_SECRET"],
  GLUECRON_CALLBACK_URL: ["GLUECRON_URL"],
};

/**
 * Names the code reads that are deliberately NOT in the catalogue, grouped by
 * reason. Read only by tests/env-catalogue-drift.test.js.
 */
const IGNORED = [
  {
    reason: 'injected by the runtime / build / CI, never set by an operator in the app env file',
    names: ['NODE_ENV', 'PORT', 'HOME', 'VERCEL_ENV', 'APP_VERSION', 'GIT_COMMIT', 'GITHUB_ACTIONS',
      'GITHUB_REPOSITORY', 'GITHUB_WORKSPACE', 'GITHUB_SHA', 'PULL_DEPLOY_STATUS_FILE',
      'GITHUB_RUN_ID', 'GITHUB_SERVER_URL', 'GITHUB_EVENT_NAME', 'GITHUB_EVENT_PATH', 'GITHUB_BASE_REF', 'CI',
      'NO_COLOR', 'FORCE_COLOR', 'NODE_TEST_CONTEXT', 'GATETEST_BUILD_COMMIT'],
  },
  {
    reason: "read by the scan engine (src/) from the CUSTOMER's environment when they run the CLI — not configuration of this website",
    names: ['ADMIN_TOKEN', 'API_BASE_URL', 'CF_API_TOKEN', 'CF_ZONE_ID', 'VERCEL_TOKEN', 'GH_TOKEN',
      'SLACK_BOT_TOKEN', 'SLACK_CHANNEL', 'GATETEST_AI_GUARDRAILS_ENDPOINT', 'GATETEST_ALERT_WEBHOOK',
      'GATETEST_API_HEALTH_URL', 'GATETEST_CHAOS_URL', 'GATETEST_CONSOLE_ERRORS_URL', 'GATETEST_CROSS_BROWSER_URL',
      'GATETEST_DEPLOY_HOOK', 'GATETEST_DESIGN_COMPLIANCE_URL', 'GATETEST_FORM_TESTING_URL', 'GATETEST_INTERACTIVE_URL',
      'GATETEST_MOBILE_URL', 'GATETEST_PERF_BUDGET_URL', 'GATETEST_PURGE_WEBHOOK', 'GATETEST_REPORTS_DIR',
      'GATETEST_RESTART_HOOK', 'GATETEST_SANDBOX_TASK', 'GATETEST_SANDBOX_WORKER', 'GATETEST_VISUAL_URL',
      'GATETEST_MODEL_VERDICTS_BLOCK', 'GATETEST_NO_UPSELL', 'GATETEST_WEBHOOK_SECRET', 'GATETEST_API_KEY',
      'GATETEST_NO_QUARANTINE', 'GATETEST_OFFLINE', 'GATETEST_NO_TELEMETRY', 'GATETEST_TELEMETRY', 'GATETEST_TELEMETRY_URL',
      'GATETEST_TELEMETRY_ALLOW_HOST', 'GATETEST_REPORT_SIGNING_KEY'],
  },
  {
    reason: 'non-secret tunables and build-time public flags — they belong in the app env file, not the secrets panel',
    names: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_VERSION', 'ARENA_REPO', 'GATETEST_REPO', 'GATETEST_BADGE_ORIGIN',
      'GATETEST_PUBLIC_BASE_URL', 'GATETEST_SUPPORT_EMAIL', 'GATETEST_CHEAP_MODEL', 'GATETEST_FALLBACK_MODEL',
      'GATETEST_DAILY_API_BUDGET_USD', 'GATETEST_FIX_MAX_ATTEMPTS', 'GATETEST_LOAD_AUTO_RULES', 'GATETEST_DISABLE_CLI_ENGINE',
      'GATETEST_INPUT_USD_PER_MTOK', 'GATETEST_OUTPUT_USD_PER_MTOK', 'GATETEST_FABLE_INPUT_USD_PER_MTOK',
      'GATETEST_FABLE_OUTPUT_USD_PER_MTOK', 'GATETEST_MAX_TOKENS_FULL', 'GATETEST_MAX_TOKENS_NUCLEAR',
      'GATETEST_MAX_TOKENS_PER_SCAN', 'GATETEST_MAX_TOKENS_QUICK', 'GATETEST_MAX_TOKENS_SCAN_FIX', 'GATETEST_MAX_USD_FULL',
      'GATETEST_MAX_USD_NUCLEAR', 'GATETEST_MAX_USD_PER_SCAN', 'GATETEST_MAX_USD_QUICK', 'GATETEST_MAX_USD_SCAN_FIX',
      'NEXT_PUBLIC_LAUNCH_HN', 'NEXT_PUBLIC_LIVE_COUNTER', 'NEXT_PUBLIC_PLATFORM_API_URL', 'NEXT_PUBLIC_PLATFORM_ENTITY',
      'NEXT_PUBLIC_PLATFORM_ID', 'NEXT_PUBLIC_PLATFORM_NAME', 'NEXT_PUBLIC_PLATFORM_URL',
      'PLATFORM_SERVICE_PREFIX', 'PLATFORM_CANONICAL_HOST', 'TALLRIG_MAIL_URL', 'TALLRIG_STATUS_URL',
      'GATETEST_RELEASE_NOTIFY_ENABLED', 'GATETEST_WEB_SCAN_BUDGET_MS'],
  },
  {
    reason: "the secrets panel's own path overrides (where it writes the unit env file / reads the app env file) — never a secret",
    names: ['GATETEST_UNIT_ENV_PATH', 'GATETEST_APP_ENV_PATH'],
  },
];

// A variable holding documentation filler is NOT set. It is worse than unset:
// unset fails loudly at the first call, filler sails past every presence check
// and fails at the credential exchange, where nothing is watching.
//
// /api/status already DETECTED the fake GATETEST_PRIVATE_KEY and listed it
// under invalid_placeholders — and then computed `ready` from presence alone,
// so it answered `ready: true` / HTTP 200 for weeks while GitHub App auth
// returned 401 and every private-repo scan 502'd. The detection was never
// wired to the verdict. isSet() is that wiring.
function isSet(name, env) {
  const source = env || process.env;
  const candidates = [name, ...(ALIASES[name] || [])];
  return candidates.some((n) => {
    const v = source[n];
    if (typeof v !== "string" || v.trim().length === 0) return false;
    return inspectEnvValue(n, v).ok;
  });
}

/** Tier of a name in the catalogue, or null when the catalogue does not know it. */
function tierOf(name) {
  if (REQUIRED.some((v) => v.name === name)) return 'required';
  if (IMPORTANT.some((v) => v.name === name)) return 'important';
  if (OPTIONAL.includes(name)) return 'optional';
  return null;
}

/** Catalogue entries in display order: required, important, optional. */
function catalogueEntries() {
  return [
    ...REQUIRED.map((v) => ({ name: v.name, tier: 'required', why: v.why })),
    ...IMPORTANT.map((v) => ({ name: v.name, tier: 'important', why: v.why })),
    ...OPTIONAL.map((n) => ({ name: n, tier: 'optional', why: OPTIONAL_WHY[n] || '' })),
  ];
}

module.exports = {
  REQUIRED, IMPORTANT, OPTIONAL, OPTIONAL_WHY, ALIASES, IGNORED,
  isSet, tierOf, catalogueEntries,
};
