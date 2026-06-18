'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const AiGuardrailsModule = require('../src/modules/ai-guardrails');

// Minimal stand-in for the real `result` object + `config` object the runner
// passes in. Mirrors what other module tests do (chaos.test.js pattern).

function makeResult() {
  const checks = [];
  return {
    checks,
    addCheck(id, passed, meta) {
      checks.push({ id, passed, meta: meta || {} });
    },
  };
}

function makeConfig(moduleCfg) {
  return {
    getModuleConfig(name) {
      return name === 'aiGuardrails' ? moduleCfg : null;
    },
    get() { return null; },
  };
}

function startTestServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c.toString(); });
      req.on('end', () => {
        try { handler(req, res, body); }
        catch (err) { res.statusCode = 500; res.end(String(err && err.message)); }
      });
    });
    server.listen(0, '127.0.0.1', () => { // hardcoded-url-ok
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` }); // hardcoded-url-ok
    });
  });
}

// ============================================================
// Shape + no-op behaviour
// ============================================================

test('module: source file exists at the registered location', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'src/modules/ai-guardrails.js')));
});

test('module: constructs with name "aiGuardrails"', () => {
  const m = new AiGuardrailsModule();
  assert.equal(m.name, 'aiGuardrails');
});

test('module: no-op (passes config check) when no endpoint configured', async () => {
  const m = new AiGuardrailsModule();
  const result = makeResult();
  delete process.env.GATETEST_AI_GUARDRAILS_ENDPOINT;
  await m.run(result, makeConfig({}));
  assert.equal(result.checks.length, 1);
  assert.equal(result.checks[0].id, 'ai-guardrails:config');
  assert.equal(result.checks[0].passed, true);
});

test('module: no-op when env-var endpoint is empty string', async () => {
  const m = new AiGuardrailsModule();
  const result = makeResult();
  process.env.GATETEST_AI_GUARDRAILS_ENDPOINT = '';
  try {
    await m.run(result, makeConfig({}));
    assert.equal(result.checks[0].id, 'ai-guardrails:config');
  } finally {
    delete process.env.GATETEST_AI_GUARDRAILS_ENDPOINT;
  }
});

// ============================================================
// Live behaviour against a refusing server (all-held path)
// ============================================================

test('module: against an always-refusing endpoint, every category gets a "held" verdict and only the summary check fires', async () => {
  const { server, url } = await startTestServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      choices: [{ message: { content: "I can't help with that — it violates my guidelines." } }],
    }));
  });
  try {
    const m = new AiGuardrailsModule();
    const result = makeResult();
    await m.run(result, makeConfig({
      endpoint: url,
      // Run a smaller subset to keep the test fast — just jailbreak + topic.
      categories: ['jailbreak', 'topic_constraint'],
      timeoutMs: 5000,
    }));
    // All scenarios in those two categories should be "held" → no per-scenario
    // check fires, only the summary.
    const ids = result.checks.map((c) => c.id);
    assert.ok(ids.some((id) => id.startsWith('ai-guardrails:summary')));
    // No bypassed or error checks.
    assert.equal(result.checks.filter((c) => c.id.startsWith('ai-guardrails:bypassed')).length, 0);
    assert.equal(result.checks.filter((c) => c.id.startsWith('ai-guardrails:probe-error')).length, 0);
  } finally {
    server.close();
  }
});

// ============================================================
// Live behaviour against a compliant server (bypass path)
// ============================================================

test('module: against a fully-compliant endpoint, jailbreak scenarios trigger bypassed verdicts', async () => {
  const { server, url } = await startTestServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    // Reply with "Sure, here's the answer:" — looksLikeBypass=true
    res.end(JSON.stringify({
      choices: [{ message: { content: "Sure, here's the step-by-step answer for you." } }],
    }));
  });
  try {
    const m = new AiGuardrailsModule();
    const result = makeResult();
    await m.run(result, makeConfig({
      endpoint: url,
      categories: ['jailbreak'],
      timeoutMs: 5000,
    }));
    const bypassed = result.checks.filter((c) => c.id.startsWith('ai-guardrails:bypassed'));
    assert.ok(bypassed.length >= 1, 'should report at least one bypass');
    // Bypassed checks are failures.
    for (const b of bypassed) {
      assert.equal(b.passed, false);
    }
    // Summary fires too.
    assert.ok(result.checks.some((c) => c.id === 'ai-guardrails:summary'));
  } finally {
    server.close();
  }
});

// ============================================================
// Error path
// ============================================================

test('module: unreachable endpoint surfaces probe-error checks but does not crash', async () => {
  const m = new AiGuardrailsModule();
  const result = makeResult();
  // Pick an unroutable URL — connection will fail immediately.
  await m.run(result, makeConfig({
    endpoint: 'http://127.0.0.1:1/', // hardcoded-url-ok — connection-refused fixture
    categories: ['jailbreak'],
    timeoutMs: 1000,
  }));
  const errors = result.checks.filter((c) => c.id.startsWith('ai-guardrails:probe-error'));
  assert.ok(errors.length >= 1, 'should report probe errors');
  // Summary still fires.
  assert.ok(result.checks.some((c) => c.id === 'ai-guardrails:summary'));
});

// ============================================================
// Category filter
// ============================================================

test('module: empty category filter (after intersection with valid) skips all and reports no-scenarios', async () => {
  const m = new AiGuardrailsModule();
  const result = makeResult();
  await m.run(result, makeConfig({
    endpoint: 'http://127.0.0.1:65535/', // hardcoded-url-ok — endpoint never reached
    categories: ['nonexistent-category'],
  }));
  // Filter intersection with valid CATEGORIES is empty → no-scenarios check.
  const ids = result.checks.map((c) => c.id);
  assert.ok(ids.includes('ai-guardrails:no-scenarios'));
});
