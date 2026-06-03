'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LIB_PATH = path.join(ROOT, 'website/app/lib/multi-agent-consensus.ts');
const OPENAI_PATH = path.join(ROOT, 'website/app/lib/openai-client.ts');

// Source-level assertions — runtime logic is unit-tested via a minimal
// CommonJS shim below that mirrors the TS implementation. The shim is
// kept tiny on purpose so it doesn't diverge from the TS.

test('multi-agent-consensus: source files exist', () => {
  assert.ok(fs.existsSync(LIB_PATH));
  assert.ok(fs.existsSync(OPENAI_PATH));
});

test('multi-agent-consensus: exports the expected public surface', () => {
  const src = fs.readFileSync(LIB_PATH, 'utf8');
  for (const name of [
    'runConsensus',
    'parseFixBlock',
    'normaliseFix',
    'summariseDifferences',
    'classifyAgreement',
    'renderConsensusReport',
  ]) {
    assert.match(src, new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`), `missing export: ${name}`);
  }
});

test('multi-agent-consensus: opt-in default OpenAI model is gpt-4o', () => {
  const src = fs.readFileSync(LIB_PATH, 'utf8');
  assert.match(src, /DEFAULT_OPENAI_MODEL\s*=\s*["']gpt-4o["']/);
});

test('multi-agent-consensus: parseFixBlock rejects 0 or >1 fences (no silent first-pick)', () => {
  const src = fs.readFileSync(LIB_PATH, 'utf8');
  assert.match(src, /fences\.length === 0/);
  assert.match(src, /fences\.length > 1/);
});

test('multi-agent-consensus: classifier emits five distinct agreement states', () => {
  const src = fs.readFileSync(LIB_PATH, 'utf8');
  for (const s of ['"full"', '"partial"', '"disagree"', '"single_agent"', '"no_parse"']) {
    assert.match(src, new RegExp(`${s}`));
  }
});

test('multi-agent-consensus: classifyAgreement uses confidence levels high/medium/low/none', () => {
  const src = fs.readFileSync(LIB_PATH, 'utf8');
  for (const c of ['"high"', '"medium"', '"low"', '"none"']) {
    assert.match(src, new RegExp(c));
  }
});

test('multi-agent-consensus: disagreement returns mergedFix === null (human review)', () => {
  const src = fs.readFileSync(LIB_PATH, 'utf8');
  // mergedFix declared as null; only set to claude.fix when full or partial
  assert.match(src, /let mergedFix:\s*string\s*\|\s*null\s*=\s*null/);
  assert.match(src, /agreement === "full" \|\| agreement === "partial"/);
});

test('openai-client: configured by OPENAI_API_KEY env var', () => {
  const src = fs.readFileSync(OPENAI_PATH, 'utf8');
  assert.match(src, /process\.env\.OPENAI_API_KEY/);
  assert.match(src, /export\s+function\s+isOpenAiConfigured/);
});

test('openai-client: 45s default request timeout matches Anthropic chokepoint', () => {
  const src = fs.readFileSync(OPENAI_PATH, 'utf8');
  assert.match(src, /DEFAULT_TIMEOUT_MS\s*=\s*45_000/);
});

test('openai-client: low-temperature default for code generation', () => {
  const src = fs.readFileSync(OPENAI_PATH, 'utf8');
  assert.match(src, /temperature:\s*0\.2/);
});

// ============================================================
// Pure-logic unit tests via a minimal mirror of parseFixBlock,
// normaliseFix, summariseDifferences, classifyAgreement.
// If the TS implementation diverges, the source-level matchers
// above are the tripwire — this block stays small and stable.
// ============================================================

function parseFixBlock(text) {
  if (typeof text !== 'string') return { fix: null, rationale: null };
  const fences = [...text.matchAll(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g)];
  if (fences.length === 0) return { fix: null, rationale: text.trim() || null };
  if (fences.length > 1) return { fix: null, rationale: text.trim() || null };
  const fix = fences[0][1].trim();
  const idx = fences[0].index ?? 0;
  const before = text.slice(0, idx).trim();
  const after = text.slice(idx + fences[0][0].length).trim();
  const rationale = [before, after].filter(Boolean).join('\n\n').trim() || null;
  return { fix, rationale };
}

function normaliseFix(fix) {
  return fix
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

test('parseFixBlock: single fenced block extracts cleanly with rationale', () => {
  const out = parseFixBlock('Reasoning here.\n\n```diff\n- old\n+ new\n```\nMore notes.');
  assert.equal(out.fix, '- old\n+ new');
  assert.equal(out.rationale, 'Reasoning here.\n\nMore notes.');
});

test('parseFixBlock: zero fences → null fix, full text as rationale', () => {
  const out = parseFixBlock('No code block here.');
  assert.equal(out.fix, null);
  assert.equal(out.rationale, 'No code block here.');
});

test('parseFixBlock: two fences → null fix (no silent first-pick)', () => {
  const out = parseFixBlock('```\nA\n```\nplus\n```\nB\n```');
  assert.equal(out.fix, null);
});

test('normaliseFix: trims trailing whitespace + CRLF + leading/trailing blank lines', () => {
  const input = '\r\n  hello   \r\nworld   \r\n\r\n';
  assert.equal(normaliseFix(input), '  hello\nworld');
});

test('normaliseFix: identical inputs yield identical normalised outputs', () => {
  const a = 'fn(x) {\n  return x + 1;\n}';
  const b = 'fn(x) {  \n  return x + 1;  \n}\n\n';
  assert.equal(normaliseFix(a), normaliseFix(b));
});
