'use strict';

// =============================================================================
// FREE PREVIEW RUNS THE REAL ENGINE — POST /api/scan/preview
// =============================================================================
// Found 2026-09-13 by probing the live site with expressjs/express, the first
// example repo on the page: the preview returned a BLOCKING secrets error,
// "committed sensitive file (.npmrc)", on a file holding four config flags
// (package-lock=false, ignore-scripts=true, …) and no credential. The CLI
// engine — the one /precision measures — passes the same repo with 0 blocking
// findings, because src/modules/secrets.js judges a tracked .npmrc by its
// CONTENTS. The preview ran a second, path-only scanner (runTier).
//
// Two things are pinned here:
//   1. The route dispatches tier "quick" through runEngineForTier, and the
//      dispatcher routes "quick" to the CLI engine's quick suite.
//   2. A control pair on the engine's quick suite, hosted-style (no npm
//      install, workspace materialised from fileContents): a config-only
//      .npmrc must stay quiet; an .npmrc carrying _authToken must block.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const { runFullEngine, HOSTED_UNSAFE_MODULES } = require('../website/app/lib/cli-engine-runner');

describe('POST /api/scan/preview dispatches through the one engine chooser', () => {
  const route = read('website/app/api/scan/preview/route.ts');
  const dispatch = read('website/app/lib/scan-engine-dispatch.ts');

  it('the route calls runEngineForTier with tier "quick" and never runTier directly', () => {
    assert.match(route, /import \{ runEngineForTier, hostedModulesForTier \} from "@\/app\/lib\/scan-engine-dispatch"/);
    assert.match(route, /runEngineForTier\(\{\s*tier: "quick"/);
    assert.doesNotMatch(route, /\brunTier\(/, 'the preview must not carry its own engine choice');
  });

  it('the dispatcher sends "quick" to the CLI engine on the quick suite', () => {
    assert.match(dispatch, /CLI_ENGINE_TIERS[^=]*=\s*new Set\(\["quick"/);
    assert.match(dispatch, /if \(tier === "quick"\) return "quick";/);
  });

  it('ranked engine findings are shaped by fromRankedFinding, and a soft error is not shown as a blocker', () => {
    assert.match(route, /fromRankedFinding\(f\)/);
    assert.match(route, /if \(f\.duplicateOf\) continue;/);
    const helper = read('website/app/lib/preview-finding.ts');
    assert.match(helper, /f\.severity === "error" \? \(f\.blocking \? "error" : "warning"\) : f\.severity/);
  });

  it('content-judged dotfiles reach the workspace so .npmrc / .env are judged by what they hold', () => {
    assert.match(route, /contentJudgedNames = \[[^\]]*"\.npmrc"[^\]]*"\.gitignore"[^\]]*\]/);
  });

  it('the response says which engine ran and what ran — a fallback pass never wears the engine verdict', () => {
    assert.match(route, /engine: scanResult\.engineUsed,/);
    // A module that ran with nothing to check is still listed as run; only a
    // host-skipped module (which carries a `skipped` reason) is "not run".
    assert.match(route, /modulesRun: scanResult\.modules\.filter\(\(m\) => !m\.skipped\)/);
    assert.match(route, /blocking,/);
  });

  it('GET derives the module list from the dispatcher (tier table ∩ engine suite − hosted-unsafe), never a typed list', () => {
    assert.match(route, /hostedModulesForTier\("quick"\)/);
    assert.doesNotMatch(route, /modulesRun: \["syntax", "lint", "secrets", "codeQuality"\]/, 'the hand-typed four-module list is gone');
    assert.match(dispatch, /export function hostedModulesForTier/);
    assert.match(dispatch, /HOSTED_UNSAFE_MODULES/);
  });

  it('the Quick tier runs exactly the modules it is sold as — the tier table decides, the suite is trimmed to it', () => {
    // What a $29 tier includes is a pricing decision (Boss Rule #3). The
    // engine's quick suite is ~36 modules; the tier is sold as four. The
    // dispatcher must skip the rest and read the four from checkout-tiers.ts,
    // not from a second hand-written list.
    assert.match(dispatch, /import \{ TIERS \} from "\.\/checkout-tiers"/);
    assert.match(dispatch, /tierModuleAllowList\("quick"\)/);
    assert.match(dispatch, /return suite\.filter\(\(m\) => !keep\.has\(m\)\);/);
    const tiers = read('website/app/lib/checkout-tiers.ts');
    assert.match(tiers, /modules: "syntax, lint, secrets, codeQuality"/, 'the allow-list source the dispatcher reads');
  });

  it('the page no longer hard-codes the four-module list or says "four modules"', () => {
    const page = read('website/app/scan/preview/page.tsx');
    assert.doesNotMatch(page, /const QUICK_MODULES = \["syntax", "lint", "secrets", "codeQuality"\]/);
    assert.doesNotMatch(page, /runs four modules/);
    assert.match(page, /fetch\("\/api\/scan\/preview"\)/, 'the module list is fetched from the endpoint');
  });
});

// ---------------------------------------------------------------------------
// Control pair on the engine the preview now runs.
// ---------------------------------------------------------------------------

const BASE_FILES = [
  { path: 'package.json', content: JSON.stringify({ name: 'preview-fixture', version: '1.0.0', private: true, scripts: {} }, null, 2) + '\n' },
  { path: '.gitignore', content: 'node_modules\n' },
  { path: 'index.js', content: "'use strict';\nmodule.exports = function add(a, b) { return a + b; };\n" },
];

const CONFIG_ONLY_NPMRC = 'package-lock=false\nmin-release-age=7\nignore-scripts=true\nallow-git=none\n';
const CREDENTIAL_NPMRC = '//registry.npmjs.org/:_authToken=npm_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0\n';

function npmrcFindings(result) {
  return (result.findings || []).filter((f) => f.module === 'secrets' && String(f.file || '').endsWith('.npmrc'));
}

// The Quick tier as the dispatcher runs it: the engine's quick suite trimmed
// to the four advertised modules. Computed here the same way (tier table ∩
// suite) rather than typed, so the control pair exercises the real run.
const QUICK_TIER_MODULES = (() => {
  const tiers = read('website/app/lib/checkout-tiers.ts');
  const m = /quick: \{[\s\S]*?modules: "([^"]+)"/.exec(tiers);
  return m ? m[1].split(',').map((s) => s.trim()) : ['syntax', 'lint', 'secrets', 'codeQuality'];
})();
const { loadSuites } = require('../website/app/lib/module-suites');
const QUICK_SUITE = (loadSuites() || {}).quick || [];
const QUICK_TIER_SKIP = QUICK_SUITE.filter((m) => !QUICK_TIER_MODULES.includes(m));

describe('quick suite on a hosted workspace — .npmrc is judged by its contents', () => {
  const workspaceParent = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-preview-engine-'));

  it('the engine quick suite is wider than the tier, and the tier modules are all in it', () => {
    assert.ok(QUICK_SUITE.length > QUICK_TIER_MODULES.length, `suite ${QUICK_SUITE.length} vs tier ${QUICK_TIER_MODULES.length}`);
    for (const m of QUICK_TIER_MODULES) assert.ok(QUICK_SUITE.includes(m), `${m} must be in the engine's quick suite`);
  });

  it('negative control: a config-only .npmrc (expressjs/express shape) produces no secrets finding and nothing blocking', async () => {
    const result = await runFullEngine({
      suite: 'quick',
      workspaceParent,
      skipModules: QUICK_TIER_SKIP,
      fileContents: [...BASE_FILES, { path: '.npmrc', content: CONFIG_ONLY_NPMRC }],
    });
    assert.equal(result.engine, 'cli');
    assert.ok(result.modules.length > 0, 'the engine ran');
    assert.deepEqual(npmrcFindings(result), [], 'a config-only .npmrc must not be reported');
    const blocking = (result.findings || []).filter((f) => f.blocking);
    assert.deepEqual(blocking, [], `nothing may block a clean fixture: ${JSON.stringify(blocking)}`);
  });

  it('positive control: an .npmrc carrying _authToken is a blocking secrets finding on that file', async () => {
    const result = await runFullEngine({
      suite: 'quick',
      workspaceParent,
      skipModules: QUICK_TIER_SKIP,
      fileContents: [...BASE_FILES, { path: '.npmrc', content: CREDENTIAL_NPMRC }],
    });
    const hits = npmrcFindings(result);
    assert.ok(hits.length >= 1, 'a registry credential in .npmrc must be reported');
    assert.ok(hits.some((f) => f.severity === 'error' && f.blocking), `the credential must block: ${JSON.stringify(hits)}`);
  });

  it('lint is held back on the host (it executes the repo\'s ESLint config), and says so', async () => {
    assert.ok(HOSTED_UNSAFE_MODULES.includes('lint'));
    const result = await runFullEngine({ suite: 'quick', workspaceParent, skipModules: QUICK_TIER_SKIP, fileContents: BASE_FILES });
    const lint = result.modules.find((m) => m.name === 'lint');
    assert.ok(!lint || lint.status === 'skipped', 'lint must not run against a hosted workspace');
    // Modules in skipModules are absent from the result entirely; a module
    // that ran but had nothing to check reports status "skipped" with no
    // reason, so compare the module NAMES present, not their status.
    const present = result.modules.map((m) => m.name).sort();
    const expected = QUICK_TIER_MODULES.filter((m) => !HOSTED_UNSAFE_MODULES.includes(m)).sort();
    assert.deepEqual(present, expected, 'exactly the advertised, host-safe modules are in the run');
  });
});
