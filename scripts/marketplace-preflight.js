#!/usr/bin/env node
/**
 * GitHub Marketplace submission preflight.
 *
 * The first submission was rejected on 2026-05-14. A second rejection costs
 * another review cycle, so this script mechanically verifies everything a
 * GitHub reviewer actually looks at BEFORE the Submit-for-review click.
 *
 * Every check here exists because it was found broken in a real audit:
 *
 *   - Legal URLs are the first thing a reviewer opens. Ours were serving
 *     visible "[DRAFT — requires attorney review]" markers and a privacy
 *     policy naming its email sub-processor as "TBD".
 *   - The listing promises "runs automatically on every push" and "a commit
 *     status and PR comment". With CRON_SECRET unset, /api/webhook enqueues
 *     the scan and NOTHING drains the queue — the reviewer installs, pushes,
 *     and sees nothing at all. That is the most certain way to fail review.
 *   - PR comments post via the Issues comments API, which needs issues:write.
 *     The live app was granted contents/metadata/pull_requests/statuses only.
 *   - The module count in the listing is static, manually-pasted copy, and
 *     this repo has a documented history of that number going stale.
 *   - This script itself named the WRONG App as live from 2026-08-05 to
 *     2026-09-10, and told the operator to delete the one whose private key
 *     is on the production box. Following it would have deleted production.
 *     The identity is now imported by app_id, never re-typed here.
 *   - The live App's events, description and homepage were never read at
 *     all. The audit that found the inversion found all of them wrong —
 *     push + pull_request only, a description still selling "102 modules" /
 *     "Nuclear" / "Pay per scan", checks:write granted to code that never
 *     calls Checks — while this script printed OK.
 *
 * Usage:  node scripts/marketplace-preflight.js [--base https://gatetest.io]
 * Exit 0 = safe to submit. Exit 1 = at least one BLOCKER.
 *
 * `gh`-dependent checks degrade to SKIP (not failure) when gh is unavailable
 * or unauthenticated, so the script still runs in a bare environment.
 */

'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
// The public origin, never a literal (Bible: THE DOMAIN).
const { siteUrl } = require('../src/core/site-url.js');

const ROOT = path.resolve(__dirname, '..');
const BASE = (() => {
  const i = process.argv.indexOf('--base');
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1].replace(/\/$/, '') : siteUrl();
})();

// The App's identity comes from the same file as its permissions — never
// re-typed here. This script had it INVERTED from 2026-08-05 to 2026-09-10: it
// named `gatetesthq` (app_id 3322634, `Gate-Test` org) as live and told the
// operator to delete `gatetest-hq` (app_id 3766251, `crclabs-hq` org). The
// production box says otherwise — GATETEST_APP_ID=3766251, that App's private
// key is the one installed, and a real webhook completed end to end through it
// on 2026-09-10. Following the old text would have deleted production.
//
// So: `gatetest-hq` / 3766251 / `crclabs-hq` is LIVE. `gatetesthq` / 3322634 /
// `Gate-Test` is the STALE duplicate to retire (make private, uninstall, then
// delete once nothing installs it). Never the other way round.
const {
  APP_PERMISSIONS, WEBHOOK_EVENTS, APP_SLUG, APP_ID, writeScopes,
} = require('../src/core/github-app-permissions.js');
const STALE_APP_SLUG = 'gatetesthq';
const STALE_APP_ID = 3322634;

// The app can be installed on any of Craig's accounts, so probe the known
// candidates rather than betting on one, and let --org override.
const ORG_CANDIDATES = (() => {
  const i = process.argv.indexOf('--org');
  if (i > -1 && process.argv[i + 1]) return [process.argv[i + 1]];
  return ['crclabs-hq', 'ccantynz-alt', 'Gate-Test'];
})();

// Permissions the shipped code actually calls, declared once in
// src/core/github-app-permissions.js and asserted against the real bridge call
// sites by tests/marketplace-sync.test.js. Never re-type the list here.
const REQUIRED_APP_PERMS = writeScopes();
// Every scope the code declares at any level. A grant outside this set is an
// over-grant — `checks:write` sat on the live App for code that posts through
// the Statuses API and never calls Checks.
const DECLARED_SCOPES = new Set(APP_PERMISSIONS.map((p) => p.key));

// The live module count, from the registry — the same source
// tests/module-count-sync.test.js polices the website against. Never typed.
const { BUILT_IN_MODULES } = require('../src/core/registry.js');
const LIVE_MODULE_COUNT = Object.keys(BUILT_IN_MODULES).length;

// Paid-plan language in the App's own description. The 2026-05-14 rejection
// cited exactly this; the live App still said "Pay per scan" and "Nuclear" on
// 2026-09-10 while this script printed OK.
const PAID_PLAN_RE = /pay per scan|subscription|\$\d|nuclear/i;

// Strings that must never appear in customer-facing legal copy.
const LEGAL_URLS = ['/legal/privacy', '/legal/terms', '/legal/refunds', '/legal/acceptable-use', '/legal/dpa', '/legal/sub-processors', '/legal/cookies'];
const FORBIDDEN_LEGAL = [/\bDRAFT\b/i, /requires attorney review/i, /\bTBD\b/, /to be confirmed at launch/i];

// Env vars whose absence breaks a function the listing explicitly promises.
const REQUIRED_ENV = {
  CRON_SECRET: 'the scan queue is never drained — no commit status is EVER posted (listing claims scans run on every push)',
  RESEND_API_KEY: 'transactional email cannot send — MCP-tier key delivery and the billing portal silently fail',
};

const results = [];
function record(level, name, detail) {
  results.push({ level, name, detail });
  const tag = level === 'BLOCKER' ? '\x1b[31mBLOCK\x1b[0m'
    : level === 'WARN' ? '\x1b[33m WARN\x1b[0m'
      : level === 'SKIP' ? '\x1b[90m SKIP\x1b[0m' : '\x1b[32m   OK\x1b[0m';
  console.log(`  ${tag}  ${name}${detail ? `\n         ${detail}` : ''}`);
}

async function get(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'gatetest-marketplace-preflight' } });
  return { status: res.status, body: await res.text() };
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// ---------------------------------------------------------------------------

async function checkLegal() {
  console.log('\nLegal pages (a reviewer opens these first)');
  for (const p of LEGAL_URLS) {
    const url = `${BASE}${p}`;
    let r;
    try {
      r = await get(url);
    } catch (err) {
      record('BLOCKER', `${p} unreachable`, String(err && err.message));
      continue;
    }
    if (r.status !== 200) {
      record('BLOCKER', `${p} returned HTTP ${r.status}`, 'Marketplace requires a reachable privacy policy + terms URL.');
      continue;
    }
    // Strip tags so we only match text a human actually sees.
    const visible = r.body.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ');
    const hits = FORBIDDEN_LEGAL.filter((re) => re.test(visible)).map((re) => String(re));
    if (hits.length) {
      record('BLOCKER', `${p} shows unfinished-legal markers`, `matched ${hits.join(', ')} — a reviewer reading "should not be treated as final legal terms" is the single most likely rejection trigger`);
    } else {
      record('OK', `${p} clean`);
    }
  }
}

async function checkEnv() {
  console.log('\nProduction environment (drives the functionality the listing promises)');
  let r;
  try {
    r = await get(`${BASE}/api/status`);
  } catch (err) {
    record('BLOCKER', '/api/status unreachable', String(err && err.message));
    return;
  }
  if (r.status !== 200) {
    record('BLOCKER', `/api/status returned HTTP ${r.status}`);
    return;
  }
  // Parse the real shape rather than regexing the body. /api/status returns
  // { missing_required: [...], missing_important: [{name, why}], ... } where
  // entries are objects, not bare strings. An earlier regex-based version of
  // this check silently reported "present" for vars that were in fact missing
  // — a false NEGATIVE in the one tool whose job is to prevent a rejection.
  let status;
  try {
    status = JSON.parse(r.body);
  } catch {
    record('BLOCKER', '/api/status did not return JSON', 'cannot verify production env');
    return;
  }
  const nameOf = (e) => (typeof e === 'string' ? e : e && e.name);
  const missing = new Set(
    [...(status.missing_required || []), ...(status.missing_important || [])].map(nameOf).filter(Boolean),
  );

  // A variable that is SET TO FILLER is strictly worse than one that is unset,
  // because every absence check reports it green. /api/status already detects
  // this (src/core/env-placeholder.js) and returns `invalid_placeholders` — but
  // this script used to read only the two "missing" lists, so it reproduced the
  // very trap that detector exists to close.
  //
  // Found 2026-08-12: production's GATETEST_PRIVATE_KEY was the pasted setup-doc
  // example, so GitHub App JWT auth could not work at all — no commit statuses,
  // no PR comments, nothing the listing promises. The preflight said DO NOT
  // SUBMIT for four other reasons and never mentioned the fatal one.
  const placeholders = Array.isArray(status.invalid_placeholders) ? status.invalid_placeholders : [];
  const fake = new Set(placeholders.map(nameOf).filter(Boolean));
  for (const p of placeholders) {
    const name = nameOf(p);
    record('BLOCKER', `${name} is set to a placeholder, not a real value`, `${p.reason || 'fails validation'} — "set" is not "valid"; every absence check reports this green while the feature is dead`);
  }

  for (const [key, why] of Object.entries(REQUIRED_ENV)) {
    if (missing.has(key)) record('BLOCKER', `${key} is not set in production`, why);
    else if (fake.has(key)) { /* already reported above as a placeholder — do not also claim it is present */ }
    else record('OK', `${key} present`);
  }
  if ((status.missing_required || []).length) {
    record('BLOCKER', `${status.missing_required.length} REQUIRED env var(s) unset`, status.missing_required.map(nameOf).join(', '));
  }
}

async function checkInstallUrl() {
  console.log('\nInstall + setup flow');
  for (const p of ['/github/setup', '/']) {
    try {
      const r = await get(`${BASE}${p}`);
      if (r.status === 200) record('OK', `${p} reachable`);
      else record('BLOCKER', `${p} returned HTTP ${r.status}`, 'Marketplace installation URL must resolve.');
    } catch (err) {
      record('BLOCKER', `${p} unreachable`, String(err && err.message));
    }
  }
}

function checkListingAccuracy() {
  console.log('\nListing copy vs. shipped engine');
  const listingPath = path.join(ROOT, 'integrations/marketplace/listing.md');
  if (!fs.existsSync(listingPath)) {
    record('BLOCKER', 'listing.md missing', listingPath);
    return;
  }
  const raw = fs.readFileSync(listingPath, 'utf8');
  // ONLY the fenced code blocks are pasted into the Marketplace form. The
  // surrounding prose is editorial history — it deliberately quotes the
  // REJECTED submission's "90 modules" text, and scanning it produced a false
  // positive claiming the live copy was stale. Check the shipped copy only.
  // Normalise CRLF first — on a Windows checkout the fence regex otherwise
  // never matches (`\r\n` vs `\n`) and every copy check silently no-ops.
  // Same bug class as Known Issue #49.
  const listing = [...raw.replace(/\r\n?/g, '\n').matchAll(/```[a-z]*\n([\s\S]*?)```/g)]
    .map((m) => m[1]).join('\n');
  if (!listing.trim()) {
    record('BLOCKER', 'listing.md has no fenced copy blocks to submit', listingPath);
    return;
  }

  // Live module count straight from the engine — never trust the pasted number.
  let live = null;
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'bin/gatetest.js'), '--list'], { encoding: 'utf8' });
    live = out.split('\n').filter((l) => /^ {2}[a-zA-Z]/.test(l)).length;
  } catch (err) {
    record('SKIP', 'module count not verified', String(err && err.message));
  }
  if (live) {
    const counts = [...listing.matchAll(/(\d{2,3})[- ]module/g)].map((m) => Number(m[1]));
    const wrong = [...new Set(counts.filter((c) => c !== live))];
    if (wrong.length) {
      record('BLOCKER', 'listing module count is stale', `listing says ${wrong.join('/')}, engine loads ${live}`);
    } else {
      record('OK', `module count matches engine (${live})`);
    }
  }

  // The 2026-05-14 rejection was caused by describing paid functionality on an
  // app with ~0 installs and no real Marketplace plan. Guard the regression.
  const paidPlanish = /##\s*Pricing model[\s\S]{0,400}?\b(per month|\$\d+\s*\/\s*mo|paid plan)\b/i.test(listing);
  if (paidPlanish) {
    record('BLOCKER', 'listing appears to attach a paid plan', 'this is the exact reason the 2026-05-14 submission was rejected — Free plan only until >=100 installs + verified publisher');
  } else {
    record('OK', 'pricing section is free-only');
  }
}

/**
 * Probe each candidate account until one lists the live App by slug. A 404 on
 * one org is not evidence of anything — the App only has to be installed
 * somewhere Craig owns. Everything else whose slug starts with "gatetest" is
 * collected so the stale duplicate can be named precisely.
 */
function findLiveInstallation() {
  let app = null;
  let foundOn = null;
  let reachedAny = false;
  const dupes = [];
  for (const org of ORG_CANDIDATES) {
    let installs;
    try {
      installs = JSON.parse(gh(['api', `orgs/${org}/installations`, '--jq', '{installations:[.installations[]|{app_slug,app_id,permissions}]}']));
    } catch { continue; } // error-ok — org may not exist / not be readable by this token
    reachedAny = true;
    for (const a of installs.installations) {
      if (a.app_slug === APP_SLUG && !app) { app = a; foundOn = org; }
      else if (/^gatetest/i.test(a.app_slug) && a.app_slug !== APP_SLUG) dupes.push({ ...a, org });
    }
    if (app) break;
  }
  return { app, foundOn, reachedAny, dupes };
}

function checkAppPermissions() {
  console.log('\nGitHub App permissions (vs. what the shipped code calls)');
  const { app, foundOn, reachedAny, dupes } = findLiveInstallation();

  if (!reachedAny) {
    record('SKIP', 'app permissions not checked', 'gh unavailable/unauthenticated — verify manually in the App settings');
    return;
  }
  if (!app) {
    record('BLOCKER', `${APP_SLUG} is not installed on any of ${ORG_CANDIDATES.join(', ')}`,
      'the listing claims scans run on every push; with no installation that claim cannot be demonstrated to a reviewer');
    return;
  }
  if (app.app_id !== APP_ID) {
    record('BLOCKER', `${APP_SLUG} on ${foundOn} is app_id ${app.app_id}, expected ${APP_ID}`,
      'the slug no longer names the App whose private key is on the production box (GATETEST_APP_ID) — touch neither App until this is understood');
    return;
  }
  record('OK', `${APP_SLUG} found on ${foundOn} (app_id ${app.app_id} — the App whose private key is on the box)`);
  for (const perm of REQUIRED_APP_PERMS) {
    if (app.permissions[perm] === 'write') {
      record('OK', `${perm}:write granted`);
    } else {
      // Quote the endpoints that force the scope — a reviewer-facing blocker
      // is only actionable if it says which call breaks without it.
      const declared = APP_PERMISSIONS.find((p) => p.key === perm);
      const why = declared
        ? `required by: ${declared.endpoints.join(', ')}`
        : `shipped code requires ${perm}:write`;
      record('BLOCKER', `${APP_SLUG} missing ${perm}:write`, why);
    }
  }
  // A scope granted that nothing declares is an over-grant: undisclosed to the
  // customer, and exactly what a reviewer asks about.
  for (const [key, level] of Object.entries(app.permissions || {})) {
    if (!DECLARED_SCOPES.has(key)) {
      record('WARN', `${APP_SLUG} holds ${key}:${level} that no shipped code needs`,
        'not declared in src/core/github-app-permissions.js — remove it from the App, or declare it (with the endpoint that forces it) if code now calls it');
    }
  }
  reportDuplicates(dupes);
}

/**
 * The stale duplicate. Until 2026-09-10 this warning named the LIVE App as the
 * one to delete — see the identity note at the top. It now names the stale
 * one explicitly, and says which App must never be touched.
 */
function reportDuplicates(dupes) {
  for (const d of dupes) {
    const stale = d.app_id === STALE_APP_ID || d.app_slug === STALE_APP_SLUG;
    record('WARN', `duplicate app installed: ${d.app_slug} (app_id ${d.app_id}) on ${d.org}`,
      stale
        ? `this is the STALE one — make it private, uninstall it, then delete it once nothing installs it. ${APP_SLUG} (${APP_ID}) is live; its private key is on the production box. Never delete ${APP_ID}.`
        : `not ${APP_SLUG} (${APP_ID}), the live App — identify it before a reviewer finds two`);
  }
}

/**
 * App-level config — events, description, homepage — read through the public
 * `GET /apps/{slug}` endpoint, which needs no installation and no App JWT.
 *
 * Added 2026-09-10. The audit that found the identity inversion also found the
 * live App wrong on every one of these while this script printed OK, because
 * it never read any of them: events were push + pull_request only (no
 * workflow_run, no issue_comment — CI-fix and `@gatetest ignore` could never
 * fire), and the description still sold "102 modules", "Nuclear" and "Pay per
 * scan" — the copy the 2026-05-14 rejection cited.
 */
function checkAppConfig() {
  console.log('\nGitHub App config (events, description, homepage)');
  let meta;
  try {
    meta = JSON.parse(gh(['api', `apps/${APP_SLUG}`]));
  } catch {
    record('SKIP', 'app config not checked', 'gh unavailable/unauthenticated — verify events, description and homepage manually in the App settings');
    return;
  }
  if (meta.id !== APP_ID) {
    record('BLOCKER', `apps/${APP_SLUG} resolves to app_id ${meta.id}, expected ${APP_ID}`, 'the slug and the key on the production box (GATETEST_APP_ID) disagree');
    return;
  }
  record('OK', `${APP_SLUG} is app_id ${APP_ID} (owner ${meta.owner && meta.owner.login})`);
  checkAppEvents(meta);
  checkAppDescription(meta);
  checkAppHomepage(meta);
}

/** Subscribed events must equal WEBHOOK_EVENTS — the set the code branches on. */
function checkAppEvents(meta) {
  const have = new Set(meta.events || []);
  const missing = WEBHOOK_EVENTS.filter((e) => !have.has(e));
  const extra = [...have].filter((e) => !WEBHOOK_EVENTS.includes(e));
  if (missing.length) {
    record('BLOCKER', `${APP_SLUG} not subscribed to: ${missing.join(', ')}`,
      'website/app/lib/github-events.js handles these — an unsubscribed event fails silently, the feature simply never fires');
  } else {
    record('OK', `subscribed to every event the code handles (${WEBHOOK_EVENTS.join(', ')})`);
  }
  if (extra.length) {
    record('WARN', `${APP_SLUG} subscribed to events no code handles: ${extra.join(', ')}`,
      'not in WEBHOOK_EVENTS — drop them, or declare them once a handler exists');
  }
}

/** The description is Marketplace copy: no paid-plan language, live module count. */
function checkAppDescription(meta) {
  const desc = String(meta.description || '');
  const paid = desc.match(PAID_PLAN_RE);
  if (paid) {
    record('BLOCKER', `${APP_SLUG} description contains paid-plan language ("${paid[0]}")`,
      'the 2026-05-14 rejection cited exactly this — Free plan only until >=100 installs + verified publisher');
  } else {
    record('OK', 'description carries no paid-plan language');
  }
  if (new RegExp(`\\b${LIVE_MODULE_COUNT}[- ]modules?\\b`, 'i').test(desc)) {
    record('OK', `description says ${LIVE_MODULE_COUNT} modules (matches the registry)`);
  } else {
    const stale = desc.match(/(\d{2,3})[- ]modules?/i);
    record('BLOCKER', `${APP_SLUG} description does not say ${LIVE_MODULE_COUNT} modules`,
      stale ? `it says ${stale[1]} — the registry loads ${LIVE_MODULE_COUNT}` : `it states no module count — the registry loads ${LIVE_MODULE_COUNT}`);
  }
}

/** The homepage link is the first thing a reviewer clicks. */
function checkAppHomepage(meta) {
  const want = siteUrl();
  const got = String(meta.external_url || '').replace(/\/$/, '');
  if (got === want) {
    record('OK', `external_url is ${want}`);
  } else {
    record('BLOCKER', `${APP_SLUG} external_url is ${got || '(unset)'}, expected ${want}`,
      'a dead or wrong homepage link on an App under review is the likeliest rejection trigger after the legal pages');
  }
}

/**
 * Queue drain.
 *
 * The PRIMARY driver is the pair of systemd timers on the production box
 * (`scripts/deploy/systemd/`), which read CRON_SECRET from the box's own
 * website/.env.local. The `cron-ticks` GitHub Actions workflow is an explicitly
 * OPTIONAL second driver — see scripts/deploy/systemd/README.md: "The Actions
 * workflow can stay as a second driver if its secret is ever set — both ticks
 * are idempotent." Keeping the drain on the box is also what Forbidden #3 wants:
 * a critical user flow should not hang off an external system.
 *
 * So a disarmed Actions workflow is NOT a submission blocker, and calling it one
 * was this script's own crying-wolf bug (2026-08-12 audit): it sent the operator
 * chasing a redundant driver while implying the queue was dead. The timers
 * cannot be observed from off-box, so the honest output is a WARN naming the one
 * command that answers it.
 */
function checkCronArmed() {
  console.log('\nQueue drain (the listing claims scans run on every push)');
  const VERIFY = 'the box timers are the primary drain and cannot be checked from here — on the box run: systemctl list-timers gatetest-tick.timer gatetest-watches.timer';
  try {
    const out = gh(['run', 'list', '--workflow=cron-ticks.yml', '--limit', '1', '--json', 'conclusion,databaseId']);
    const runs = JSON.parse(out);
    if (!runs.length) {
      record('WARN', 'optional Actions cron has never run', VERIFY);
      return;
    }
    const log = gh(['run', 'view', String(runs[0].databaseId), '--log']);
    if (/disarmed|CRON_SECRET repo secret is NOT SET/i.test(log)) {
      record('WARN', 'optional Actions cron is disarmed (CRON_SECRET repo secret unset)', VERIFY);
    } else if (/401/.test(log)) {
      // A 401 IS worth blocking on: the secret exists but disagrees with the
      // host, which usually means the box value was rotated without updating
      // everything that points at it.
      record('BLOCKER', 'cron tick returned 401', 'the repo CRON_SECRET does not match the one on the production host');
    } else {
      record('OK', 'Actions cron armed and ticking (second driver)');
    }
  } catch {
    record('SKIP', 'cron status not checked', `gh unavailable — ${VERIFY}`);
  }
}

// ---------------------------------------------------------------------------

(async function main() {
  console.log(`GitHub Marketplace preflight — target ${BASE}`);
  await checkLegal();
  await checkEnv();
  await checkInstallUrl();
  checkListingAccuracy();
  checkAppPermissions();
  checkAppConfig();
  checkCronArmed();

  const blockers = results.filter((r) => r.level === 'BLOCKER');
  const warns = results.filter((r) => r.level === 'WARN');
  console.log(`\n${'─'.repeat(70)}`);
  if (blockers.length === 0) {
    console.log(`\x1b[32mREADY TO SUBMIT\x1b[0m — 0 blockers, ${warns.length} warning(s).`);
    process.exit(0);
  }
  console.log(`\x1b[31mDO NOT SUBMIT\x1b[0m — ${blockers.length} blocker(s), ${warns.length} warning(s):\n`);
  for (const b of blockers) console.log(`  • ${b.name}\n      ${b.detail || ''}`);
  console.log('\nEach blocker above would be visible to the GitHub reviewer.');
  process.exit(1);
})().catch((err) => {
  console.error('preflight crashed:', err && err.stack);
  process.exit(1);
});
