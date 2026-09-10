/**
 * The site must send customers to the App that is actually live.
 *
 * Two GitHub Apps exist. `gatetest-hq` (3766251, owned by `crclabs-hq`) is
 * the live one; `gatetesthq` (3322634) is stale. On 2026-09-09 the install
 * button on /github/setup, the API docs, and two error messages each
 * hand-wrote `github.com/apps/GateTestHQ` — and because GitHub slugs are
 * case-insensitive, every one of them sent the customer to the stale App. A
 * Marketplace reviewer clicking Install landed on the wrong product.
 *
 * The Bible forbids hand-written App facts: they come from
 * `src/core/github-app-permissions.js` and nowhere else. This file is the
 * tripwire — the identity is pinned, every `github.com/apps/` in runtime
 * code must be built from the import, and the website re-export must expose
 * exactly what the engine declares.
 *
 * It also guards the post-install callback: GitHub sends the customer to the
 * App's Setup URL, and behind the box's reverse proxy `req.url` is the
 * INTERNAL origin. Building the redirect on it produced
 * `307 -> https://10.0.1.1:3000/github/installed` for every installer.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const engine = require('../src/core/github-app-permissions.js');
const web = require('../website/app/lib/github-app-permissions.js');
const { siteUrl, siteHost } = require('../website/app/lib/site-url');

const REPO = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n?/g, '\n');

const CALLBACK_ROUTE = 'website/app/api/github/callback/route.ts';

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'coverage', 'dist', 'build']);

/** Every runtime source file under a root, relative to the repo. */
function sourceFiles(root, exts) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (exts.has(path.extname(entry.name))) out.push(path.relative(REPO, full).replace(/\\/g, '/'));
    }
  };
  walk(path.join(REPO, root));
  return out;
}

describe('github-app-identity — the declaration', () => {
  it('names the live App, not the stale one', () => {
    assert.strictEqual(engine.APP_SLUG, 'gatetest-hq');
    assert.strictEqual(engine.APP_ID, 3766251);
  });

  it('builds the install URL from the slug', () => {
    assert.strictEqual(engine.appInstallUrl(), `https://github.com/apps/${engine.APP_SLUG}`);
  });

  it('the website re-export exposes the same identity as the engine', () => {
    assert.strictEqual(web.APP_SLUG, engine.APP_SLUG);
    assert.strictEqual(web.APP_ID, engine.APP_ID);
    assert.strictEqual(web.appInstallUrl, engine.appInstallUrl, 'must be the same function, not a copy');
    assert.strictEqual(web.appInstallUrl(), engine.appInstallUrl());
  });
});

describe('github-app-identity — no hand-written App URLs in runtime code', () => {
  const FILES = [
    ...sourceFiles('website/app', new Set(['.ts', '.tsx', '.js'])),
    ...sourceFiles('src', new Set(['.js'])),
  ];

  it('scans a non-trivial surface (anti-vacuity)', () => {
    assert.ok(FILES.length > 100, `only ${FILES.length} files walked — the walker is broken`);
  });

  it('every github.com/apps/ is built from the import, never a literal slug', () => {
    const offenders = [];
    for (const rel of FILES) {
      const lines = read(rel).split('\n');
      lines.forEach((line, i) => {
        // A literal slug is one where an identifier character follows
        // `apps/`. `${APP_SLUG}` (template) and `{APP_SLUG}` (JSX) are the
        // sanctioned shapes; a bare `apps/` at end of string is a prefix.
        const re = /github\.com\/apps\/([A-Za-z0-9_-]+)/g;
        let m;
        while ((m = re.exec(line)) !== null) offenders.push(`${rel}:${i + 1}: apps/${m[1]}`);
      });
    }
    assert.deepStrictEqual(
      offenders,
      [],
      'hand-written App slug — import appInstallUrl() / APP_SLUG from github-app-permissions instead',
    );
  });

  it('the stale App never reappears by name or id', () => {
    // The declaration is the one place allowed to name both Apps — that is
    // how a reader learns which is which. Everywhere else, the name is drift.
    const DECLARATION = 'src/core/github-app-permissions.js';
    const offenders = [];
    for (const rel of FILES) {
      if (rel === DECLARATION) continue;
      read(rel).split('\n').forEach((line, i) => {
        if (/GateTestHQ|gatetesthq|\b3322634\b/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepStrictEqual(offenders, [], 'reference to the stale App (gatetesthq / 3322634)');
  });

  it('the install page and the API docs actually use the import (anti-vacuity)', () => {
    for (const rel of ['website/app/github/setup/page.tsx', 'website/app/docs/api/page.tsx']) {
      const src = read(rel);
      assert.ok(/appInstallUrl\(\)/.test(src), `${rel} must render appInstallUrl()`);
      assert.ok(
        /from ["']@\/app\/lib\/github-app-permissions["']/.test(src),
        `${rel} must import from @/app/lib/github-app-permissions`,
      );
    }
  });
});

describe('github-app-identity — the post-install callback lands on the public site', () => {
  it('the callback route never builds a redirect on req.url', () => {
    const src = read(CALLBACK_ROUTE);
    const offenders = src.split('\n')
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      .filter(({ line }) => /new URL\([^)]*req\.url/.test(line));
    assert.deepStrictEqual(
      offenders.map((o) => `${o.no}: ${o.line}`),
      [],
      `${CALLBACK_ROUTE}: behind the reverse proxy req.url is the internal origin — use siteUrl(path)`,
    );
  });

  it('the callback route imports siteUrl and redirects through it', () => {
    const src = read(CALLBACK_ROUTE);
    assert.ok(/import \{ siteUrl \} from ["'][./]*lib\/site-url["']/.test(src), 'must import siteUrl');
    const all = (src.match(/NextResponse\.redirect\(/g) || []).length;
    const viaSiteUrl = (src.match(/NextResponse\.redirect\(siteUrl\(["']\/github\/(installed|setup)["']\)\)/g) || []).length;
    assert.ok(all >= 3, `expected the install / update / default redirects, saw ${all}`);
    assert.strictEqual(viaSiteUrl, all, 'every redirect must be NextResponse.redirect(siteUrl("/github/..."))');
  });

  it('the redirect targets resolve to the public host, never a private origin', () => {
    for (const p of ['/github/installed', '/github/setup']) {
      const target = new URL(siteUrl(p));
      assert.strictEqual(target.host, siteHost());
      assert.strictEqual(target.pathname, p);
      assert.ok(
        !/^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|localhost$|0\.0\.0\.0$)/.test(target.hostname),
        `redirect resolved to a private/loopback host: ${target.href}`,
      );
    }
  });
});
