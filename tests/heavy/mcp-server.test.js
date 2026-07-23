// =============================================================================
// MCP SERVER TEST — bin/gatetest-mcp.mjs
// =============================================================================
// Validates the MCP server via JSON-RPC over a spawned child process.
// We spawn the server and pipe messages in/out exactly as an MCP client
// would. Tests cover: tools/list, tools/call for all four tools, error
// handling for bad inputs, and silent mode (no stdout leakage from engine).
// =============================================================================

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');

// Skip all tests immediately (no 60s timeouts) when the MCP SDK isn't installed.
// In CI the SDK is present; locally it may not be. `describe.skip` registers
// the suite as skipped synchronously so the runner never waits for child
// processes that would fail to start.
// NOTE: resolve a real subpath, not the bare package name — the SDK's
// package.json exports map has no "." entry, so the bare resolve ALWAYS
// failed and this suite was silently skipped everywhere (local + CI) even
// with the SDK fully installed. That silent skip hid stale assertions for
// months (e.g. "exactly 9 tools" while the server shipped 13).
let hasSDK = false;
try { require.resolve('@modelcontextprotocol/sdk/server/index.js'); hasSDK = true; } catch { /* not installed */ }
const describeOrSkip = hasSDK ? describe : describe.skip;

// Gated tools (run_module, verify_fix, …) require a valid $29/mo GATETEST_API_KEY.
// Without one the payment gate correctly returns the subscription-required message
// instead of running the tool, so these subprocess tests can only run where a key
// is present (CI sets it as a secret). Skip locally rather than assert on the gate.
const hasMcpKey = !!process.env.GATETEST_API_KEY;
const describeOrSkipGated = (hasSDK && hasMcpKey) ? describe : describe.skip;

const SERVER_PATH = path.resolve(__dirname, '../..', 'bin', 'gatetest-mcp.mjs');
// Test target: full repo for tools/list etc., tiny corpus dir for actual
// scans. Scanning the full repo (~4900 tests + 100+ modules) takes ~48s
// in isolation and times out under parallel-test load. We only need
// "does the scan_local tool work end-to-end?" — a minimal target proves
// that in <2s and is deterministic across machines.
const SCAN_PATH   = path.resolve(__dirname, '../..');   // GateTest repo root
const TINY_SCAN_PATH = path.resolve(__dirname, '../..', 'reliability-corpus', 'known-good', 'empty-js-module');

// ---------------------------------------------------------------------------
// Helper: send one JSON-RPC request, collect the response line
// ---------------------------------------------------------------------------

// Per-call timeout. 20s was originally chosen for solo runs; under the full
// 1142-test sweep the very first cold-spawn (Node startup + 90-module
// registry load + JSON-RPC roundtrip) regularly lands at 18-22s on a loaded
// runner, intermittently tripping the timeout and producing a flaky "tools/list"
// failure that vanishes on rerun. 60s gives 3x headroom on cold start while
// still bounding a genuinely-stuck server. Sweep duration impact is zero
// because successful calls return in 1-3s and the timeout only matters when
// the server is broken.
function callMcp(method, params = {}, timeoutMs = 60000, envOverride = null) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: envOverride || process.env,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        reject(new Error(`MCP call timed out after ${timeoutMs}ms: ${method}`));
      }
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      // The server writes one JSON object per line.
      const lines = stdout.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            proc.kill();
            resolve(parsed);
          }
        } catch {
          // incomplete line — wait for more
        }
      }
    });

    proc.stderr.on('data', (c) => { stderr += c.toString(); });

    proc.on('error', (err) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(err); }
    });

    const id = Math.floor(Math.random() * 100000);
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    proc.stdin.write(msg);
    proc.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

describeOrSkip('MCP server — tools/list', () => {
  it('returns exactly 24 tools (drift tripwire — update when adding a tool)', async () => {
    const res = await callMcp('tools/list', {});
    assert.ok(res.result, `expected result, got: ${JSON.stringify(res).slice(0, 200)}`);
    assert.ok(Array.isArray(res.result.tools), 'tools should be an array');
    assert.strictEqual(res.result.tools.length, 24);
  });

  it('includes every declared tool', async () => {
    const res = await callMcp('tools/list', {});
    const names = res.result.tools.map(t => t.name);
    const expected = [
      // Original 4
      'scan_local', 'run_module', 'list_modules', 'check_health',
      // Autopilot push
      'fix_issue', 'compose_pr', 'explain_finding', 'audit_log', 'compare_repos',
      // Hosted-API family
      'scan_url', 'scan_repo', 'get_badge', 'get_report',
      // Eyes/ears/hands build
      'verify_fix', 'capture_screenshot', 'get_visual_diff',
      'run_live_checks', 'get_production_errors',
      // Root-cause build (source-map trace resolution + git regression blame)
      'resolve_stack_trace', 'blame_regression',
      // v1.57.0 Hands debug tools — definitions/dispatcher restored 2026-07-11
      // after being found missing from TOOLS (handlers existed, tools were
      // invisible to every MCP client while the $29/mo page sold them)
      'run_tests', 'stream_logs', 'query_db', 'http_request',
    ];
    for (const name of expected) {
      assert.ok(names.includes(name), `missing ${name}`);
    }
  });

  it('each tool has name, description, and inputSchema', async () => {
    const res = await callMcp('tools/list', {});
    for (const tool of res.result.tools) {
      assert.ok(tool.name,        `tool missing name: ${JSON.stringify(tool)}`);
      assert.ok(tool.description, `tool missing description: ${tool.name}`);
      assert.ok(tool.inputSchema, `tool missing inputSchema: ${tool.name}`);
    }
  });
});

// ---------------------------------------------------------------------------
// check_health
// ---------------------------------------------------------------------------

describeOrSkip('MCP server — check_health', () => {
  it('returns operational status with module count', async () => {
    const res = await callMcp('tools/call', { name: 'check_health', arguments: {} });
    assert.ok(res.result, `expected result: ${JSON.stringify(res).slice(0, 200)}`);
    const text = res.result.content[0].text;
    assert.ok(text.includes('Operational') || text.includes('✅'), `expected operational: ${text.slice(0, 200)}`);
    assert.ok(/\d{2,3}/.test(text), `expected module count in health output: ${text}`);
  });

  it('returns content array with at least one text item', async () => {
    const res = await callMcp('tools/call', { name: 'check_health', arguments: {} });
    assert.ok(Array.isArray(res.result.content), 'content should be array');
    assert.ok(res.result.content.length > 0, 'content should be non-empty');
    assert.strictEqual(res.result.content[0].type, 'text');
  });
});

// ---------------------------------------------------------------------------
// list_modules
// ---------------------------------------------------------------------------

describeOrSkip('MCP server — list_modules', () => {
  it('returns a list containing modules', async () => {
    const res = await callMcp('tools/call', { name: 'list_modules', arguments: {} });
    const text = res.result.content[0].text;
    assert.ok(/\d{2,3}/.test(text), `expected module count in list output: ${text.slice(0, 200)}`);
  });

  it('includes well-known module names in the output', async () => {
    const res = await callMcp('tools/call', { name: 'list_modules', arguments: {} });
    const text = res.result.content[0].text;
    assert.ok(text.includes('secrets'), `expected "secrets" module`);
    assert.ok(text.includes('tlsSecurity'), `expected "tlsSecurity" module`);
    assert.ok(text.includes('importCycle'), `expected "importCycle" module`);
  });
});

// ---------------------------------------------------------------------------
// run_module
// ---------------------------------------------------------------------------

describeOrSkipGated('MCP server — run_module', () => {
  it('runs the syntax module and returns a formatted result', async () => {
    const res = await callMcp(
      'tools/call',
      { name: 'run_module', arguments: { module: 'syntax', path: SCAN_PATH } },
      30000
    );
    assert.ok(res.result, `expected result: ${JSON.stringify(res).slice(0, 200)}`);
    const text = res.result.content[0].text;
    assert.ok(text.includes('GateTest Scan'), `expected GateTest header: ${text.slice(0, 200)}`);
  });

  it('returns an error result for an unknown module', async () => {
    const res = await callMcp(
      'tools/call',
      { name: 'run_module', arguments: { module: 'nonExistentModule999', path: SCAN_PATH } },
      15000
    );
    const text = res.result.content[0].text;
    // Could be an error message or an empty/failed result — either is acceptable
    assert.ok(typeof text === 'string' && text.length > 0, 'should return some text');
  });

  it('returns isError for missing required arguments', async () => {
    const res = await callMcp(
      'tools/call',
      { name: 'run_module', arguments: { module: 'syntax' } }, // missing path
      10000
    );
    const text = res.result.content[0].text;
    assert.ok(
      res.result.isError === true || text.toLowerCase().includes('error') || text.toLowerCase().includes('required'),
      `expected error indication: ${text}`
    );
  });
});

// ---------------------------------------------------------------------------
// scan_local
// ---------------------------------------------------------------------------

describeOrSkip('MCP server — scan_local', () => {
  it('runs a quick scan and returns structured results', async () => {
    const res = await callMcp(
      'tools/call',
      { name: 'scan_local', arguments: { path: TINY_SCAN_PATH, suite: 'quick' } },
      30000
    );
    assert.ok(res.result, `expected result: ${JSON.stringify(res).slice(0, 200)}`);
    const text = res.result.content[0].text;
    assert.ok(text.includes('GateTest Scan'), `expected scan header`);
    assert.ok(text.includes('Duration:'), `expected duration in output`);
  });

  it('returns isError for missing path', async () => {
    // suite:'quick' keeps this call ungated so it reaches the missing-path
    // check inside handleScanLocal instead of the payment gate — an omitted
    // suite now defaults to 'standard' and is gated (see mcp-payment-gate.test.js).
    const res = await callMcp(
      'tools/call',
      { name: 'scan_local', arguments: { suite: 'quick' } },
      10000
    );
    assert.ok(
      res.result.isError === true || res.result.content[0].text.toLowerCase().includes('error'),
      'should flag missing path as error'
    );
  });

  // INVERTED 2026-07-23 (KI #39 resolved, Craig-authorized): the local
  // stdio server is 100% free — no suite or modules-array combination may
  // be gated. These two tests now pin the FREE policy.
  it('does NOT gate a call with no suite arg (local tools are free)', async () => {
    const noKeyEnv = { ...process.env };
    delete noKeyEnv.GATETEST_API_KEY;
    const res = await callMcp(
      'tools/call',
      { name: 'scan_local', arguments: { path: TINY_SCAN_PATH } },
      10000,
      noKeyEnv
    );
    assert.ok(!res.result.content[0].text.includes('🔒'), 'local scan_local must be free for any suite (KI #39)');
  });

  it('does NOT gate an explicit modules array without a key (local tools are free)', async () => {
    const noKeyEnv = { ...process.env };
    delete noKeyEnv.GATETEST_API_KEY;
    const res = await callMcp(
      'tools/call',
      { name: 'scan_local', arguments: { path: TINY_SCAN_PATH, modules: ['memory', 'syntax'] } },
      10000,
      noKeyEnv
    );
    assert.ok(!res.result.content[0].text.includes('🔒'), 'modules array must be free on the local server (KI #39)');
  });
});

// ---------------------------------------------------------------------------
// verify_fix — spawn smoke (full contract coverage lives in mcp-verify-fix.test.js)
// ---------------------------------------------------------------------------

describeOrSkipGated('MCP server — verify_fix', () => {
  it('returns a verdict line for an explicit files list', async () => {
    const res = await callMcp(
      'tools/call',
      { name: 'verify_fix', arguments: { path: TINY_SCAN_PATH, files: ['index.js'] } },
      60000
    );
    assert.ok(res.result, `expected result: ${JSON.stringify(res).slice(0, 200)}`);
    const text = res.result.content[0].text;
    assert.ok(
      /FIX VERIFIED|NOT VERIFIED/.test(text),
      `expected a verdict line, got: ${text.slice(0, 200)}`
    );
    assert.ok(text.includes('Project-wide:'), 'expected project-wide delta line');
  });
});

// ---------------------------------------------------------------------------
// Silent mode — engine must not write to stdout during MCP calls
// ---------------------------------------------------------------------------

describeOrSkip('MCP server — silent mode', () => {
  it('does not leak engine console output to stdout (clean JSON-RPC)', async () => {
    const proc = spawn(process.execPath, [SERVER_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';

    proc.stdout.on('data', (c) => { stdout += c.toString(); });

    await new Promise((resolve) => {
      const id = 99;
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'check_health', arguments: {} } }) + '\n');
      proc.stdin.end();

      setTimeout(() => { proc.kill(); resolve(); }, 5000);
      proc.stdout.once('data', () => setTimeout(() => { proc.kill(); resolve(); }, 500));
    });

    // Every line must be valid JSON — no ANSI escape codes or plain text from ConsoleReporter
    const lines = stdout.split('\n').filter(l => l.trim());
    assert.ok(lines.length > 0, 'should have received at least one line');
    for (const line of lines) {
      try {
        JSON.parse(line);
      } catch {
        assert.fail(`Non-JSON line leaked to stdout (engine output contamination): ${line.slice(0, 100)}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Unknown tool name
// ---------------------------------------------------------------------------

describeOrSkip('MCP server — unknown tool', () => {
  it('returns an error for an unknown tool name', async () => {
    const res = await callMcp(
      'tools/call',
      { name: 'not_a_real_tool', arguments: {} },
      10000
    );
    const text = res.result.content[0].text;
    assert.ok(
      res.result.isError === true || text.toLowerCase().includes('unknown'),
      `expected unknown-tool error: ${text}`
    );
  });
});
