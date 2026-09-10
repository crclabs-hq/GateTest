/**
 * The Marketplace listing, the install page, and the live App must describe the
 * SAME product as the shipped code.
 *
 * Craig's rule, 2026-08-05: "whatever we do we have to be in sync with the
 * website and our github marketplace listing and marketplace app."
 * `tests/module-count-sync.test.js` already enforces that rule for the module
 * count. This file enforces it for everything else a GitHub reviewer opens.
 *
 * ── Why a test and not a checklist ──────────────────────────────────────────
 * On 2026-08-05 all three surfaces disagreed about `Contents`, and had for long
 * enough that nobody knew which was right. The install page said `Read`. The
 * listing said `Read`. The preflight script asserted `write`. The engine
 * settles it: the App-installed path in `/api/scan/fix` pushes an auto-fix
 * branch, so GitHub asks the installing user for write access to code — our
 * copy was promising LESS than the install prompt requests, which is the exact
 * disclosure mismatch a Marketplace reviewer audits. The listing had also
 * carried a note for weeks asking a human to go resolve the contradiction.
 *
 * A note asking someone to check is not enforcement. This is.
 *
 * ── The direction drift actually travels ────────────────────────────────────
 * The highest-value assertion here is `every endpoint the bridge calls is a
 * scope we declare`. Copy going stale is the symptom; code quietly gaining an
 * API call that needs a scope nobody disclosed is the cause. That one fails
 * BEFORE the App 403s in a customer's repo.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  APP_PERMISSIONS,
  WEBHOOK_EVENTS,
  APP_SLUG,
  APP_ID,
  permission,
  scopeForRequest,
  satisfies,
  permissionTableRows,
} = require('../src/core/github-app-permissions.js');
const { siteUrl } = require('../src/core/site-url.js');

const REPO = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n?/g, '\n');

const LISTING = 'integrations/marketplace/listing.md';
const SETUP_PAGE = 'website/app/github/setup/page.tsx';
const PREFLIGHT = 'scripts/marketplace-preflight.js';

/**
 * Files that reach GitHub's API with an installation token. Each one's call
 * sites are proof of what the App must be granted.
 */
// pr-pruner.js was listed here until 2026-09-05; deadCode's orphan-file rule
// (KI #96) showed nothing imported it, and a file that never runs calls no API.
const BRIDGE_FILES = ['src/core/github-bridge.js'];

/** `this._api('POST', `/repos/...`)` / `this._req('DELETE', `/repos/...`)`. */
const CALL_RE = /_(?:api|req)\(\s*'(GET|POST|PATCH|PUT|DELETE)'\s*,\s*`([^`]+)`/g;

/** Strip `${...}` interpolation so paths compare structurally. */
const shape = (p) => p.replace(/\$\{[^}]*\}/g, '{x}').split('?')[0];

describe('marketplace sync — code, listing, install page, and App agree', () => {
  describe('the declared scopes cover what the code actually calls', () => {
    const calls = [];
    for (const file of BRIDGE_FILES) {
      const src = read(file);
      for (const m of src.matchAll(CALL_RE)) {
        calls.push({ file, method: m[1], apiPath: shape(m[2]) });
      }
    }

    it('finds real call sites — the scan is not vacuous', () => {
      // Without this, a rename of `_api` would silently make every assertion
      // below pass by matching nothing.
      assert.ok(
        calls.length > 10,
        `expected to find the bridge's GitHub calls; found ${calls.length}. `
        + 'Did the request helper get renamed? Update CALL_RE.',
      );
    });

    it('every endpoint the bridge calls maps to a scope we declare', () => {
      const undeclared = [];
      for (const c of calls) {
        const required = scopeForRequest(c.method, c.apiPath);
        if (!required) {
          undeclared.push(`${c.file}: ${c.method} ${c.apiPath} — no scope rule matches`);
          continue;
        }
        const declared = permission(required.key);
        if (!declared) {
          undeclared.push(`${c.file}: ${c.method} ${c.apiPath} — needs '${required.key}', which APP_PERMISSIONS does not declare`);
        } else if (!satisfies(declared.level, required.level)) {
          undeclared.push(
            `${c.file}: ${c.method} ${c.apiPath} — needs ${required.key}:${required.level}, `
            + `but APP_PERMISSIONS declares ${required.key}:${declared.level}`,
          );
        }
      }
      assert.deepStrictEqual(
        undeclared, [],
        'The App calls an endpoint it has not been granted. This does not fail in CI — it fails as a '
        + '403 in a customer\'s repo, silently, after they installed us.\n'
        + 'Fix: add or raise the scope in src/core/github-app-permissions.js, then grant it on the live App.',
      );
    });

    it('declares no scope the code does not use', () => {
      // Over-broad scope is its own rejection risk: reviewers ask why a code
      // quality tool wants permissions it never exercises.
      const used = new Set();
      for (const c of calls) {
        const required = scopeForRequest(c.method, c.apiPath);
        if (required) used.add(required.key);
      }
      const unused = APP_PERMISSIONS.map((p) => p.key).filter((k) => !used.has(k));
      assert.deepStrictEqual(
        unused, [],
        'Scope declared but never called — drop it rather than ask a reviewer to justify it.',
      );
    });
  });

  describe('the Marketplace listing matches the declaration', () => {
    const listing = read(LISTING);

    it('states every permission at the declared level', () => {
      const missing = permissionTableRows().filter((row) => !listing.includes(row));
      assert.deepStrictEqual(
        missing, [],
        `${LISTING} permission table has drifted from src/core/github-app-permissions.js. `
        + 'Copy the rows exactly — a reviewer compares this table against the live App.',
      );
    });

    it('subscribes to every webhook event the handler branches on', () => {
      const handler = read('website/app/lib/github-events.js');
      for (const event of WEBHOOK_EVENTS) {
        assert.ok(
          new RegExp(`eventType === ['"]${event}['"]`).test(handler),
          `github-events.js does not handle '${event}', but it is declared as required. `
          + 'Either the handler lost a branch or the declaration is stale.',
        );
        assert.ok(
          listing.includes(`\`${event}\``),
          `${LISTING} does not list the '${event}' webhook event. An event handled in code but not `
          + 'subscribed on the live App fails silently — nothing errors, the feature just never fires.',
        );
      }
    });

    it('points at the live domain, never the dead one', () => {
      // gatetest.ai entered registry redemption 2026-07-29 and returns
      // NXDOMAIN. A reviewer clicking through from the listing to a dead site
      // is a certain rejection. Email addresses are deliberately exempt — the
      // Bible keeps @gatetest.ai until Resend verifies the .io domain.
      const origin = siteUrl();
      const dead = [];
      listing.split('\n').forEach((line, i) => {
        const withoutEmail = line.replace(/[\w.+-]+@gatetest\.ai/g, '');
        if (/https?:\/\/(?:www\.)?gatetest\.ai/.test(withoutEmail)) {
          dead.push(`${LISTING}:${i + 1} — ${line.trim().slice(0, 100)}`);
        }
      });
      assert.deepStrictEqual(
        dead, [],
        `The listing links to gatetest.ai, which returns NXDOMAIN. Use ${origin}.`,
      );
    });

    it('keeps the pricing section free-only', () => {
      // The 2026-05-14 rejection was for describing paid functionality on an
      // app with ~0 installs and no real Marketplace plan. Craig: "I may not
      // get the third opportunity."
      const pricing = listing.split('## Pricing model')[1] || '';
      const section = pricing.split('\n## ')[0];
      assert.ok(
        !/\b(per month|\$\d+\s*\/\s*mo|paid plan)\b/i.test(section),
        'The listing appears to attach a paid Marketplace plan. That is the exact reason the '
        + '2026-05-14 submission was rejected — Free plan only until >=100 installs + verified publisher.',
      );
    });
  });

  describe('the install page and preflight read the declaration', () => {
    it('the install page renders permissions from the source of truth', () => {
      const page = read(SETUP_PAGE);
      assert.ok(
        /from ["']@\/app\/lib\/github-app-permissions["']/.test(page),
        `${SETUP_PAGE} must import APP_PERMISSIONS rather than restate the list. `
        + 'A hand-written copy here is what put "Contents: Read" in front of customers while '
        + 'GitHub was asking them for write access.',
      );
      // The page is what the user reads before clicking Install, so it must
      // name every scope GitHub will request.
      for (const p of APP_PERMISSIONS) {
        assert.ok(
          !new RegExp(`perm:\\s*["']${p.display}["']`).test(page),
          `${SETUP_PAGE} hardcodes a row for "${p.display}". Delete it — the list is generated.`,
        );
      }
    });

    it('preflight asserts against the source of truth', () => {
      const preflight = read(PREFLIGHT);
      assert.ok(
        /require\(['"]\.\.\/src\/core\/github-app-permissions\.js['"]\)/.test(preflight),
        `${PREFLIGHT} must import the declaration, not re-type the permission list.`,
      );
      assert.ok(
        !/const REQUIRED_APP_PERMS = \[['"]/.test(preflight),
        `${PREFLIGHT} still hardcodes REQUIRED_APP_PERMS — derive it from writeScopes().`,
      );
    });

    it('preflight blocks on placeholder env values, not just missing ones', () => {
      // 2026-08-12: production's GATETEST_PRIVATE_KEY held the pasted setup-doc
      // example, so GitHub App JWT auth was dead — no commit statuses, no PR
      // comments. /api/status detects this and returns `invalid_placeholders`,
      // but the preflight read only the two "missing" lists, so it printed DO
      // NOT SUBMIT for four lesser reasons and never named the fatal one.
      // "Set" is not "valid"; a var set to filler defeats every absence check.
      const preflight = read(PREFLIGHT);
      assert.ok(
        /invalid_placeholders/.test(preflight),
        `${PREFLIGHT} must consume /api/status's invalid_placeholders — a var set to filler passes every "is it missing?" check while the feature it powers is dead.`,
      );
    });

    it('preflight audits the App whose private key is on the production box', () => {
      // INVERTED from 2026-08-05 to 2026-09-10: this test and the preflight
      // named `gatetesthq` (3322634, `Gate-Test` org) as live and told the
      // operator to delete `gatetest-hq` (3766251, `crclabs-hq` org). The box
      // says GATETEST_APP_ID=3766251, and a real webhook completed end to end
      // through it on 2026-09-10. Following the old text would have deleted
      // production. The identity is imported, and the stale one is pinned by
      // id so the duplicate warning can never again point at the live App.
      assert.strictEqual(APP_SLUG, 'gatetest-hq');
      assert.strictEqual(APP_ID, 3766251);
      const preflight = read(PREFLIGHT);
      assert.ok(
        /\bAPP_SLUG,\s*APP_ID\b[\s\S]*?require\(['"]\.\.\/src\/core\/github-app-permissions\.js['"]\)/.test(preflight),
        `${PREFLIGHT} must import APP_SLUG + APP_ID from the declaration, never re-type the identity.`,
      );
      assert.ok(
        /'crclabs-hq'/.test(preflight),
        `${PREFLIGHT} must probe crclabs-hq, which owns the live gatetest-hq app (3766251).`,
      );
      assert.ok(
        /STALE_APP_SLUG = 'gatetesthq'/.test(preflight) && /STALE_APP_ID = 3322634/.test(preflight),
        `${PREFLIGHT} must pin gatetesthq (3322634) as the STALE duplicate, by slug and id.`,
      );
      assert.ok(
        !/\bAPP_SLUG = 'gatetesthq'/.test(preflight) && !/\bAPP_ID = 3322634/.test(preflight),
        `${PREFLIGHT} names gatetesthq (3322634) as canonical — that is the stale duplicate, not the App whose key is on the box.`,
      );
    });

    it('preflight audits the App config the 2026-09-10 audit found wrong', () => {
      // The live App had push + pull_request only, a description selling
      // "102 modules" / "Nuclear" / "Pay per scan", checks:write nobody
      // uses, and the preflight said OK — because it never read any of it.
      const preflight = read(PREFLIGHT);
      assert.ok(
        /\bWEBHOOK_EVENTS\b/.test(preflight) && /meta\.events/.test(preflight),
        `${PREFLIGHT} must compare the App's subscribed events against WEBHOOK_EVENTS.`,
      );
      assert.ok(
        /pay per scan\|subscription\|\\\$\\d\|nuclear/i.test(preflight),
        `${PREFLIGHT} must reject paid-plan language in the App description.`,
      );
      assert.ok(
        /BUILT_IN_MODULES/.test(preflight) && /LIVE_MODULE_COUNT/.test(preflight),
        `${PREFLIGHT} must derive the module count from the registry, never a typed number.`,
      );
      assert.ok(
        /DECLARED_SCOPES/.test(preflight),
        `${PREFLIGHT} must warn on a granted scope that no shipped code declares (over-grant).`,
      );
      assert.ok(
        /external_url/.test(preflight) && /siteUrl\(\)/.test(preflight) && !/'https:\/\/gatetest\.io'/.test(preflight),
        `${PREFLIGHT} must check external_url against siteUrl(), not a domain literal.`,
      );
    });
  });
});
