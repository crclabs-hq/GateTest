/**
 * Model pass-through in the AI fix layer (Craig 2026-07-10 — user-selectable
 * model). Proves an explicit `model` opt reaches callAnthropic on the
 * surgical path, and that the default stays on CHEAP_MODEL for small files.
 * Uses the _callAnthropic injection hook — no network.
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { aiFix } = require('../src/core/ai-fix-engine');
const { CHEAP_MODEL } = require('../src/core/engine-models');

function makeTempFile(content, ext = '.js') {
  const p = path.join(os.tmpdir(), `gatetest-model-test-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

function makeLines(n) {
  const rows = [];
  for (let i = 1; i <= n; i++) rows.push(`line${i}`);
  return rows.join('\n');
}

async function runSurgicalFixCapturingModel(extraOpts) {
  const original = makeLines(50);
  const filePath = makeTempFile(original);
  const captured = { model: null };
  try {
    const origLines = original.split('\n');
    const windowLines = origLines.slice(4, 45);
    windowLines[20] = 'FIXED_LINE_25';
    const mockReplacement = windowLines.join('\n');

    const result = await aiFix({
      filePath,
      issueTitle: 'test-issue',
      issueMessage: 'line 25 has a problem',
      lineNumber: 25,
      apiKey: 'test-key',
      _callAnthropic: async (_apiKey, model) => {
        captured.model = model;
        return mockReplacement;
      },
      ...extraOpts,
    });
    assert.equal(result.fixed, true, `fix should apply: ${result.description}`);
    return captured.model;
  } finally {
    fs.rmSync(filePath, { force: true });
  }
}

test('aiFix passes an explicit model choice through to callAnthropic', async () => {
  const model = await runSurgicalFixCapturingModel({ model: 'claude-fable-5' });
  assert.equal(model, 'claude-fable-5');
});

test('aiFix defaults to CHEAP_MODEL for small files when no model is given', async () => {
  const model = await runSurgicalFixCapturingModel({});
  assert.equal(model, CHEAP_MODEL);
});
