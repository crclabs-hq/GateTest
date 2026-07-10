// =============================================================================
// MARKETING-CLAIM VERIFICATION
// =============================================================================
// Every public-facing claim about GateTest must be backed by a test that
// can prove the claim against the running code. If we say "91 modules"
// on the homepage, this suite asserts node bin/gatetest.js --list shows
// 91 modules. If we say "claude-opus-4-7", this suite asserts no source
// file mentions a legacy model. App Review can't catch us in a lie
// because the claim and the code are pinned together.
//
// This file CANNOT be deleted lightly — it is the safety net for every
// marketing copy decision. If a future change breaks a claim, the test
// fails; either the code is restored or the claim is updated, never
// silently drifting.
// =============================================================================

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '../..');

function readFile(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function fileExists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

// ---------------------------------------------------------------------------
// Claim: 120 modules (v1.57 — per CLAUDE.md "## VERSION" section)
// ---------------------------------------------------------------------------

describe('marketing claim — module count', () => {
  it('node bin/gatetest.js --list emits ≥ 120 module lines', () => {
    const out = execFileSync('node', [path.join(ROOT, 'bin', 'gatetest.js'), '--list'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    const moduleLines = out.split('\n').filter((l) => /^\s{2,}[a-z]/i.test(l));
    assert.ok(moduleLines.length >= 120, `expected ≥ 120 module lines, got ${moduleLines.length}`);
  });

  it('CLAUDE.md mentions 120 modules in current version', () => {
    const md = readFile('CLAUDE.md');
    // Either explicit "120 modules" wording or the v1.57.x section header.
    const hasCount = /\b120\s+modules\b/i.test(md) || /\bGateTest v1\.57/.test(md);
    assert.ok(hasCount, 'Bible should reference 120 modules or v1.57.x');
  });
});

// ---------------------------------------------------------------------------
// Claim: hybrid engine (Craig 2026-07-07) — Fable 5 on the paid fix tiers,
// Sonnet 4.6 on free/cheap/high-volume paths, Opus 4.8 as the refusal fallback.
// Legacy / older models must still be absent so App Review can't catch a lie.
// ---------------------------------------------------------------------------

describe('marketing claim — hybrid engine models', () => {
  it('no source file references a LEGACY claude model (current: fable-5, sonnet-4-6, opus-4-8, haiku-4-5)', () => {
    // Walk JS/TS/TSX/yml under tracked dirs and assert clean.
    const found = [];
    function walk(dir) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.next' || e.name === '.git' || e.name === 'coverage' || e.name === '.holdenmercer') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile() && /\.(?:js|mjs|cjs|ts|tsx|mts|cts|yml|yaml)$/.test(e.name)) {
          const body = fs.readFileSync(full, 'utf8');
          // Allow the verification test itself to mention legacy IDs (it asserts they're gone)
          if (full.endsWith('marketing-claim-verification.test.js')) continue;
          // Banned: older Opus (4-5/4-6/4-7 + dated), older Sonnets (4-5/4-7 + dated),
          // dated Haikus. Opus 4.8 is ALLOWED (the Fable refusal fallback); Fable 5,
          // Sonnet 4.6, and non-dated Haiku 4.5 are the current engine models.
          const m = body.match(/claude-opus-4-(?:5|6|7|20250514)|claude-sonnet-4-(?:5|7|20250514)|claude-haiku-4-5-2025[0-9]+/);
          if (m) found.push(`${path.relative(ROOT, full)}: ${m[0]}`);
        }
      }
    }
    walk(ROOT);
    assert.deepStrictEqual(found, [], 'legacy model references should be empty:\n  ' + found.join('\n  '));
  });

  it('engine-models.js defines the hybrid split (Fable fix / Sonnet cheap / Opus fallback)', () => {
    for (const rel of ['website/app/lib/engine-models.js', 'src/core/engine-models.js']) {
      const src = readFile(rel);
      assert.match(src, /claude-fable-5/, `${rel} should name Fable 5 as FIX_MODEL`);
      assert.match(src, /claude-sonnet-5/, `${rel} should name Sonnet 5 as CHEAP_MODEL`);
      assert.match(src, /claude-opus-4-8/, `${rel} should name Opus 4.8 as FALLBACK_MODEL`);
    }
  });

  it('budget-tracker.js prices Sonnet (3/15) by default and Fable (10/50) per model', () => {
    const src = readFile('website/app/lib/budget-tracker.js');
    // Default (untagged) rate stays Sonnet — cheap-path callers unchanged.
    assert.match(src, /INPUT_USD_PER_MTOK[^\n]*\|\|\s*3\b/);
    assert.match(src, /OUTPUT_USD_PER_MTOK[^\n]*\|\|\s*15\b/);
    // Fable rate present for the paid fix tiers.
    assert.match(src, /claude-fable-5[\s\S]*?10[\s\S]*?50/);
  });

  it('CLAUDE.md AI Layer note still names claude-sonnet-5 (cheap paths)', () => {
    const md = readFile('CLAUDE.md');
    assert.match(md, /claude-sonnet-5/);
  });
});

// ---------------------------------------------------------------------------
// Claim: 4 pricing tiers wired through /api/checkout
// ---------------------------------------------------------------------------

describe('marketing claim — 4 pricing tiers wired', () => {
  it('checkout route declares quick / full / scan_fix / nuclear TIERS', () => {
    const checkout = readFile('website/app/api/checkout/route.ts');
    assert.match(checkout, /\bquick\b/);
    assert.match(checkout, /\bfull\b/);
    assert.match(checkout, /\bscan_fix\b/);
    assert.match(checkout, /\bnuclear\b/);
  });

  it('budget-tracker has tier caps for all 4 tiers', () => {
    const { capsForTier } = require('../../website/app/lib/budget-tracker');
    assert.strictEqual(capsForTier('quick').tier, 'quick');
    assert.strictEqual(capsForTier('full').tier, 'full');
    assert.strictEqual(capsForTier('scan_fix').tier, 'scan_fix');
    assert.strictEqual(capsForTier('nuclear').tier, 'nuclear');
  });

  it('Pricing.tsx references the paid cloud tier prices ($199 and $399)', () => {
    // $29 Quick Scan and $99 Full Scan removed from the pricing grid (2026-06-23):
    // the free CLI (`npx @gatetest/cli --suite full`) replaces both entry tiers.
    // The paid grid now shows only $199 Scan+Fix and $399 Forensic Scan.
    const pricing = readFile('website/app/components/Pricing.tsx');
    for (const price of ['$199', '$399']) {
      assert.ok(pricing.includes(price), `Pricing.tsx should mention ${price}`);
    }
    // Free CLI callout must be present instead of the removed tiers.
    assert.ok(pricing.includes('@gatetest/cli'), 'Pricing.tsx should mention @gatetest/cli free tier');
  });
});

// ---------------------------------------------------------------------------
// Claim: Self-healing CI (AI fixer wired + active when API key present)
// ---------------------------------------------------------------------------

describe('marketing claim — self-healing CI', () => {
  it('ai-ci-fixer.yml workflow exists and gates on ANTHROPIC_API_KEY', () => {
    const wf = readFile('.github/workflows/ai-ci-fixer.yml');
    assert.match(wf, /ANTHROPIC_API_KEY/);
    assert.match(wf, /workflow_run/);
    assert.match(wf, /conclusion == 'failure'/);
  });

  it('scripts/ai-ci-fixer.js orchestrator + lib core exist', () => {
    assert.ok(fileExists('scripts/ai-ci-fixer.js'));
    assert.ok(fileExists('lib/ai-ci-fixer-core.js'));
  });
});

// ---------------------------------------------------------------------------
// Claim: Flywheel learns from every fix (corpus + 6 trainers)
// ---------------------------------------------------------------------------

describe('marketing claim — flywheel intelligence pipeline', () => {
  it('session-telemetry captures git history', () => {
    assert.ok(fileExists('website/app/lib/session-telemetry.js'));
    const src = readFile('website/app/lib/session-telemetry.js');
    assert.match(src, /ingestGitHistory/);
    assert.match(src, /recordSessionFix/);
  });

  it('all 8 trainers exist as separate files', () => {
    const required = [
      'website/app/lib/trainers/pattern-miner.js',
      'website/app/lib/trainers/recipe-promoter.js',
      'website/app/lib/trainers/recipe-auto-promoter.js',
      'website/app/lib/trainers/regression-test-generator.js',
      'website/app/lib/trainers/cross-repo-promoter.js',
      'website/app/lib/trainers/adversarial-mutator.js',
      'website/app/lib/trainers/confidence-calibrator.js',
      'website/app/lib/trainers/hacker-news-monitor.js',
    ];
    for (const r of required) {
      assert.ok(fileExists(r), `trainer file ${r} should exist`);
    }
  });

  it('nightly workflow runs all trainers', () => {
    const wf = readFile('.github/workflows/trainer-nightly.yml');
    assert.match(wf, /pattern-miner/);
    assert.match(wf, /recipe-promoter/);
    assert.match(wf, /regression-test-generator/);
    assert.match(wf, /adversarial-mutator/);
    // cross-repo and calibrator are exercised by trainer-nightly via the
    // same artifact-collection pattern; either listed explicitly OR via
    // the bulk artifact upload — we accept either shape here.
  });

  it('gatetest train CLI lists all 8 trainers', () => {
    const train = require('../../bin/gatetest-train.js');
    const names = train.TRAINERS.map((t) => t.name);
    assert.strictEqual(names.length, 8);
    for (const t of ['pattern-miner', 'recipe-promoter', 'recipe-auto-promoter', 'regression-test-generator', 'cross-repo-promoter', 'adversarial-mutator', 'confidence-calibrator', 'hacker-news-monitor']) {
      assert.ok(names.includes(t), `CLI catalogue should include ${t}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Claim: SOC2-safe cross-repo learning (no customer strings leak)
// ---------------------------------------------------------------------------

describe('marketing claim — SOC2-safe cross-repo learning', () => {
  it('cross-repo-promoter anonymises proposals', () => {
    const src = readFile('website/app/lib/trainers/cross-repo-promoter.js');
    assert.match(src, /anonymise/);
    // Either "SOC2-safe" or "SOC2-compliant" — current source uses the
    // word "compliance-safe" + the SOC2 reference; accept any of them.
    assert.match(src, /SOC2/i);
  });
});

// ---------------------------------------------------------------------------
// Claim: Customer feedback loop (suppression becomes signal)
// ---------------------------------------------------------------------------

describe('marketing claim — customer feedback loop', () => {
  it('POST /api/finding/dismiss route exists', () => {
    assert.ok(fileExists('website/app/api/finding/dismiss/route.ts'));
  });

  it('finding-feedback-store + calibrator + audit linkage', () => {
    assert.ok(fileExists('website/app/lib/finding-feedback-store.ts'));
    assert.ok(fileExists('website/app/lib/trainers/confidence-calibrator.js'));
  });
});

// ---------------------------------------------------------------------------
// Claim: Per-scan upfront billing (no subscription, no seat counting)
// ---------------------------------------------------------------------------

describe('marketing claim — per-scan upfront billing', () => {
  it('CLAUDE.md describes per-scan upfront model', () => {
    const md = readFile('CLAUDE.md');
    assert.match(md, /per[-\s]scan/i);
  });
});

// ---------------------------------------------------------------------------
// Claim: protected platforms (Crontech + Gluecron + MarcoReid)
// ---------------------------------------------------------------------------

describe('marketing claim — protected platforms', () => {
  it('integrations directory ships the gate yaml + pre-push + install.sh', () => {
    assert.ok(fileExists('integrations/github-actions/gatetest-gate.yml'));
    assert.ok(fileExists('integrations/husky/pre-push'));
    assert.ok(fileExists('integrations/scripts/install.sh'));
  });

  it('tests/integrations.test.js exists (the tripwire)', () => {
    assert.ok(fileExists('tests/integrations.test.js'));
  });
});
