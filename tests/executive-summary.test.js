// ============================================================================
// EXECUTIVE-SUMMARY TEST — Phase 3.5 of THE FIX-FIRST BUILD PLAN
// ============================================================================
// Covers website/app/lib/executive-summary.js — the customer-facing
// CTO-readable synthesis of the Nuclear-tier deliverable.
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  composeExecutiveSummary,
  renderExecutiveSummary,
  buildSummaryPrompt,
  parseSummaryOutput,
} = require('../website/app/lib/executive-summary.js');

const validResponse = `HEADLINE: Production-ready overall but three high-priority security fixes are outstanding.

POSTURE:
- 87% of scanned modules pass cleanly, indicating strong baseline hygiene.
- Two error-severity findings concentrate in auth and supply-chain — these are the dominant risk signals.
- One identified attack chain combines a CSP gap with a permissive CORS origin into an exploitable vector.
- Code quality (linting, secrets, TypeScript strictness) is clean across the source tree.

TOP_3_ACTIONS:
1. Remove unsafe-inline from the CSP and redeploy — blocks the XSS landing step in the identified chain.
2. Rotate the JWT_SECRET environment variable to a high-entropy value before next release.
3. Replace the wildcard CORS Allow-Origin with an explicit allowlist tied to your production domain.

WORKING_WELL:
- All 47 source files pass syntax validation and lint with no warnings.
- Zero hardcoded secrets detected anywhere in the repo or git history.
- Test coverage flagged no flaky tests, no committed .only / .skip markers.

RECOMMENDED_NEXT: Address the Top 3 Actions this week, then re-run the Nuclear scan to verify the chain is broken.`;

const sampleScanStats = {
  modulesPassed: 30,
  modulesTotal: 39,
  errors: 4,
  warnings: 28,
  checksPerformed: 800,
  durationMs: 9500,
};

const sampleFindings = [
  { detail: 'CSP allows unsafe-inline scripts', module: 'webHeaders', severity: 'error' },
  { detail: 'JWT_SECRET="changeme" in source', module: 'secrets', severity: 'error' },
  { detail: 'CORS Allow-Origin: *', module: 'webHeaders', severity: 'warning' },
];

const sampleChains = [
  { title: 'XSS to session takeover', severity: 'critical', impact: 'attacker can take over a session' },
];

// ---------- buildSummaryPrompt ----------

test('buildSummaryPrompt — includes scan stats line', () => {
  const p = buildSummaryPrompt({ scanStats: sampleScanStats, topFindings: sampleFindings });
  assert.match(p, /30\/39 modules passed/);
  assert.match(p, /4 errors/);
  assert.match(p, /28 warnings/);
  assert.match(p, /800 checks/);
  assert.match(p, /9500ms/);
});

test('buildSummaryPrompt — handles missing scan stats', () => {
  const p = buildSummaryPrompt({ topFindings: sampleFindings });
  assert.match(p, /no scan stats provided/);
});

test('buildSummaryPrompt — caps findings at 10, chains at 5', () => {
  const manyFindings = Array.from({ length: 50 }, (_, i) => ({ detail: `f${i}`, module: 'm', severity: 'warning' }));
  const manyChains = Array.from({ length: 20 }, (_, i) => ({ title: `c${i}`, severity: 'high', impact: 'thing' }));
  const p = buildSummaryPrompt({ topFindings: manyFindings, chains: manyChains });
  // Findings: only first 10 numbered
  assert.match(p, /^1\. .*f0/m);
  assert.match(p, /^10\. .*f9/m);
  assert.doesNotMatch(p, /^11\. /m);
  // Chains: only first 5
  const chainCount = (p.match(/\] c\d+/g) || []).length;
  assert.equal(chainCount, 5);
});

test('buildSummaryPrompt — explicit "no jargon, no platitudes" instruction', () => {
  const p = buildSummaryPrompt({ topFindings: sampleFindings });
  assert.match(p, /jargon/i);
  assert.match(p, /concrete and specific/);
  assert.match(p, /Don't fish for compliments/);
});

test('buildSummaryPrompt — output schema documented', () => {
  const p = buildSummaryPrompt({ topFindings: sampleFindings });
  assert.match(p, /HEADLINE:/);
  assert.match(p, /POSTURE:/);
  assert.match(p, /TOP_3_ACTIONS:/);
  assert.match(p, /WORKING_WELL:/);
  assert.match(p, /RECOMMENDED_NEXT:/);
  assert.match(p, /SKIP/);
});

// ---------- parseSummaryOutput ----------

test('parseSummaryOutput — happy path captures all 5 sections', () => {
  const r = parseSummaryOutput(validResponse);
  assert.equal(r.ok, true);
  assert.match(r.sections.headline, /Production-ready/);
  assert.match(r.sections.posture, /87%/);
  assert.match(r.sections.topActions, /^1\. Remove unsafe-inline/m);
  assert.match(r.sections.workingWell, /47 source files/);
  assert.match(r.sections.recommendedNext, /this week/);
});

test('parseSummaryOutput — multi-line POSTURE captured intact', () => {
  const r = parseSummaryOutput(validResponse);
  assert.match(r.sections.posture, /87%.*\n/);
  assert.match(r.sections.posture, /attack chain/);
});

test('parseSummaryOutput — SKIP marker', () => {
  const r = parseSummaryOutput('SKIP: scan results too sparse');
  assert.equal(r.ok, false);
  assert.match(r.reason, /declined/);
});

test('parseSummaryOutput — refusal recognised', () => {
  const r = parseSummaryOutput("I cannot generate this summary.");
  assert.equal(r.ok, false);
  assert.match(r.reason, /refused/);
});

test('parseSummaryOutput — missing required section', () => {
  const noActions = `HEADLINE: short headline.\nPOSTURE: stuff.\nWORKING_WELL: stuff.\nRECOMMENDED_NEXT: short rec next.`;
  const r = parseSummaryOutput(noActions);
  assert.equal(r.ok, false);
  assert.match(r.reason, /TOP_3_ACTIONS/);
});

test('parseSummaryOutput — empty / non-string', () => {
  assert.equal(parseSummaryOutput('').ok, false);
  assert.equal(parseSummaryOutput(null).ok, false);
  assert.equal(parseSummaryOutput(42).ok, false);
});

test('parseSummaryOutput — too-short headline rejected', () => {
  const tinyHeadline = `HEADLINE: x\nPOSTURE: stuff.\nTOP_3_ACTIONS: 1. do thing.\nWORKING_WELL: ok.\nRECOMMENDED_NEXT: do the recommended thing now please.`;
  const r = parseSummaryOutput(tinyHeadline);
  assert.equal(r.ok, false);
  assert.match(r.reason, /headline too short/);
});

// ---------- composeExecutiveSummary ----------

test('composeExecutiveSummary — happy path', async () => {
  const r = await composeExecutiveSummary({
    scanStats: sampleScanStats,
    topFindings: sampleFindings,
    chains: sampleChains,
    askClaudeForSummary: async () => validResponse,
  });
  assert.equal(r.ok, true);
  assert.match(r.sections.headline, /Production-ready/);
});

test('composeExecutiveSummary — no findings + no chains skipped', async () => {
  let calls = 0;
  const r = await composeExecutiveSummary({
    scanStats: sampleScanStats,
    topFindings: [],
    chains: [],
    askClaudeForSummary: async () => { calls++; return validResponse; },
  });
  assert.equal(calls, 0);
  assert.equal(r.ok, false);
  assert.match(r.reason, /nothing to summarise/);
});

test('composeExecutiveSummary — AI provider error captured', async () => {
  const r = await composeExecutiveSummary({
    topFindings: sampleFindings,
    askClaudeForSummary: async () => { throw new Error('ECONNRESET'); },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /AI provider error/);
});

test('composeExecutiveSummary — invalid Claude response captured', async () => {
  const r = await composeExecutiveSummary({
    topFindings: sampleFindings,
    askClaudeForSummary: async () => 'this is not the structured format',
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /missing required section/);
});

test('composeExecutiveSummary — input validation', async () => {
  await assert.rejects(
    () => composeExecutiveSummary({ topFindings: [] }),
    /askClaudeForSummary must be a function/
  );
});

test('composeExecutiveSummary — passes hostname into prompt', async () => {
  let promptSeen = '';
  await composeExecutiveSummary({
    topFindings: sampleFindings,
    hostname: 'example.com',
    askClaudeForSummary: async (p) => { promptSeen = p; return validResponse; },
  });
  assert.match(promptSeen, /example\.com/);
});

// ---------- renderExecutiveSummary ----------

test('renderExecutiveSummary — successful render with all sections', () => {
  const r = {
    ok: true,
    sections: {
      headline: 'Production-ready with three high-priority fixes outstanding.',
      posture: '- 87% of modules pass cleanly.\n- Two error-severity findings concentrate in auth.',
      topActions: '1. Remove unsafe-inline from CSP.\n2. Rotate JWT secret.\n3. Tighten CORS.',
      workingWell: '- All source files pass syntax + lint.\n- No hardcoded secrets.',
      recommendedNext: 'Address Top 3 Actions this week, then re-scan.',
    },
  };
  const out = renderExecutiveSummary(r, { hostname: 'example.com' });
  assert.match(out, /^# Executive Summary/m);
  assert.match(out, /\*\*Subject:\*\* `example\.com`/);
  assert.match(out, /Production-ready with three/);
  assert.match(out, /## Risk posture/);
  assert.match(out, /## Top 3 actions for this week/);
  assert.match(out, /## What is working well/);
  assert.match(out, /## Recommended next step/);
  assert.match(out, /\$399/);
});

test('renderExecutiveSummary — failure renders friendly placeholder', () => {
  const out = renderExecutiveSummary({ ok: false, reason: 'AI provider error', sections: null });
  assert.match(out, /^# Executive Summary/m);
  assert.match(out, /not generated/);
  assert.match(out, /AI provider error/);
});

test('renderExecutiveSummary — null result handled', () => {
  const out = renderExecutiveSummary(null);
  assert.match(out, /not generated/);
});

test('renderExecutiveSummary — hostname optional', () => {
  const r = {
    ok: true,
    sections: {
      headline: 'Headline that is long enough.',
      posture: '- Bullet.',
      topActions: '1. Do.',
      workingWell: '- Good.',
      recommendedNext: 'Do the next thing.',
    },
  };
  const out = renderExecutiveSummary(r);
  assert.doesNotMatch(out, /\*\*Subject:\*\*/);
});
