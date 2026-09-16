'use strict';
/**
 * engine-worker.js — runs one GateTest scan in a worker thread.
 *
 * Why a worker and not the extension host thread: the engine is CPU-bound
 * in places (AST walks over the whole workspace) and a scan of a large repo
 * would freeze the editor for its whole duration. A worker keeps the UI
 * responsive and gives the extension a real cancel: `worker.terminate()`.
 *
 * Why not a child process: that is the old CLI-spawn design this replaces.
 * Same Node, same process, no PATH lookup, no shell quoting, no EINVAL.
 *
 * Protocol (parentPort):
 *   in : workerData = { entry, root, suite, changedFiles?, skipModules? }
 *   out: { type: 'progress', event, payload }   module:start / module:end …
 *        { type: 'log', level, text }           anything modules console.log
 *        { type: 'done', summary }              pruned runner summary
 *        { type: 'error', message, stack }
 */

const { parentPort, workerData } = require('worker_threads');

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

async function main() {
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

main().catch((err) => {
  post({ type: 'error', message: (err && err.message) || String(err), stack: err && err.stack });
});
