'use strict';

// SCAN ENGINE DISPATCH — every hosted scan path must run the REAL engine.
//
// Found 2026-08-18: only /api/scan/run bridged to the 121-module CLI engine.
// The worker tick (every GitHub App / Gluecron push, every Continuous
// subscriber), the Stripe webhook (every paid one-time scan bought through
// checkout) and /api/v1/scan ran the 23-module in-memory `runTier` on a
// 50-file sample. These tests pin the single dispatch point and the tier
// semantics so the paths cannot drift apart again.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { AI_MODULE_NAMES } = require('./helpers/ai-module-names.js');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('scan-engine-dispatch — the one place engine choice lives', () => {
  const src = read('website/app/lib/scan-engine-dispatch.ts');

  it('AI_ENGINE_MODULES lists exactly the scan modules that call Anthropic (derived from src/)', () => {
    const m = /(?:export\s+)?const AI_ENGINE_MODULES[^=]*=\s*\[([\s\S]*?)\];/.exec(src);
    assert.ok(m, 'AI_ENGINE_MODULES array missing');
    const listed = [...m[1].matchAll(/["']([A-Za-z0-9_]+)["']/g)].map((x) => x[1]).sort();
    assert.deepStrictEqual(listed, AI_MODULE_NAMES,
      'AI_ENGINE_MODULES must equal the set of registry modules whose scan path calls api.anthropic.com — the deterministic every-push tier skips these and must never leak spend when a new AI module lands');
  });

  it('CLI-engine tiers are quick + deterministic + full + scan_fix + nuclear; only quick_shadow stays in-memory', () => {
    // 2026-09-13: the free preview and the $29 Quick Scan moved onto the real
    // engine. The in-memory runTier had judged expressjs/express's config-only
    // .npmrc a committed credential (blocking) while the CLI passed the repo
    // with 0 blocking findings — the first thing a prospect saw contradicted
    // the /precision page. See tests/preview-engine.test.js for the control pair.
    assert.match(src, /CLI_ENGINE_TIERS[^=]*=\s*new Set\(\["quick", "deterministic", "full", "scan_fix", "nuclear"\]\)/);
    assert.match(src, /skipModulesForTier[\s\S]*tier === "deterministic" \? \[\.\.\.AI_ENGINE_MODULES\] : \[\]/);
    assert.match(src, /tier === "nuclear"\) return "nuclear";\s*if \(tier === "quick"\) return "quick";\s*return "full";/);
  });
});

describe('every hosted scan path dispatches through runEngineForTier', () => {
  it('scan-executor (worker tick, Stripe job, /api/v1/scan) no longer calls runTier directly', () => {
    const src = read('website/app/lib/scan-executor.ts');
    assert.match(src, /import \{ runEngineForTier, CLI_ENGINE_TIERS[^}]*\} from "\.\/scan-engine-dispatch"/);
    assert.doesNotMatch(src, /\brunTier\(/, 'scan-executor must not bypass the dispatcher');
    assert.match(src, /loadRepoFiles\(owner, repo, ref, token/, 'must read the WHOLE repo via the archive loader');
    assert.doesNotMatch(src, /MAX_FILES_TO_READ = 50/, 'the 50-file sample cap is gone');
    assert.match(src, /ENGINE_MAX_FILES = 4000/);
  });

  it('/api/scan/run uses the same dispatcher and loader (no inline engine selection)', () => {
    const src = read('website/app/api/scan/run/route.ts');
    assert.match(src, /runEngineForTier\(\{/);
    assert.match(src, /loadRepoFiles\(owner, repo, "HEAD", token/);
    assert.doesNotMatch(src, /require\("@\/app\/lib\/cli-engine-runner"\)/, 'engine bridging belongs in scan-engine-dispatch, not the route');
    assert.doesNotMatch(src, /MAX_FILES_TO_READ = 50/);
    assert.match(src, /coverage: \{[\s\S]*filesAnalysed/, 'the response must say how much of the repo was analysed');
  });

  it('runScan scans the pushed SHA, and the worker passes it', () => {
    const exec = read('website/app/lib/scan-executor.ts');
    assert.match(exec, /opts: \{ ref\?: string; baseRef\?: string \} = \{\}/);
    const worker = read('website/app/lib/scan-worker.js');
    assert.match(worker, /runScan\(repoUrl, scanTier, \{ ref: job\.sha \|\| undefined, baseRef: job\.base_sha \|\| undefined \}\)/);
  });

  it('the worker defaults to the deterministic tier (full engine, no AI spend), escalating to full only with allowance', () => {
    const worker = read('website/app/lib/scan-worker.js');
    assert.match(worker, /tier = 'deterministic',/);
    assert.match(worker, /allowance\.allowed \? 'full' : tier/);
    assert.doesNotMatch(worker, /scanTier = 'quick'/, 'quick is the free funnel sample, never the every-push tier');
  });

  it('TIERS declares the deterministic tier so KNOWN_TIERS accepts it', () => {
    const types = read('website/app/lib/scan-modules/types.ts');
    assert.match(types, /^\s*deterministic: QUICK_SHADOW_MODULES,/m);
  });

  it('cli-engine-runner accepts extra skipModules but always keeps the hosted-unsafe set skipped', () => {
    const runner = read('website/app/lib/cli-engine-runner.js');
    assert.match(runner, /skipModules = \[\]/);
    assert.match(runner, /new Set\(\[\.\.\.HOSTED_UNSAFE_MODULES, \.\.\./);
  });
});
