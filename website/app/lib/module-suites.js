/**
 * Suite membership for a module, read from the engine's own
 * `src/core/config.js` — the same table `gatetest --suite` consults.
 *
 * Why: /modules/[slug] used to tell every module's page that it "runs in
 * every scan" and is "included on Full ($99)". That is false for the eight
 * nuclear-only modules (Forensic tier), the twenty live-URL modules (the
 * /web and /wp scanners, never a repository tier), and the modules the
 * hosted engine refuses to run because they execute customer code. Hand-
 * writing those lists on the website would rot the next time a module moves
 * suites, so the page asks the engine instead. Generated over typed.
 *
 * Resolution mirrors cli-engine-runner.js / engine-entry-resolver.js:
 * `src/` sits one level above `website/`, and the resolver already knows
 * every place it can be in dev, test and production. If the engine cannot be
 * found (an npm-only deployment without `src/`) the caller gets `null` and
 * falls back to tier-neutral copy rather than a wrong claim.
 */
'use strict';

const path = require('path');
const { resolveEngineEntry } = require('./engine-entry-resolver.js');

/** @type {Record<string, string[]> | null | undefined} */
let cachedSuites;

/** @returns {Record<string, string[]> | null} suite name → module names */
function loadSuites() {
  if (cachedSuites !== undefined) return cachedSuites;
  try {
    const configPath = path.join(path.dirname(resolveEngineEntry()), 'core', 'config.js');
    // turbopackIgnore — resolved at runtime, same reasoning as cli-engine-runner.js.
    const cfg = require(/* turbopackIgnore: true */ configPath);
    const suites = (cfg.DEFAULT_CONFIG || cfg.defaults || cfg).suites;
    cachedSuites = suites && typeof suites === 'object' ? suites : null;
  } catch { // error-ok — no engine on disk; callers render tier-neutral copy
    cachedSuites = null;
  }
  return cachedSuites;
}

/**
 * @param {string} moduleName registry key, e.g. "moneyFloat"
 * @returns {string[] | null} suites containing it (`[]` = registered but in
 *   no suite, e.g. the dormant pen-test probes); `null` = engine unreadable
 */
function suitesForModule(moduleName) {
  const suites = loadSuites();
  if (!suites) return null;
  return Object.entries(suites)
    .filter(([, mods]) => Array.isArray(mods) && mods.includes(moduleName))
    .map(([name]) => name);
}

module.exports = { suitesForModule, loadSuites };
