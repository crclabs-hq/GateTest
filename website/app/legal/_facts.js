/**
 * Legal facts — the ONE place every legal / policy document gets its facts.
 *
 * Never type a domain, an e-mail address, a retention window, a vendor, or a
 * module list into a legal page. Import it from here. Where a fact is owned
 * by runtime code (session lifetime, telemetry opt-out, the modules the
 * hosted engine refuses to run) `tests/legal-facts.test.js` fails the suite
 * if this file drifts from the code — generated over typed.
 *
 * Plain CommonJS on purpose: importable by the Next pages (like site-url.js)
 * AND require()-able by node:test without a TS loader.
 *
 * Everything here was verified against the codebase on 2026-09-10. If a fact
 * below is NOT true of the code any more, fix the fact, not the page.
 */
const { SUPPORT_EMAIL, siteUrl, siteHost } = require('../lib/site-url');

/** Trading name used in every document. Registered entity + postal address
 *  are supplied by the operator; until then documents identify the trading
 *  name and the e-mail contact only (never a placeholder string). */
const LEGAL_ENTITY = 'GateTest';
/** @type {string|null} */
const POSTAL_ADDRESS = null;

const GOVERNING_LAW = 'New Zealand';
const VENUE = 'Auckland, New Zealand';
const ARBITRATION_SEAT = 'Auckland, New Zealand';

/** Rebuilt document set. Refunds keeps its own earlier date. */
const EFFECTIVE_DATE = '2026-09-10';

/** Liability posture carried over from the prior drafts. */
const LIABILITY_FLOOR_USD = 100;
const LIABILITY_LOOKBACK_MONTHS = 12;

/** Retention windows that are ENFORCED by code (each has a drift test). */
const SESSION_DAYS = 30; // customer-session.ts CUSTOMER_MAX_AGE_SECONDS
const OAUTH_STATE_MINUTES = 10; // api/auth/*/route.ts maxAge 600
const ADMIN_COOKIE_HOURS = 24; // admin-auth.ts COOKIE_MAX_AGE
const AUDIT_LOG_YEARS = 7; // audit-log-store.js DEFAULT_RETENTION_YEARS
const REPO_SNAPSHOT_SECONDS = 120; // gluecron-client.ts SNAPSHOT_TTL_MS
const AI_PROVIDER_RETENTION_DAYS = 30; // engine-models.js — standard retention, NOT zero-data-retention

/** Telemetry opt-outs honoured by the CLI / engine (scan-telemetry.js). */
const TELEMETRY_OPT_OUT_ENV = 'GATETEST_NO_TELEMETRY';
const TELEMETRY_OPT_OUT_CONFIG = '"telemetry": false';

/** Modules the HOSTED engine never runs on our infrastructure, because they
 *  would execute customer-controlled code (cli-engine-runner.js). Kept in
 *  sync by tests/legal-facts.test.js. */
const HOSTED_UNSAFE_MODULES = ['mutation', 'chaos', 'unitTests', 'integrationTests', 'e2e', 'lint'];

/**
 * @typedef {Object} SubProcessor
 * @property {string} name
 * @property {string} entity
 * @property {string} purpose
 * @property {string} data
 * @property {string} location
 * @property {'core'|'important'|'optional'} scope
 * @property {string} terms
 */

/** Every third party that processes customer data, with what it receives.
 *  "optional" entries only apply when the customer turns the feature on.
 *  @type {SubProcessor[]} */
const SUB_PROCESSORS = [
  { name: 'Anthropic', entity: 'Anthropic, PBC', purpose: 'AI analysis and auto-fix generation', data: "File contents, file paths and finding text for files being reviewed or fixed; prompts. Standard 30-day API retention; not used for model training under Anthropic's commercial terms.", location: 'United States', scope: 'core', terms: 'https://www.anthropic.com/legal/commercial-terms' },
  { name: 'Stripe', entity: 'Stripe, Inc.', purpose: 'Payments, subscriptions, billing portal', data: 'E-mail, payment card details (entered on Stripe-hosted pages, never on ours), tier, repository URL, module names and issue counts attached to the payment record.', location: 'United States', scope: 'core', terms: 'https://stripe.com/legal/dpa' },
  { name: 'Neon', entity: 'Neon, Inc.', purpose: 'Managed PostgreSQL database', data: 'Account e-mail and git-host login, repository URLs, scan findings (messages, file paths, line numbers), payment identifiers, API keys, audit log.', location: 'United States', scope: 'core', terms: 'https://neon.tech/dpa' },
  { name: 'Vultr', entity: 'The Constant Company, LLC', purpose: 'Production servers', data: 'Everything processed by the application, including repository contents held on disk for the duration of a scan.', location: 'United States', scope: 'core', terms: 'https://www.vultr.com/legal/dpa/' },
  { name: 'Cloudflare', entity: 'Cloudflare, Inc.', purpose: 'Domain registration and DNS', data: 'DNS queries for our domain. Traffic is not proxied through Cloudflare.', location: 'United States', scope: 'core', terms: 'https://www.cloudflare.com/cloudflare-customer-dpa/' },
  { name: 'GitHub', entity: 'GitHub, Inc.', purpose: 'Git host, sign-in, GitHub App', data: 'Sign-in identity (login, e-mail), repository contents read for scanning, commit statuses, pull-request comments and auto-fix branches written back.', location: 'United States', scope: 'core', terms: 'https://docs.github.com/site-policy/privacy-policies/github-data-protection-agreement' },
  { name: 'Gluecron', entity: 'Gluecron', purpose: 'Alternative git host', data: 'Push events, repository contents read for scanning, scan results written back. Only when you connect a Gluecron repository.', location: 'New Zealand / United States', scope: 'important', terms: 'https://gluecron.com' },
  { name: 'Sentry', entity: 'Functional Software, Inc.', purpose: 'Error monitoring and session replay', data: 'Error reports with request URL, headers and IP address; sampled browser session replays (10% of sessions, 100% of sessions with an error). Request bodies, source code, prompts, keys and cookies are scrubbed before sending.', location: 'United States', scope: 'core', terms: 'https://sentry.io/legal/dpa/' },
  { name: 'Resend', entity: 'Resend, Inc.', purpose: 'Transactional e-mail', data: 'Recipient e-mail address and message content (receipts, API keys, scan digests).', location: 'United States', scope: 'important', terms: 'https://resend.com/legal/dpa' },
  { name: 'Vapron', entity: 'Vapron', purpose: 'Live-URL scanning dispatch', data: 'Target URL, scan id and suite for website / WordPress URL scans only. Never repository contents.', location: 'United States', scope: 'important', terms: 'https://vapron.ai' },
  { name: 'OpenAI', entity: 'OpenAI, L.L.C.', purpose: 'Optional second-opinion consensus on Forensic-tier fixes', data: 'File contents and finding text for the files being fixed. Only when you opt in to consensus on a Forensic scan.', location: 'United States', scope: 'optional', terms: 'https://openai.com/policies/data-processing-addendum' },
  { name: 'Slack', entity: 'Slack Technologies, LLC', purpose: 'Scan notifications to a webhook you supply', data: 'Scan summaries (repository, verdict, counts).', location: 'United States', scope: 'optional', terms: 'https://slack.com/terms-of-service/data-processing' },
];

/**
 * @typedef {Object} CookieFact
 * @property {string} name
 * @property {'cookie'|'localStorage'} kind
 * @property {string} purpose
 * @property {string} duration
 * @property {boolean} essential
 */

/** Every cookie and browser-storage key the application sets. There are no
 *  advertising or cross-site tracking cookies. @type {CookieFact[]} */
const COOKIES = [
  { name: 'gatetest_customer', kind: 'cookie', purpose: 'Your signed-in session. Encrypted (AES-256-GCM) and signed; HttpOnly; SameSite=Lax; Secure.', duration: `${SESSION_DAYS} days`, essential: true },
  { name: 'gh_oauth_state / gl_oauth_state / goog_oauth_state', kind: 'cookie', purpose: 'One-time anti-forgery token while you sign in with GitHub, GitLab or Google.', duration: `${OAUTH_STATE_MINUTES} minutes`, essential: true },
  { name: 'gt_admin, gatetest_admin_session', kind: 'cookie', purpose: 'Operator console sessions. Only set for GateTest staff.', duration: `${ADMIN_COOKIE_HOURS} hours / 7 days`, essential: true },
  { name: 'gatetest-chat-history-v1', kind: 'localStorage', purpose: 'Keeps your on-site support chat transcript in your own browser. Never sent to us as a whole.', duration: 'Until you clear site data', essential: false },
  { name: 'Sentry session replay', kind: 'localStorage', purpose: 'Our error-monitoring provider may store a short buffer to reconstruct what happened before an error.', duration: 'Session', essential: false },
];

module.exports = {
  SUPPORT_EMAIL, siteUrl, siteHost,
  LEGAL_ENTITY, POSTAL_ADDRESS, GOVERNING_LAW, VENUE, ARBITRATION_SEAT,
  EFFECTIVE_DATE, LIABILITY_FLOOR_USD, LIABILITY_LOOKBACK_MONTHS,
  SESSION_DAYS, OAUTH_STATE_MINUTES, ADMIN_COOKIE_HOURS, AUDIT_LOG_YEARS,
  REPO_SNAPSHOT_SECONDS, AI_PROVIDER_RETENTION_DAYS,
  TELEMETRY_OPT_OUT_ENV, TELEMETRY_OPT_OUT_CONFIG,
  HOSTED_UNSAFE_MODULES, SUB_PROCESSORS, COOKIES,
};
