'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SCENARIOS,
  CATEGORIES,
  getAllScenarios,
  getScenariosByCategory,
} = require('../src/modules/ai-guardrails/scenarios');

test('scenarios: corpus is non-empty and shipped at scale', () => {
  assert.ok(Array.isArray(SCENARIOS));
  assert.ok(SCENARIOS.length >= 28, `expect at least 28 scenarios, got ${SCENARIOS.length}`);
});

test('scenarios: every scenario has the required fields', () => {
  for (const s of SCENARIOS) {
    assert.equal(typeof s.id, 'string', `id must be string: ${JSON.stringify(s)}`);
    assert.ok(s.id.length > 0, `id non-empty: ${JSON.stringify(s)}`);
    assert.equal(typeof s.category, 'string', `category must be string: ${s.id}`);
    assert.ok(CATEGORIES.includes(s.category), `${s.id}: bad category ${s.category}`);
    assert.ok(s.severity === 'error' || s.severity === 'warning', `${s.id}: bad severity`);
    assert.equal(typeof s.title, 'string');
    assert.equal(typeof s.prompt, 'string');
    assert.ok(s.prompt.length > 0, `${s.id}: empty prompt`);
  }
});

test('scenarios: all ids unique', () => {
  const seen = new Set();
  for (const s of SCENARIOS) {
    assert.equal(seen.has(s.id), false, `duplicate id: ${s.id}`);
    seen.add(s.id);
  }
});

test('scenarios: every category has at least 3 scenarios', () => {
  for (const cat of CATEGORIES) {
    const matches = SCENARIOS.filter((s) => s.category === cat);
    assert.ok(matches.length >= 3, `category ${cat} has only ${matches.length} scenarios`);
  }
});

test('scenarios: jailbreak + topic_constraint scenarios carry forbiddenSubstrings', () => {
  for (const s of SCENARIOS) {
    if (s.category === 'jailbreak' || s.category === 'topic_constraint') {
      assert.ok(Array.isArray(s.forbiddenSubstrings), `${s.id}: missing forbiddenSubstrings`);
    }
  }
});

test('scenarios: prompt_injection scenarios carry injectionMarkers', () => {
  for (const s of SCENARIOS) {
    if (s.category === 'prompt_injection') {
      assert.ok(Array.isArray(s.injectionMarkers), `${s.id}: missing injectionMarkers`);
    }
  }
});

test('scenarios: pii_leak scenarios carry secretStrings', () => {
  for (const s of SCENARIOS) {
    if (s.category === 'pii_leak') {
      assert.ok(Array.isArray(s.secretStrings), `${s.id}: missing secretStrings`);
    }
  }
});

test('scenarios: schema_integrity scenarios carry requiredKeys', () => {
  for (const s of SCENARIOS) {
    if (s.category === 'schema_integrity') {
      assert.ok(Array.isArray(s.requiredKeys), `${s.id}: missing requiredKeys`);
    }
  }
});

test('scenarios: tool_exfil scenarios carry attackerHosts', () => {
  for (const s of SCENARIOS) {
    if (s.category === 'tool_exfil') {
      assert.ok(Array.isArray(s.attackerHosts), `${s.id}: missing attackerHosts`);
    }
  }
});

test('scenarios: cost_control scenarios carry maxAcceptableResponseChars', () => {
  for (const s of SCENARIOS) {
    if (s.category === 'cost_control') {
      assert.equal(typeof s.maxAcceptableResponseChars, 'number', `${s.id}: missing cap`);
      assert.ok(s.maxAcceptableResponseChars > 0, `${s.id}: cap not positive`);
    }
  }
});

test('getAllScenarios: returns a copy (not the live array)', () => {
  const a = getAllScenarios();
  const b = getAllScenarios();
  assert.notEqual(a, b);
  assert.equal(a.length, b.length);
});

test('getScenariosByCategory: returns only matching scenarios', () => {
  for (const cat of CATEGORIES) {
    const matches = getScenariosByCategory(cat);
    for (const m of matches) {
      assert.equal(m.category, cat);
    }
  }
});

test('getScenariosByCategory: unknown category → empty array', () => {
  assert.deepEqual(getScenariosByCategory('made-up-category'), []);
});

test('scenarios: no forbidden substring is empty / non-string (would always trigger)', () => {
  for (const s of SCENARIOS) {
    const lists = [
      s.forbiddenSubstrings,
      s.injectionMarkers,
      s.secretStrings,
      s.attackerHosts,
      s.inventedClaims,
    ];
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        assert.equal(typeof entry, 'string', `${s.id}: non-string in marker list`);
      }
    }
  }
});
