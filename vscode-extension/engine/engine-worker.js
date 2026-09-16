'use strict';
/**
 * engine-worker.js — runs one GateTest scan, or one local fix, in a worker
 * thread.
 *
 * Why a worker and not the extension host thread: the engine is CPU-bound
 * in places (AST walks over the whole workspace) and a scan of a large repo
 * would freeze the editor for its whole duration. A worker keeps the UI
 * responsive and gives the extension a real cancel: `worker.terminate()`.
 *
 * Why not a child process: that is the old CLI-spawn design this replaces.
 * Same Node, same process, no PATH lookup, no shell quoting, no EINVAL.
 *
 * Protocol (parentPort) — scan, the default mode:
 *   in : workerData = { entry, root, suite, changedFiles?, skipModules? }
 *   out: { type: 'progress', event, payload }   module:start / module:end …
 *        { type: 'log', level, text }           anything modules console.log
 *        { type: 'done', summary }              pruned runner summary
 *        { type: 'error', message, stack }
 *
 * Protocol — fix, `mode: 'fix'` (one finding, the user's own provider key):
 *   in : workerData = {
 *          mode: 'fix', entry, file, issues: string[], apiKey,
 *          depth?        — 'standard' | 'deep' (the engine's FIX_DEPTHS table); empty → standard
 *          maxUsd?       — USD cap; unset/0 → no cap
 *          maxAttempts?  — orchestrator retries; unset → the engine default
 *          autoProceed?  — skip the estimate handshake (tests)
 *          transportPath? — module exporting callProvider({ apiKey, body, model })
 *                           → Promise<{ status, data }>; replaces the HTTPS
 *                           transport so the protocol can be tested with no
 *                           provider in the loop
 *          eventsPath?, recipePath? — passed through to the orchestrator
 *        }
 *   out: { type: 'estimate', estimate, depth, model, maxUsd, engineVersion, priced, priceNote }
 *          ← the host answers parentPort.postMessage({ type: 'proceed', ok })
 *            (skipped under autoProceed); nothing is sent to the provider
 *            before that answer arrives
 *        { type: 'progress', event: 'fix:call',  payload: { call, model } }
 *        { type: 'progress', event: 'fix:usage', payload: { call, tokensIn, tokensOut, usdEstimated } }
 *        { type: 'log', level, text }
 *        { type: 'done', fix: { fixed, reason, proposed, changed, hypothesis,
 *                               rank, attempt, lineDelta, advisory, playback,
 *                               testsRun: false, testsNote, cost } }
 *        { type: 'error', message, stack }
 *   cost = { tokensIn, tokensOut, usdEstimated | null, depth, model, calls, priced,
 *            priceNote, knownPrice, exact, capUsd, capEnforced, aborted, abortReason }
 *
 * The fix runs the engine's own orchestrator (hypotheses, syntax gate,
 * ranking, flywheel recording) against a TEMPORARY COPY of the file, so the
 * working tree is never written from here — the host shows a diff and writes
 * only on Apply. The orchestrator's transport seam (its test hook) is used to swap in a
 * transport that keeps the provider's `usage` object, which the engine's own
 * transport discards; the request body is the same shape the engine sends.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { parentPort, workerData } = require('worker_threads');

// Mirrors the engine transport's request timeout (cli-fix-orchestrator TIMEOUT_MS).
const PROVIDER_TIMEOUT_MS = 90_000;

function post(msg) {
  try { parentPort.postMessage(msg); } catch { /* error-ok — the extension host already went away; nothing left to tell */ }
}

function safeString(v) {
  try { return typeof v === 'object' ? JSON.stringify(v) : String(v); } catch { return String(v); }
}

// Modules write with console.*; in the extension host that lands in the
// developer tools, invisible to the user. Forward it to the output channel.
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  console[level] = (...args) => {
    const text = args.map((a) => (typeof a === 'string' ? a : safeString(a))).join(' ');
    post({ type: 'log', level, text });
  };
}

function pruneModuleResult(r) {
  return {
    module: r.module || r.name,
    status: r.status || (r.passed === false ? 'FAIL' : 'PASS'),
    duration: r.duration,
    checks: Array.isArray(r.checks) ? r.checks.length : (r.checks && r.checks.total) || 0,
  };
}

async function runScan() {
  const { entry, root, suite, changedFiles, skipModules } = workerData || {};
  if (!entry || !root) throw new Error('engine-worker: entry and root are required');

  const { GateTest } = require(entry);

  // The engine sets process.exitCode = 1 when the gate is BLOCKED — meant
  // for a terminal. In a worker it would only colour this thread's exit, but
  // keep it pristine anyway; the summary carries gateStatus.
  const previousExitCode = process.exitCode;

  const options = {
    silent: true,
    onProgress: (event, payload) => {
      const slim = payload && typeof payload === 'object'
        ? {
            module: payload.module || payload.name,
            status: payload.status,
            duration: payload.duration,
            count: Array.isArray(payload.modules) ? payload.modules.length : undefined,
          }
        : payload;
      post({ type: 'progress', event, payload: slim });
    },
  };
  if (Array.isArray(changedFiles) && changedFiles.length) {
    options.diffOnly = true;
    options.changedFiles = changedFiles;
  }

  let summary;
  try {
    summary = await new GateTest(root, options).init().runSuite(suite || 'quick', {
      skipModules: Array.isArray(skipModules) ? skipModules : [],
    });
  } finally {
    process.exitCode = previousExitCode;
  }

  post({
    type: 'done',
    summary: {
      gateStatus: summary.gateStatus,
      nothingChecked: Boolean(summary.nothingChecked),
      findings: Array.isArray(summary.findings) ? summary.findings.slice(0, 2000) : [],
      findingSummary: summary.findingSummary || null,
      deferred: Array.isArray(summary.deferred) ? summary.deferred : [],
      modules: summary.modules || {},
      checks: summary.checks || {},
      duration: summary.duration,
      timestamp: summary.timestamp,
      results: Array.isArray(summary.results) ? summary.results.map(pruneModuleResult) : [],
    },
  });
}

// ─── fix mode ────────────────────────────────────────────────────────────────

/** The HTTPS transport: the same request the engine sends, with `usage` kept. */
function httpsTransport(bridge, packageDir, engineVersion) {
  const cfg = bridge.loadEngineModule(packageDir, 'anthropic-config.js');
  if (!cfg || typeof cfg.endpoint !== 'function') {
    throw new Error(`engine ${engineVersion} has no provider endpoint config (src/core/anthropic-config.js) — upgrade @gatetest/cli`);
  }
  return ({ apiKey, body }) => new Promise((resolve, reject) => {
    const ep = cfg.endpoint();
    const req = https.request({
      hostname: ep.hostname,
      port: ep.port,
      path: cfg.apiPath('/v1/messages'),
      method: 'POST',
      headers: { ...cfg.headers(apiKey), 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch (e) { reject(e); }
      });
    });
    req.setTimeout(PROVIDER_TIMEOUT_MS, () => { req.destroy(); reject(new Error('AI provider timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function waitForProceed() {
  return new Promise((resolve) => {
    const onMessage = (m) => {
      if (!m || m.type !== 'proceed') return;
      parentPort.off('message', onMessage);
      resolve(Boolean(m.ok));
    };
    parentPort.on('message', onMessage);
  });
}

function emptyCost(model, depth, priced, priceNote, capUsd) {
  return {
    tokensIn: 0, tokensOut: 0, usdEstimated: priced ? 0 : null, model, depth, calls: 0,
    priced, priceNote, knownPrice: null, exact: true,
    capUsd, capEnforced: priced && capUsd !== null, aborted: false, abortReason: null,
  };
}

async function runFix() {
  const {
    entry, file, issues, apiKey, depth: rawDepth, maxUsd, maxAttempts,
    autoProceed, transportPath, eventsPath, recipePath,
  } = workerData || {};
  if (!entry || !file) throw new Error('engine-worker: entry and file are required for mode "fix"');
  if (!Array.isArray(issues) || issues.length === 0) throw new Error('engine-worker: at least one issue is required for mode "fix"');

  const bridge = require('./engine-bridge.js');
  const resolved = bridge.entryFromPath(entry);
  if (!resolved) throw new Error('engine-worker: entry is not inside an @gatetest/cli package');
  const { packageDir, version } = resolved;

  const orchestrator = bridge.loadEngineModule(packageDir, 'cli-fix-orchestrator.js');
  if (!orchestrator || typeof orchestrator.runFixOrchestration !== 'function') {
    throw new Error(`engine ${version} has no fix orchestrator (src/core/cli-fix-orchestrator.js) — upgrade @gatetest/cli`);
  }
  const choice = bridge.resolveFixDepth(packageDir, rawDepth);
  if (!choice.ok) throw new Error(choice.error);
  const model = choice.model;
  const depth = choice.depth;

  const budget = bridge.loadEngineModule(packageDir, 'budget-tracker.js');
  const priced = Boolean(budget && typeof budget.BudgetTracker === 'function');
  const priceNote = priced ? null : `engine ${version} has no price table — upgrade @gatetest/cli to see USD`;
  const cap = typeof maxUsd === 'number' && Number.isFinite(maxUsd) && maxUsd > 0 ? maxUsd : null;

  const original = fs.readFileSync(file, 'utf8');
  const estimate = bridge.estimateBeforeFix({ packageDir, model, fileText: original, engineVersion: version });
  post({ type: 'estimate', estimate, depth, model, maxUsd: cap, engineVersion: version, priced, priceNote });

  const done = (fix) => post({ type: 'done', fix: { proposed: null, changed: false, testsRun: false, ...fix } });

  if (!autoProceed && !(await waitForProceed())) {
    done({ fixed: false, reason: 'declined', cost: emptyCost(model, depth, priced, priceNote, cap) });
    return;
  }
  if (!apiKey) {
    done({ fixed: false, reason: 'no-api-key', cost: emptyCost(model, depth, priced, priceNote, cap) });
    return;
  }

  // The request shape the engine sends; FIX_CALL_SHAPE is exported from the
  // orchestrator since 1.61.1 — older engines used the same 8192 max_tokens.
  const maxOutputTokens = (orchestrator.FIX_CALL_SHAPE && orchestrator.FIX_CALL_SHAPE.maxOutputTokens) || 8192;
  const transport = transportPath ? require(transportPath).callProvider : httpsTransport(bridge, packageDir, version);
  const tracker = priced ? new budget.BudgetTracker({ maxUsd: cap === null ? Infinity : cap, label: 'editor-fix' }) : null;
  const totals = { tokensIn: 0, tokensOut: 0, calls: 0, exact: true };

  const callProvider = async (key, system, user, callModel) => {
    // Cap check BEFORE the call: once a prior call crossed the cap this
    // throws BUDGET_EXCEEDED and the orchestrator returns ai-provider-error.
    if (tracker) tracker.preflight();
    totals.calls += 1;
    post({ type: 'progress', event: 'fix:call', payload: { call: totals.calls, model: callModel } });
    const body = JSON.stringify({ model: callModel, max_tokens: maxOutputTokens, system, messages: [{ role: 'user', content: user }] });
    const res = await transport({ apiKey: key, body, model: callModel });
    const data = res && res.data;
    if (data && data.error) throw new Error(data.error.message || 'provider error');

    let callIn = 0;
    let callOut = 0;
    if (tracker) {
      const r = tracker.record(body, { data }, callModel);
      callIn = r.inputTokens; callOut = r.outputTokens;
      if (!r.exact) totals.exact = false;
    } else if (data && data.usage && typeof data.usage.output_tokens === 'number') {
      callIn = data.usage.input_tokens || 0; callOut = data.usage.output_tokens;
      if (typeof data.usage.input_tokens !== 'number') totals.exact = false;
    } else {
      totals.exact = false; // no usage and no price table: nothing honest to count
    }
    totals.tokensIn += callIn;
    totals.tokensOut += callOut;
    post({
      type: 'progress', event: 'fix:usage',
      payload: { call: totals.calls, tokensIn: totals.tokensIn, tokensOut: totals.tokensOut, usdEstimated: tracker ? tracker.estimatedUsd() : null },
    });
    const content = data && data.content;
    return (Array.isArray(content) && content[0] && content[0].text) || '';
  };

  // Temporary copy: the orchestrator writes its winner to `filePath` and
  // swaps candidates in for test runs. projectRoot is the temp dir so it
  // discovers no test file — a test found next to the REAL file would import
  // the real source, not the candidate, and its verdict would be noise.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-editor-fix-'));
  const tmpFile = path.join(tmpDir, path.basename(file));
  let result;
  let proposed = null;
  try {
    fs.writeFileSync(tmpFile, original, 'utf8');
    result = await orchestrator.runFixOrchestration({
      filePath: tmpFile,
      issues,
      projectRoot: tmpDir,
      apiKey,
      model,
      maxAttempts: typeof maxAttempts === 'number' && maxAttempts > 0 ? maxAttempts : undefined,
      eventsPath: eventsPath || undefined,
      recipePath: recipePath || undefined,
      _callClaude: callProvider,
    });
    if (result && result.fixed) proposed = fs.readFileSync(tmpFile, 'utf8');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* error-ok — temp dir; best effort */ }
  }

  const snap = tracker ? tracker.snapshot() : null;
  done({
    fixed: Boolean(result && result.fixed),
    reason: (result && result.reason) || null,
    hypothesis: (result && result.hypothesis) || null,
    rank: result && result.rank !== undefined ? result.rank : null,
    attempt: result && result.attempt !== undefined ? result.attempt : null,
    lineDelta: result && result.lineDelta !== undefined ? result.lineDelta : null,
    advisory: (result && result.advisory) || null,
    playback: Boolean(result && result.playback),
    proposed,
    changed: proposed !== null && proposed !== original,
    testsRun: false,
    testsNote: 'tests were not run — the fix ran against a temporary copy; the re-scan after Apply is the verification',
    cost: {
      tokensIn: totals.tokensIn,
      tokensOut: totals.tokensOut,
      usdEstimated: snap ? snap.estimatedUsd : null,
      model,
      depth,
      calls: totals.calls,
      priced,
      priceNote,
      knownPrice: priced && typeof budget.hasKnownPrice === 'function' ? budget.hasKnownPrice(model) : null,
      exact: totals.exact,
      capUsd: cap,
      capEnforced: priced && cap !== null,
      aborted: snap ? snap.aborted : false,
      abortReason: snap ? snap.abortReason : null,
    },
  });
}

async function main() {
  if (workerData && workerData.mode === 'fix') return runFix();
  return runScan();
}

main().catch((err) => {
  post({ type: 'error', message: (err && err.message) || String(err), stack: err && err.stack });
});
