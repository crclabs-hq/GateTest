'use strict';
/**
 * Operator / dev-only tool files — ONE definition (issue #771 GT-12; #842
 * DR-6 "ships").
 *
 * A file under `bin/`, `scripts/` or `cli/`, or any file whose FIRST line is
 * a shebang (`#!/usr/bin/env node`), is run interactively by a human on
 * their own terminal. When it prints the argument it was just handed —
 * `console.log(token)` in `bin/rotate-api-key.js` echoing the `--token` it
 * was invoked with — or the one-time value it just generated for that
 * human (AlecRae.com apps/api/scripts/create-admin-user.ts:126 prints the
 * admin password it created, under a line that says "ONE-TIME PASSWORD"),
 * that is the tool confirming what it did, not a plaintext credential
 * leaking into a log-aggregation stack.
 *
 * The same file never SHIPS either. hardcodedUrl said "localhost leaks break
 * every non-developer machine the moment this ships" about
 * frontend/scripts/doctor.mjs and inspect.mjs on DavenRoe — Playwright
 * tools that `npm run doctor` / `npm run inspect` point at a local dev
 * server — and dataIntegrity reported the token those tools seed into
 * their own browser context as "sensitive data in localStorage". A dev tool
 * is not the application; both modules consult this helper so the decision
 * is the FILE's role, made in one place.
 *
 * Three refinements over the bare directory list, each with its control:
 *   - `tools/` and `dev/` count only when the nearest package.json's
 *     `scripts` map names that directory (`"doctor": "node tools/doctor.mjs"`)
 *     — `src/tools/` in an agent app is shipped code and stays in scope.
 *   - a `scripts/` under a static-asset root (`public/`, `static/`,
 *     `assets/`, `dist/`, `build/`, `www/`) is browser code the server
 *     serves — `public/scripts/app.js` ships, and still fires.
 *   - `subscripts/report.js` has no `scripts` SEGMENT (doctrine #5) and is
 *     not exempted. Only the first line is checked for a shebang, matching
 *     how a shell decides how to run the file.
 *
 * logPii (src/modules/log-pii.js), dataIntegrity (src/modules/data-integrity.js)
 * and hardcodedUrl (src/modules/hardcoded-url.js) all read this. The
 * identical `console.log(password)` / `http://localhost:4173` in application
 * code under `src/` still fires.
 */

const fs = require('fs');
const path = require('path');

const OPERATOR_CLI_DIR_RE = /(?:^|\/)(?:bin|scripts|cli)\//;
// Only with package.json evidence — see the header.
const CONDITIONAL_TOOL_DIR_RE = /(?:^|\/)(tools|dev)\//;
const STATIC_ASSET_ROOT_RE = /(?:^|\/)(?:public|static|assets|dist|build|out|www|wwwroot)\//;
const SHEBANG_RE = /^#!/;

// package.json `scripts` text, cached by directory for the life of the
// process (a scan reads each one at most once).
const pkgScriptsCache = new Map();
function packageScriptsText(dir) {
  if (pkgScriptsCache.has(dir)) return pkgScriptsCache.get(dir);
  let text = '';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (pkg && pkg.scripts && typeof pkg.scripts === 'object') text = Object.values(pkg.scripts).join('\n');
  } catch { /* no package.json here, or unparsable: no evidence */ }
  pkgScriptsCache.set(dir, text);
  return text;
}

/**
 * Does a package.json between the file and the project root have a
 * `scripts` entry that names the tool directory BY ITS PATH from that
 * package — `"doctor": "node tools/doctor.mjs"` for `frontend/tools/`, or
 * `src/tools/` for a tools dir under src? The path, not the bare word:
 * `src/tools/weather.ts` in an agent app is shipped code, and a script that
 * runs `tools/build.mjs` says nothing about it.
 */
function namedByPackageScripts(projectRoot, normalisedRel, dirName) {
  if (!projectRoot) return false;
  const abs = path.join(projectRoot, normalisedRel);
  let dir = path.dirname(abs);
  const root = path.resolve(projectRoot);
  for (let i = 0; i < 12; i++) {
    const text = packageScriptsText(dir);
    if (text) {
      const fromPkg = path.relative(dir, abs).replace(/\\/g, '/');
      const seg = fromPkg.match(new RegExp(`(?:^|/)${dirName}/`));
      if (seg) {
        const prefix = fromPkg.slice(0, seg.index + seg[0].length).replace(/^\//, '');
        if (new RegExp(`(?:^|[\\s"'=]|\\./)${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text)) return true;
      }
    }
    if (path.resolve(dir) === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

/**
 * @param {string} rel  repo-relative path (either slash style)
 * @param {string} [text]  file contents, for the shebang check
 * @param {string} [projectRoot]  absolute project root; enables the
 *                 package.json evidence check for `tools/` and `dev/`
 * @returns {boolean}
 */
function isOperatorCliFile(rel, text, projectRoot) {
  const normalised = String(rel || '').replace(/\\/g, '/');
  if (STATIC_ASSET_ROOT_RE.test(normalised)) return false;
  if (OPERATOR_CLI_DIR_RE.test(normalised)) return true;
  const conditional = normalised.match(CONDITIONAL_TOOL_DIR_RE);
  if (conditional && namedByPackageScripts(projectRoot, normalised, conditional[1])) return true;
  if (typeof text !== 'string' || text.length === 0) return false;
  const nl = text.indexOf('\n');
  const firstLine = nl === -1 ? text : text.slice(0, nl);
  return SHEBANG_RE.test(firstLine);
}

module.exports = { OPERATOR_CLI_DIR_RE, STATIC_ASSET_ROOT_RE, isOperatorCliFile };
