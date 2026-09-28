#!/usr/bin/env node
'use strict';

/**
 * Mirror the website-owned helpers the CLI ships into lib/.
 *
 * lib/pr-composer.js, lib/nuclear-diagnoser.js and lib/prompt-injection-guard.js
 * are copies of website/app/lib/*.js — the published npm package ships bin/,
 * src/ and lib/ without website/, so bin/gatetest-mcp.mjs and the CLI fix
 * orchestrator cannot require across that boundary.
 *
 * Why a script and not the package.json one-liner it replaces: the one-liner
 * copied exactly three names. website/app/lib/pr-composer.js grew a
 * `require('./site-url')` and the copy in lib/ was shipped without it —
 * @gatetest/cli 1.61.0 on npm throws "Cannot find module './site-url'" the
 * moment gatetest-mcp starts. This script follows every relative require of
 * every synced file, so a helper cannot ship without the modules it loads,
 * and tests/tarball-requires.test.js fails the suite if lib/ is stale or a
 * packed file requires something the tarball does not contain.
 *
 * Deterministic: files are visited in sorted order, the UTF-8 BOM the editor
 * left on pr-composer.js is stripped, and line endings are normalised to LF
 * so the same input always yields the same lib/.
 *
 * Host guard (issue #801): the shipped lib/site-url.js decides where a
 * customer's install sends its telemetry and links, so it may name ONE host,
 * gatetest.io. @gatetest/cli@1.60.0 named a domain we no longer own and every
 * install of it posted scan stats there. Both modes refuse to proceed when
 * any other hostname appears in it — comments included, so a stale example
 * cannot ship either.
 *
 * Usage: node scripts/sync-lib.js [--check]
 *   --check  exit 1 (and list the drift) instead of writing
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'website', 'app', 'lib');
const OUT_DIR = path.join(ROOT, 'lib');

/** The roots — everything they require (relatively, transitively) comes too. */
const ROOTS = ['pr-composer', 'nuclear-diagnoser', 'prompt-injection-guard'];

const RELATIVE_REQUIRE_RE = /\brequire\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;

/** The one host the shipped origin file may name. */
const ALLOWED_HOST = 'gatetest.io';
/** Files under lib/ that decide a host; each may name only ALLOWED_HOST. */
const HOST_GUARDED = ['site-url.js'];
const HOST_RE = /\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+(?:ai|io|com|net|org|dev|app|co|example|local|xyz|cloud))\b/gi;

/** Every hostname in `text` other than ALLOWED_HOST (or its subdomains). */
function foreignHosts(text) {
  const bad = new Set();
  for (const m of text.matchAll(HOST_RE)) {
    const host = m[1].toLowerCase();
    if (host !== ALLOWED_HOST && !host.endsWith(`.${ALLOWED_HOST}`)) bad.add(host);
  }
  return [...bad].sort();
}

/** `{ file, hosts }` for each guarded file in the planned lib/ that names a foreign host. */
function hostViolations(entries = plan()) {
  return entries
    .filter((e) => HOST_GUARDED.includes(e.name))
    .map((e) => ({ file: e.name, hosts: foreignHosts(e.content) }))
    .filter((v) => v.hosts.length);
}

function normalise(content) {
  return content.replace(/^﻿/, '').replace(/\r\n/g, '\n');
}

/**
 * Resolve a relative require the way Node does for the shapes we ship:
 * exact file, then `.js`, then `.cjs`. Anything else is an error — a
 * directory or JSON dependency is not something lib/ knows how to carry.
 */
function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, `${base}.js`, `${base}.cjs`]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`${path.relative(ROOT, fromFile)} requires '${spec}', which does not resolve to a file`);
}

/**
 * Compute the full set of files lib/ must contain: `{ name, content }` for
 * every root and every relative require reachable from a root, sorted by
 * name. Pure — reads website/app/lib, writes nothing.
 */
function plan() {
  const seen = new Map();
  const queue = ROOTS.map((n) => path.join(SRC_DIR, `${n}.js`));
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    if (path.dirname(file) !== SRC_DIR) {
      throw new Error(`${path.relative(ROOT, file)} is outside website/app/lib — lib/ is flat, nested helpers are not synced`);
    }
    const content = normalise(fs.readFileSync(file, 'utf8'));
    seen.set(file, content);
    for (const m of content.matchAll(RELATIVE_REQUIRE_RE)) {
      queue.push(resolveRelative(file, m[1]));
    }
  }
  return [...seen.entries()]
    .map(([file, content]) => ({ name: path.basename(file), content }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Files whose committed lib/ copy differs from the plan (or is missing).
 * The on-disk copy is normalised too: a core.autocrlf checkout hands back
 * CRLF for a file git stores as LF, and that is not drift.
 */
function drift(entries = plan()) {
  return entries.filter(({ name, content }) => {
    const target = path.join(OUT_DIR, name);
    return !fs.existsSync(target) || normalise(fs.readFileSync(target, 'utf8')) !== content;
  }).map((e) => e.name);
}

function main(argv) {
  const check = argv.includes('--check');
  const entries = plan();
  const violations = hostViolations(entries);
  if (violations.length) {
    for (const v of violations) {
      console.error(`lib/${v.file} names ${v.hosts.join(', ')} — the shipped origin may name only ${ALLOWED_HOST}. Fix website/app/lib/${v.file}.`);
    }
    return 1;
  }
  const stale = drift(entries);
  if (check) {
    if (stale.length) {
      console.error(`lib/ is out of sync with website/app/lib: ${stale.join(', ')}\nRun: npm run sync-lib`);
      return 1;
    }
    console.log(`lib/ in sync (${entries.length} files)`);
    return 0;
  }
  for (const { name, content } of entries) {
    fs.writeFileSync(path.join(OUT_DIR, name), content);
    console.log(`synced ${name}${stale.includes(name) ? '' : ' (unchanged)'}`);
  }
  return 0;
}

module.exports = { plan, drift, ALLOWED_HOST, foreignHosts, hostViolations };

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
