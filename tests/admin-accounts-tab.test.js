'use strict';
/**
 * GitHub Accounts tab + /api/admin/github-profiles — source-level guards.
 *
 * The route used to authenticate with the PLAINTEXT admin password in a
 * request header, and the tab tried to read it from a cookie JavaScript
 * cannot see (gt_admin is HttpOnly; the tab also looked for the wrong name).
 * Every call was refused and the tab said "No GitHub accounts connected
 * yet". These guards pin the fix: the route uses the shared admin gate, the
 * tab uses same-origin fetches, a failed load is an error state (never
 * "none"), and Remove is confirm-by-typing.
 *
 * Route and tab are compiled by Next, so they are pinned by source (the
 * convention tests/admin-secrets-wiring.test.js uses). Each guard has a
 * positive control so a vacuous match cannot pass.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'website');
const read = (rel) => fs.readFileSync(path.join(WEB, ...rel.split('/')), 'utf8');

const ROUTE = read('app/api/admin/github-profiles/route.ts');
const TAB = read('app/admin/tabs/AccountsTab.tsx');
const LIB = read('app/lib/admin-github-profiles.ts');

describe('/api/admin/github-profiles uses the shared admin gate', () => {
  it('imports requireAdminRoute and never reads a password header', () => {
    assert.match(ROUTE, /import \{ requireAdminRoute \} from "@\/app\/lib\/admin-guard"/);
    assert.doesNotMatch(ROUTE, /x-admin-password/i);
    assert.doesNotMatch(ROUTE, /verifyAdminPassword/);
  });

  it('GET gates first; POST and DELETE gate first with the same-origin check', () => {
    for (const [method, opts] of [['GET', /requireAdminRoute\(req\)/], ['POST', /requireAdminRoute\(req, \{ mutating: true \}\)/], ['DELETE', /requireAdminRoute\(req, \{ mutating: true \}\)/]]) {
      const body = ROUTE.slice(ROUTE.indexOf(`export async function ${method}(`)).split(/\nexport /)[0];
      assert.ok(body.length > 0, `${method} handler exists`);
      const first = body.split('\n')[1].trim();
      assert.match(first, /^const refused = /, `${method}: the gate is the first statement`);
      assert.match(first, opts, `${method}: gate options`);
      assert.match(body.split('\n')[2], /if \(refused\) return refused;/);
    }
  });

  it('a store failure answers 503 store_unavailable — never an empty list', () => {
    assert.match(LIB, /return \{ ok: false, reason: "store_unavailable" \}/);
    assert.doesNotMatch(LIB, /catch \{\s*return \[\];/);
    assert.match(ROUTE, /if \(!listed\.ok\) return NextResponse\.json\(\{ error: listed\.reason \}, \{ status: 503/);
  });
});

describe('Accounts tab talks to its API honestly', () => {
  it('never reads document.cookie or sends a password header (positive control: it does call the API)', () => {
    assert.match(TAB, /const API = "\/api\/admin\/github-profiles"/);
    assert.doesNotMatch(TAB, /document\.cookie/);
    assert.doesNotMatch(TAB, /x-admin-password/i);
    assert.doesNotMatch(TAB, /gatetest_admin/);
    assert.match(TAB, /credentials: "same-origin"/);
  });

  it('a non-OK load is an error state with its own copy, distinct from the empty list', () => {
    assert.match(TAB, /\{ kind: "error"; message: string \}/);
    assert.match(TAB, /if \(!res\.ok\) \{\s*setLoad\(\{ kind: "error", message: await describeFailure\(res, "load GitHub accounts"\) \}\)/);
    assert.match(TAB, /this is not the same as having none/);
    // The "none" copy renders only in the ok branch.
    const errIdx = TAB.indexOf('load.kind === "error" ?');
    const noneIdx = TAB.indexOf('No GitHub accounts connected yet');
    const okEmptyIdx = TAB.indexOf('load.profiles.length === 0 ?');
    assert.ok(errIdx > 0 && okEmptyIdx > errIdx && noneIdx > okEmptyIdx, 'error branch precedes the ok-and-empty branch');
  });

  it('Remove is confirm-by-typing the label', () => {
    assert.match(TAB, /if \(!removing \|\| confirmText !== removing\.label\) return;/);
    assert.match(TAB, /disabled=\{removeBusy \|\| confirmText !== p\.label\}/);
    assert.match(TAB, /method: "DELETE"/);
    assert.match(TAB, /setRemoveError\(await describeFailure\(res, "remove the account"\)\)/);
  });

  it('uses no red / orange / amber / yellow hue classes (owner design rule)', () => {
    assert.match(TAB, /className=/, 'positive control: the tab has classes');
    assert.doesNotMatch(TAB, /\b(?:text|bg|border|ring|from|to|via|fill|stroke|divide|outline|decoration|shadow|accent|caret|placeholder)-(?:red|orange|amber|yellow)-\d/);
  });
});
