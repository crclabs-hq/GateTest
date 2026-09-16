// =============================================================================
// vscode-extension-fix-worker.test.js (heavy — runs the real orchestrator)
//
// The extension's "Fix This Finding (your own key)" command runs the engine's
// fix orchestrator in the worker thread (`mode: 'fix'`). These tests drive the
// worker end to end with a STUB TRANSPORT injected through workerData
// (`transportPath`), so the real orchestrator parses hypotheses, runs the
// syntax gate, ranks and writes its winner — and no AI provider is ever
// called. They pin the protocol the extension host relies on:
//
//   estimate → (proceed) → fix:call / fix:usage → done { fix, cost }
//
// and the promises the command makes: nothing is sent before the host says
// proceed, the working tree is never written, the cost is reported from the
// provider's usage, and the USD cap aborts before the next call.
//
//   node --test tests/heavy/vscode-extension-fix-worker.test.js
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

const ROOT = path.resolve(__dirname, '..', '..');
const EXT_DIR = path.join(ROOT, 'vscode-extension');
const bridge = require(path.join(EXT_DIR, 'engine', 'engine-bridge.js'));
const budget = require(path.join(ROOT, 'src', 'core', 'budget-tracker.js'));
const models = require(path.join(ROOT, 'src', 'core', 'engine-models.js'));

const H = ['=== GATETEST_HYPOTHESIS_ALPHA ===', '=== GATETEST_HYPOTHESIS_BETA ===', '=== GATETEST_HYPOTHESIS_GAMMA ==='];

const ORIGINAL = "const AWS_SECRET_ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLEKEY0';\nmodule.exports = { AWS_SECRET_ACCESS_KEY };\n";
const FIXED = "const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;\nmodule.exports = { AWS_SECRET_ACCESS_KEY };\n";

function threeHypotheses(alpha) {
  return [H[0], alpha, H[1], alpha.replace('process.env', 'process.env /* beta */'), H[2], alpha.replace('process.env', 'process.env /* gamma */')].join('\n');
}

/** A fixture project plus a stub transport module that records every call. */
function fixture(responses) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ext-fix-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'leaky.js'), ORIGINAL);
  fs.writeFileSync(path.join(dir, 'responses.json'), JSON.stringify(responses));
  fs.writeFileSync(path.join(dir, 'stub-transport.js'), [
    "'use strict';",
    "const fs = require('fs');",
    "const path = require('path');",
    "const responses = JSON.parse(fs.readFileSync(path.join(__dirname, 'responses.json'), 'utf8'));",
    'let n = 0;',
    'exports.callProvider = async ({ apiKey, body, model }) => {',
    '  const r = responses[Math.min(n, responses.length - 1)]; n += 1;',
    "  fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify({ apiKeyLength: apiKey.length, model, body: JSON.parse(body) }) + '\\n');",
    "  return { status: 200, data: { model, content: [{ type: 'text', text: r.text }], usage: r.usage } };",
    '};',
    '',
  ].join('\n'));
  return {
    dir,
    file: path.join(dir, 'src', 'leaky.js'),
    transportPath: path.join(dir, 'stub-transport.js'),
    eventsPath: path.join(dir, 'fix-events.jsonl'),
    calls: () => (fs.existsSync(path.join(dir, 'calls.jsonl'))
      ? fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      : []),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Run the worker in fix mode. `onEstimate` receives the estimate message and
 * returns the proceed answer (default: yes). Resolves with every message seen.
 */
function runFixWorker(workerData, { onEstimate } = {}) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const w = new Worker(path.join(EXT_DIR, 'engine', 'engine-worker.js'), { workerData });
    const timer = setTimeout(() => { w.terminate(); reject(new Error('worker timed out')); }, 120_000);
    w.on('message', (m) => {
      messages.push(m);
      if (m.type === 'estimate') {
        const ok = onEstimate ? onEstimate(m) : true;
        w.postMessage({ type: 'proceed', ok });
      } else if (m.type === 'done') {
        clearTimeout(timer);
        resolve({ fix: m.fix, messages });
      } else if (m.type === 'error') {
        clearTimeout(timer);
        reject(new Error(m.message));
      }
    });
    w.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

const entry = bridge.resolveEngineEntry({ configuredPath: ROOT }).entry;
const usage = (input_tokens, output_tokens) => ({ input_tokens, output_tokens });

describe('vscode-extension worker, mode "fix": protocol with a stub transport', () => {
  it('estimate → proceed → fix:call/fix:usage → done, with the cost from the provider usage and the working tree untouched', async () => {
    const fx = fixture([{ text: threeHypotheses(FIXED), usage: usage(1500, 600) }]);
    try {
      let estimateMsg = null;
      const { fix, messages } = await runFixWorker({
        mode: 'fix', entry, file: fx.file, issues: ['secrets:aws-key — hard-coded credential'],
        apiKey: 'test-key-not-real', depth: 'standard', maxUsd: 2, transportPath: fx.transportPath, eventsPath: fx.eventsPath,
      }, { onEstimate: (m) => { estimateMsg = m; return true; } });

      // The estimate arrives first, before anything reaches the transport.
      assert.strictEqual(messages[0].type, 'estimate');
      assert.strictEqual(estimateMsg.depth, 'standard');
      assert.strictEqual(estimateMsg.model, models.CHEAP_MODEL, 'standard depth is the engine default fix model');
      assert.strictEqual(estimateMsg.maxUsd, 2);
      assert.strictEqual(estimateMsg.priced, true, 'the checkout engine has a price table');
      assert.strictEqual(estimateMsg.estimate.available, true);
      const e = estimateMsg.estimate.estimate;
      assert.strictEqual(e.fileTokens, budget.estimateTokens(ORIGINAL));
      assert.deepStrictEqual(e.rate, budget.priceFor('claude-sonnet-5'));
      assert.ok(e.worstCaseUsd > e.perAttemptUsd && e.maxAttempts === 3);

      const events = messages.filter((m) => m.type === 'progress').map((m) => m.event);
      assert.deepStrictEqual(events, ['fix:call', 'fix:usage']);
      const usageMsg = messages.find((m) => m.type === 'progress' && m.event === 'fix:usage');
      assert.strictEqual(usageMsg.payload.tokensIn, 1500);
      assert.strictEqual(usageMsg.payload.tokensOut, 600);

      // The real orchestrator parsed, syntax-gated and ranked the hypotheses.
      assert.strictEqual(fix.fixed, true);
      assert.strictEqual(fix.hypothesis, 'Alpha', 'minimal diff wins the lineDelta tiebreak');
      assert.strictEqual(fix.attempt, 1);
      assert.strictEqual(fix.changed, true);
      // The orchestrator `.trim()`s every hypothesis (_parseHypotheses), so a
      // proposal never carries the trailing newline — same as `gatetest fix`.
      assert.strictEqual(fix.proposed, FIXED.trim());
      assert.strictEqual(fix.testsRun, false);
      assert.match(fix.testsNote, /temporary copy/);
      assert.strictEqual(fs.readFileSync(fx.file, 'utf8'), ORIGINAL, 'the working tree is never written by the worker');

      // Cost: exact tokens from usage, priced at the engine rate for the model that ran.
      assert.deepStrictEqual(
        { tokensIn: fix.cost.tokensIn, tokensOut: fix.cost.tokensOut, calls: fix.cost.calls, model: fix.cost.model },
        { tokensIn: 1500, tokensOut: 600, calls: 1, model: 'claude-sonnet-5' },
      );
      assert.strictEqual(fix.cost.usdEstimated, Number(budget.usdFor('claude-sonnet-5', 1500, 600).toFixed(4)));
      assert.strictEqual(fix.cost.priced, true);
      assert.strictEqual(fix.cost.exact, true);
      assert.strictEqual(fix.cost.capUsd, 2);
      assert.strictEqual(fix.cost.capEnforced, true);
      assert.strictEqual(fix.cost.aborted, false);
      assert.strictEqual(fix.cost.depth, 'standard');
      assert.match(bridge.formatCost(fix.cost), /^1,500 in \/ 600 out tokens · \$0\.0135 · standard depth · 1 call\(s\)$/);

      // The request the transport saw is the engine's own shape.
      const calls = fx.calls();
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].model, 'claude-sonnet-5');
      assert.strictEqual(calls[0].body.max_tokens, 8192);
      assert.ok(calls[0].body.messages[0].content.includes(ORIGINAL.trim()), 'the file body is in the prompt');
      assert.ok(calls[0].body.messages[0].content.includes('secrets:aws-key'), 'the issue text is in the prompt');
      assert.ok(fs.existsSync(fx.eventsPath), 'the flywheel event was recorded where the caller asked');
    } finally {
      fx.cleanup();
    }
  });

  it('a declined estimate sends nothing to the provider', async () => {
    const fx = fixture([{ text: threeHypotheses(FIXED), usage: usage(1500, 600) }]);
    try {
      const { fix, messages } = await runFixWorker({
        mode: 'fix', entry, file: fx.file, issues: ['secrets:aws-key — hard-coded credential'],
        apiKey: 'test-key-not-real', maxUsd: 2, transportPath: fx.transportPath, eventsPath: fx.eventsPath,
      }, { onEstimate: () => false });
      assert.strictEqual(fix.fixed, false);
      assert.strictEqual(fix.reason, 'declined');
      assert.strictEqual(fix.cost.calls, 0);
      assert.strictEqual(fix.cost.usdEstimated, 0);
      assert.deepStrictEqual(fx.calls(), []);
      assert.ok(!messages.some((m) => m.type === 'progress'));
    } finally {
      fx.cleanup();
    }
  });

  it('the USD cap aborts before the NEXT call and the run reports it', async () => {
    // First call: unparseable (no delimiters) so the orchestrator retries, with
    // usage large enough to cross a $0.001 cap. The retry's preflight throws.
    const fx = fixture([
      { text: 'no hypotheses here', usage: usage(200_000, 50_000) },
      { text: threeHypotheses(FIXED), usage: usage(1500, 600) },
    ]);
    try {
      const { fix } = await runFixWorker({
        mode: 'fix', entry, file: fx.file, issues: ['secrets:aws-key — hard-coded credential'],
        apiKey: 'test-key-not-real', maxUsd: 0.001, transportPath: fx.transportPath, eventsPath: fx.eventsPath,
      });
      assert.strictEqual(fix.fixed, false);
      assert.match(fix.reason, /ai-provider-error: AI provider budget exhausted: usd cap exceeded/);
      assert.strictEqual(fix.cost.aborted, true);
      assert.match(fix.cost.abortReason, /usd cap exceeded/);
      assert.strictEqual(fix.cost.calls, 1, 'the second call never happened');
      assert.strictEqual(fx.calls().length, 1);
      assert.strictEqual(fix.proposed, null);
      assert.strictEqual(fs.readFileSync(fx.file, 'utf8'), ORIGINAL);
    } finally {
      fx.cleanup();
    }
  });

  it('rejects a depth outside the engine table before any estimate', async () => {
    const fx = fixture([{ text: threeHypotheses(FIXED), usage: usage(1, 1) }]);
    try {
      await assert.rejects(
        runFixWorker({ mode: 'fix', entry, file: fx.file, issues: ['x'], apiKey: 'k', depth: 'ultra', transportPath: fx.transportPath }),
        /Unknown fix depth "ultra"/,
      );
      assert.deepStrictEqual(fx.calls(), []);
    } finally {
      fx.cleanup();
    }
  });

  it('deep runs the engine fix-tier model and is priced at that model\'s rate', async () => {
    const fx = fixture([{ text: threeHypotheses(FIXED), usage: usage(1500, 600) }]);
    try {
      const { fix } = await runFixWorker({
        mode: 'fix', entry, file: fx.file, issues: ['secrets:aws-key — hard-coded credential'],
        apiKey: 'test-key-not-real', depth: 'deep', maxUsd: 2, transportPath: fx.transportPath, eventsPath: fx.eventsPath,
      });
      assert.strictEqual(fix.fixed, true);
      assert.strictEqual(fix.cost.depth, 'deep');
      assert.strictEqual(fix.cost.model, models.FIX_MODEL);
      assert.strictEqual(fx.calls()[0].model, models.FIX_MODEL, 'the request carries the engine fix-tier model');
      assert.strictEqual(fix.cost.usdEstimated, Number(budget.usdFor(models.FIX_MODEL, 1500, 600).toFixed(4)));
      assert.ok(fix.cost.usdEstimated > budget.usdFor(models.CHEAP_MODEL, 1500, 600), 'deep costs more than standard for the same tokens');
    } finally {
      fx.cleanup();
    }
  });

  it('with no usage in the response the cost is flagged as estimated, never silently exact', async () => {
    const fx = fixture([{ text: threeHypotheses(FIXED), usage: undefined }]);
    try {
      const { fix } = await runFixWorker({
        mode: 'fix', entry, file: fx.file, issues: ['secrets:aws-key — hard-coded credential'],
        apiKey: 'test-key-not-real', maxUsd: 2, transportPath: fx.transportPath, eventsPath: fx.eventsPath,
      });
      assert.strictEqual(fix.fixed, true);
      assert.strictEqual(fix.cost.exact, false);
      assert.ok(fix.cost.tokensIn > 0 && fix.cost.tokensOut > 0, 'char-based estimate stands in');
      assert.match(bridge.formatCost(fix.cost), /token counts estimated/);
    } finally {
      fx.cleanup();
    }
  });
});

// The bundled engine (vscode-extension/node_modules/@gatetest/cli) is the one
// most Marketplace users run. Until a release carries budget-tracker.js it has
// no price table: the estimate must say so and USD must be null — not $0.00.
describe('vscode-extension worker, mode "fix": an engine without a price table', () => {
  const bundledDir = path.join(EXT_DIR, 'node_modules', '@gatetest', 'cli');
  const bundled = bridge.entryFromPath(bundledDir);
  const hasPriceTable = bundled && fs.existsSync(path.join(bundled.packageDir, 'src', 'core', 'budget-tracker.js'));

  it('reports "estimate unavailable" and counts tokens without pricing them', { skip: !bundled ? 'bundled engine not installed (run npm ci in vscode-extension/)' : hasPriceTable ? 'bundled engine now ships a price table' : false }, async () => {
    const fx = fixture([{ text: threeHypotheses(FIXED), usage: usage(1500, 600) }]);
    try {
      let estimateMsg = null;
      const { fix } = await runFixWorker({
        mode: 'fix', entry: bundled.entry, file: fx.file, issues: ['secrets:aws-key — hard-coded credential'],
        apiKey: 'test-key-not-real', maxUsd: 2, transportPath: fx.transportPath, eventsPath: fx.eventsPath,
      }, { onEstimate: (m) => { estimateMsg = m; return true; } });
      assert.strictEqual(estimateMsg.priced, false);
      assert.strictEqual(estimateMsg.estimate.available, false);
      assert.match(estimateMsg.estimate.reason, /no price table/);
      assert.match(bridge.formatEstimate(estimateMsg.estimate, 2), /estimate unavailable/i);
      assert.strictEqual(fix.fixed, true);
      assert.strictEqual(fix.cost.usdEstimated, null);
      assert.strictEqual(fix.cost.priced, false);
      assert.strictEqual(fix.cost.capEnforced, false);
      assert.deepStrictEqual([fix.cost.tokensIn, fix.cost.tokensOut], [1500, 600]);
      assert.match(bridge.formatCost(fix.cost), /USD unavailable \(engine 1\.\d+\.\d+ has no price table/);
      // Without the depth table only standard is available; deep must say so rather than guess a model.
      await assert.rejects(
        runFixWorker({ mode: 'fix', entry: bundled.entry, file: fx.file, issues: ['x'], apiKey: 'k', depth: 'deep', transportPath: fx.transportPath }),
        /no "deep" fix depth — upgrade/,
      );
    } finally {
      fx.cleanup();
    }
  });
});
