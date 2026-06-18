'use strict';

const test   = require('node:test');
const assert = require('node:assert');

const diag = require('../lib/ai-ci-fixer-diagnose');

test('parseDiagnosis: extracts all four fields from well-formed response', () => {
  const text = `ROOT_CAUSE:
The email validator regex rejects subdomains because it lacks a backslash before the dot.
PLAN:
Update the regex in src/validate.js to allow multi-segment domains.
CONFIDENCE: 4
CONFIDENCE_REASON:
The fix is a one-character regex change in a single file with no callers depending on the old behavior.`;
  const out = diag.parseDiagnosis(text);
  assert.match(out.rootCause, /rejects subdomains/);
  assert.match(out.plan, /Update the regex/);
  assert.equal(out.confidence, 4);
  assert.match(out.confidenceReason, /one-character/);
  assert.equal(out.ok, true);
});

test('parseDiagnosis: clamps confidence to 1..5', () => {
  const high = diag.parseDiagnosis(`ROOT_CAUSE:\nx\nPLAN:\ny\nCONFIDENCE: 9\nCONFIDENCE_REASON:\nz`);
  assert.equal(high.confidence, 5);
  // Score 1 is the floor — anything below clamps up to 1
  const low  = diag.parseDiagnosis(`ROOT_CAUSE:\nx\nPLAN:\ny\nCONFIDENCE: 1\nCONFIDENCE_REASON:\nz`);
  assert.equal(low.confidence, 1);
});

test('parseDiagnosis: returns ok=false on empty input', () => {
  const out = diag.parseDiagnosis('');
  assert.equal(out.ok, false);
  assert.equal(out.confidence, 0);
});

test('parseDiagnosis: returns ok=false on missing CONFIDENCE line', () => {
  const out = diag.parseDiagnosis(`ROOT_CAUSE:\nsomething broke\nPLAN:\nfix it`);
  assert.equal(out.confidence, 0);
  assert.equal(out.ok, false);
});

test('parseDiagnosis: returns ok=true even when one of root/plan is missing (confidence rules)', () => {
  // Diagnosis still useful if only one section came back — as long as confidence is non-zero
  const out = diag.parseDiagnosis(`ROOT_CAUSE:\nbug\nCONFIDENCE: 3\nCONFIDENCE_REASON:\nmaybe`);
  assert.equal(out.confidence, 3);
  assert.equal(out.ok, true);
  assert.equal(out.plan, '');
});

test('buildDiagnosisPrompt: includes the log and the failing-file list', () => {
  const prompt = diag.buildDiagnosisPrompt('error stack here', [
    { path: 'a.js', content: 'x' },
    { path: 'b.ts', content: 'y' },
  ]);
  assert.match(prompt, /error stack here/);
  assert.match(prompt, /- a\.js/);
  assert.match(prompt, /- b\.ts/);
  // Untrusted wrap is on
  assert.match(prompt, /<untrusted_ci_log>/);
  assert.match(prompt, /<untrusted_failing_file_list>/);
});

test('diagnose: returns stub on empty file list', async () => {
  const out = await diag.diagnose({
    apiKey: 'k', model: 'm', logExcerpt: 'log', files: [],
    callClaude: async () => 'should not be called',
  });
  assert.equal(out.ok, false);
  assert.equal(out.confidence, 0);
});

test('diagnose: returns stub on missing apiKey', async () => {
  const out = await diag.diagnose({
    apiKey: '', model: 'm', logExcerpt: 'log',
    files: [{ path: 'x.js', content: 'y' }],
    callClaude: async () => 'should not be called',
  });
  assert.equal(out.ok, false);
});

test('diagnose: parses a Claude response end-to-end', async () => {
  const callClaude = async () => `ROOT_CAUSE:
The thing broke.
PLAN:
Fix the thing.
CONFIDENCE: 5
CONFIDENCE_REASON:
Obvious.`;
  const out = await diag.diagnose({
    apiKey: 'k', model: 'm', logExcerpt: 'log',
    files: [{ path: 'x.js', content: 'y' }],
    callClaude,
  });
  assert.equal(out.ok, true);
  assert.equal(out.confidence, 5);
  assert.match(out.rootCause, /The thing broke/);
});

test('diagnose: returns stub when callClaude throws', async () => {
  const out = await diag.diagnose({
    apiKey: 'k', model: 'm', logExcerpt: 'log',
    files: [{ path: 'x.js', content: 'y' }],
    callClaude: async () => { throw new Error('network down'); },
  });
  assert.equal(out.ok, false);
  assert.equal(out.confidence, 0);
});

test('confidenceBadge: returns ready-to-merge for 5', () => {
  const b = diag.confidenceBadge(5);
  assert.equal(b.label, 'High');
  assert.match(b.tone, /ready to merge/);
});

test('confidenceBadge: returns careful-review for 3', () => {
  const b = diag.confidenceBadge(3);
  assert.equal(b.label, 'Medium');
  assert.match(b.tone, /carefully/);
});

test('confidenceBadge: returns very-low for 1', () => {
  const b = diag.confidenceBadge(1);
  assert.equal(b.label, 'Very low');
});

test('confidenceBadge: returns unknown for 0', () => {
  const b = diag.confidenceBadge(0);
  assert.equal(b.label, 'Unknown');
});
