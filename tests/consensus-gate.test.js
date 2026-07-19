'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveConsensusGate } = require('../website/app/lib/consensus-gate');

test('resolveConsensusGate: all three conditions true → useConsensus true, no reason', () => {
  const result = resolveConsensusGate({
    consensusRequested: true,
    tierIsNuclear: true,
    openAiConfigured: true,
  });
  assert.deepEqual(result, { useConsensus: true, reason: null });
});

test('resolveConsensusGate: consensus not requested → skipped with "not requested" reason', () => {
  const result = resolveConsensusGate({
    consensusRequested: false,
    tierIsNuclear: true,
    openAiConfigured: true,
  });
  assert.equal(result.useConsensus, false);
  assert.match(result.reason, /not requested/);
});

test('resolveConsensusGate: requested but wrong tier → skipped with tier reason', () => {
  const result = resolveConsensusGate({
    consensusRequested: true,
    tierIsNuclear: false,
    openAiConfigured: true,
  });
  assert.equal(result.useConsensus, false);
  assert.match(result.reason, /tier is not nuclear/);
  assert.match(result.reason, /\$399/);
});

test('resolveConsensusGate: requested + right tier but OpenAI not configured → skipped with config reason', () => {
  const result = resolveConsensusGate({
    consensusRequested: true,
    tierIsNuclear: true,
    openAiConfigured: false,
  });
  assert.equal(result.useConsensus, false);
  assert.match(result.reason, /OPENAI_API_KEY not configured/);
});

test('resolveConsensusGate: "not requested" reason takes priority over other failures', () => {
  // When multiple conditions fail, the "not requested" branch should win —
  // matches the checked order in the implementation (request first).
  const result = resolveConsensusGate({
    consensusRequested: false,
    tierIsNuclear: false,
    openAiConfigured: false,
  });
  assert.match(result.reason, /not requested/);
});

test('resolveConsensusGate: never throws on missing/undefined fields (defensive)', () => {
  const result = resolveConsensusGate({});
  assert.equal(result.useConsensus, false);
  assert.match(result.reason, /not requested/);
});
