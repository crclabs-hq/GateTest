'use strict';
/**
 * The GitHub App's permission scopes and webhook events — one declaration,
 * read by every surface that has to state them.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * Three surfaces describe the same App, and on 2026-08-05 all three disagreed:
 *
 *   | Surface                                  | Contents      | Issues  |
 *   |------------------------------------------|---------------|---------|
 *   | website/app/github/setup/page.tsx        | Read          | absent  |
 *   | integrations/marketplace/listing.md      | Read          | R&W     |
 *   | scripts/marketplace-preflight.js         | write         | write   |
 *
 * The engine is the tie-breaker, and it says both are wrong: the App path in
 * `/api/scan/fix` resolves an installation token and then calls
 * `POST /repos/{o}/{r}/git/refs` + `POST .../git/commits` to open the auto-fix
 * branch. That is `contents: write`, not read. PR comments post through
 * `POST .../issues/{n}/comments`, which is `issues: write`.
 *
 * Two of those disagreements are the kind a Marketplace reviewer opens the
 * listing to check:
 *   - the install prompt discloses LESS than GitHub will actually ask for
 *     (we said Read, GitHub says "Read and write access to code") — a
 *     disclosure mismatch, which is exactly what a reviewer audits;
 *   - the preflight script that exists to prevent a third rejection was
 *     asserting against a hand-maintained list that nothing kept honest.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * Never hand-write a permission list. Import `APP_PERMISSIONS`.
 * `tests/marketplace-sync.test.js` fails the suite if a surface drifts, and —
 * more importantly — if the bridge starts calling an endpoint that needs a
 * scope this file does not declare. That is the direction drift actually
 * travels: code gains a call, disclosure silently goes stale.
 *
 * This lives in `src/core/` rather than `website/` because the published npm
 * package ships `src/` + `bin/` without `website/`, and because the preflight
 * script and the test runner both need it outside a Next build.
 */

/**
 * Every scope the shipped code forces us to request, why it is needed, and the
 * exact endpoints that force it.
 *
 * `level` is the machine-readable scope ('read' | 'write') used for assertions.
 * `label` is the human string GitHub itself shows, used in customer copy.
 * `why` is customer-facing — it appears on the install page, so it explains a
 * benefit, not an endpoint.
 */
const APP_PERMISSIONS = [
  {
    key: 'contents',
    display: 'Contents',
    level: 'write',
    label: 'Read & write',
    why: 'Read your code to scan it, and push the auto-fix branch — code is never stored',
    endpoints: [
      'GET /repos/{owner}/{repo}/tarball/{ref}',
      'POST /repos/{owner}/{repo}/git/refs',
      'POST /repos/{owner}/{repo}/git/commits',
      'DELETE /repos/{owner}/{repo}/git/refs/heads/{branch}',
    ],
  },
  {
    key: 'pull_requests',
    display: 'Pull requests',
    level: 'write',
    label: 'Read & write',
    why: 'Open the auto-fix PR and leave inline review comments',
    endpoints: [
      'POST /repos/{owner}/{repo}/pulls',
      'PATCH /repos/{owner}/{repo}/pulls/{number}',
      'POST /repos/{owner}/{repo}/pulls/{number}/comments',
    ],
  },
  {
    key: 'statuses',
    display: 'Commit statuses',
    level: 'write',
    label: 'Read & write',
    why: 'Green ✅ or red ❌ on each commit',
    endpoints: ['POST /repos/{owner}/{repo}/statuses/{sha}'],
  },
  {
    key: 'issues',
    display: 'Issues',
    level: 'write',
    label: 'Read & write',
    why: 'Post the scan summary as a PR comment',
    endpoints: [
      'POST /repos/{owner}/{repo}/issues/{number}/comments',
      'PATCH /repos/{owner}/{repo}/issues/comments/{id}',
    ],
  },
  {
    key: 'metadata',
    display: 'Metadata',
    level: 'read',
    label: 'Read',
    why: 'Know which repos to watch',
    endpoints: ['GET /repos/{owner}/{repo}'],
  },
];

/**
 * Webhook events the App must subscribe to.
 *
 * Ground truth is `website/app/lib/github-events.js`, which branches on
 * `eventType` for exactly these three. An event handled in code but not
 * subscribed on the live App fails silently — nothing errors, the feature
 * simply never fires. `workflow_run` was missing from the listing for exactly
 * this reason, and CI-fix never ran on the App path.
 */
// `issue_comment` added 2026-08-25 for suppression-in-place: a repo
// insider replies `@gatetest ignore <rule>` under the PR comment and the
// webhook commits the rule to .gatetestignore on the PR branch.
const WEBHOOK_EVENTS = ['push', 'pull_request', 'workflow_run', 'issue_comment'];

/**
 * Which scope an API path requires. Ordered — first match wins, so the
 * specific patterns must precede the general ones (`/issues/{n}/comments`
 * before a bare `/repos/{o}/{r}` metadata match).
 *
 * Used by the drift test to walk the bridge's real call sites and prove every
 * one is covered by a declared scope. Adding an endpoint the engine calls
 * without adding it here fails the test rather than shipping an App that 403s
 * in a customer's repo.
 */
const PATH_SCOPES = [
  { re: /\/statuses(\/|$)/, key: 'statuses' },
  { re: /\/issues\/[^/]+\/comments|\/issues\/comments\//, key: 'issues' },
  { re: /\/pulls(\/|\?|$)/, key: 'pull_requests' },
  // `git/ref` (singular, the read form) as well as `git/refs` — the bridge
  // uses both, and matching only the plural let a real call site through.
  { re: /\/git\/(refs?|commits|trees|blobs)|\/tarball|\/zipball|\/contents\/|\/commits(\/|\?|$)|\/branches(\/|\?|$)/, key: 'contents' },
  { re: /^\/repos\/[^/]+\/[^/]+$/, key: 'metadata' },
];

/** Read is satisfied by write; write is not satisfied by read. */
const LEVEL_RANK = { read: 1, write: 2 };

/** Look up a declared permission by its GitHub scope key. */
function permission(key) {
  return APP_PERMISSIONS.find((p) => p.key === key) || null;
}

/**
 * The scope an HTTP method + path pair requires, or null if the path is not
 * one we recognise. Non-GET methods escalate the requirement to write.
 */
function scopeForRequest(method, apiPath) {
  const match = PATH_SCOPES.find((s) => s.re.test(apiPath));
  if (!match) return null;
  const level = String(method).toUpperCase() === 'GET' ? 'read' : 'write';
  return { key: match.key, level };
}

/** True when the declared scope covers the required one. */
function satisfies(declaredLevel, requiredLevel) {
  return (LEVEL_RANK[declaredLevel] || 0) >= (LEVEL_RANK[requiredLevel] || 0);
}

/** Scope keys the App must hold at write level, e.g. for preflight assertions. */
function writeScopes() {
  return APP_PERMISSIONS.filter((p) => p.level === 'write').map((p) => p.key);
}

/**
 * The permission table as Markdown rows, so the Marketplace listing renders
 * from this file instead of restating it. Header excluded — the listing owns
 * its own table framing.
 */
function permissionTableRows() {
  return APP_PERMISSIONS.map((p) => `| **${p.display} permission** | ${p.label} |`);
}

/**
 * The App's identity — declared next to its permissions for the same reason.
 *
 * Two Apps exist: `gatetest-hq` (3766251, owned by `crclabs-hq`) is LIVE;
 * `gatetesthq` (3322634, owned by `Gate-Test`) is the stale one. Until
 * 2026-09-09 the install button, the API docs and two error messages each
 * hand-wrote the stale App's URL (GitHub slugs are case-insensitive, so the
 * mixed-case spelling resolved to it too) and sent every customer there.
 * Import `appInstallUrl()`; `tests/github-app-identity.test.js` fails on a
 * literal slug anywhere in runtime code — comments included.
 */
const APP_SLUG = 'gatetest-hq';
const APP_ID = 3766251;

/** The App's public GitHub page, where the Install button lives. */
function appInstallUrl() {
  return `https://github.com/apps/${APP_SLUG}`;
}

module.exports = {
  APP_PERMISSIONS,
  WEBHOOK_EVENTS,
  PATH_SCOPES,
  APP_SLUG,
  APP_ID,
  appInstallUrl,
  permission,
  scopeForRequest,
  satisfies,
  writeScopes,
  permissionTableRows,
};
