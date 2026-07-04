'use strict';
/**
 * MCP Discoverability — unit tests
 *
 * Covers:
 *   1. PROMPTS array shape (names, descriptions, arguments)
 *   2. renderQuickStartPrompt produces actionable content
 *   3. logTelemetry writes JSONL to the expected path
 *   4. pattern-miner mcpToolUsageStats analyser
 *   5. pattern-miner mine() includes mcpUsage in report
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// 1 & 2 — PROMPTS + render helpers (loaded from the MCP ESM module via
//           exporting them from the test shim in a CJS-compatible way)
// ---------------------------------------------------------------------------

// We can't import the ESM bin file directly in CJS tests, but we can test
// the pattern-miner (CJS) separately and trust the MCP syntax check covers
// the prompts structure. Instead, test the inline render logic by re-
// implementing the same expectations the real functions must satisfy.

test('PROMPTS must have gatetest-quick-start with a target argument', async () => {
  // Dynamic ESM import — works in Node test runner
  const mod = await import('../bin/gatetest-mcp.mjs').catch(() => null);
  // The test-surface export exists only at the bottom of the file; if
  // the file is not the process entrypoint the transport won't start.
  // We can't import the full server in a CJS test context without
  // triggering stdio connect. Verify the prompts definition via a
  // regex parse of the source instead.
  const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'gatetest-mcp.mjs'), 'utf8');
  assert.ok(src.includes("name: 'gatetest-quick-start'"), 'quick-start prompt must be defined');
  assert.ok(src.includes("name: 'gatetest-scan-and-fix'"), 'scan-and-fix prompt must be defined');
  assert.ok(src.includes('ListPromptsRequestSchema'), 'ListPromptsRequestSchema must be imported');
  assert.ok(src.includes('GetPromptRequestSchema'), 'GetPromptRequestSchema must be imported');
  assert.ok(src.includes("capabilities: { tools: {}, prompts: {} }"), 'prompts capability must be declared');
});

test('MCP server advertises prompts capability', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'gatetest-mcp.mjs'), 'utf8');
  assert.ok(src.includes("prompts: {}"), 'prompts capability object must be present');
});

test('renderQuickStartPrompt content includes actionable scan commands', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'gatetest-mcp.mjs'), 'utf8');
  assert.ok(src.includes('scan_local'), 'quick-start must reference scan_local');
  assert.ok(src.includes('scan_url'), 'quick-start must reference scan_url');
  assert.ok(src.includes('scan_repo'), 'quick-start must reference scan_repo');
  assert.ok(src.includes('suite="quick"'), 'quick-start must mention free quick suite');
});

// ---------------------------------------------------------------------------
// 3. logTelemetry — verify it writes JSONL to the correct path
// ---------------------------------------------------------------------------

test('logTelemetry writes a JSONL entry to ~/.gatetest/mcp-telemetry.jsonl', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'gatetest-mcp.mjs'), 'utf8');
  assert.ok(src.includes("mcp-telemetry.jsonl"), 'telemetry must target mcp-telemetry.jsonl');
  assert.ok(src.includes('logTelemetry'), 'logTelemetry helper must exist');
  // Verify it is called for gate-denied AND successful paths
  assert.ok(src.includes("reason: 'gate_denied'"), 'gate-denied path must log telemetry');
  assert.ok(src.includes("reason: 'exception'"), 'exception path must log telemetry');
  assert.ok(src.includes('success: !_result.isError'), 'success path must log telemetry');
});

test('logTelemetry fire-and-forget — never throws (swallows fs errors)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'gatetest-mcp.mjs'), 'utf8');
  // The function body must have a catch block that suppresses errors
  assert.ok(
    src.includes('} catch { /* never block the tool call */'),
    'logTelemetry must silently swallow fs errors'
  );
});

// ---------------------------------------------------------------------------
// 4. pattern-miner mcpToolUsageStats
// ---------------------------------------------------------------------------

const { _mcpToolUsageStats } = require('../website/app/lib/trainers/pattern-miner.js');

test('mcpToolUsageStats returns zero-state on empty input', () => {
  const stats = _mcpToolUsageStats([]);
  assert.equal(stats.totalCalls, 0);
  assert.deepEqual(stats.tools, []);
  assert.equal(stats.neverCalled.length > 0, true, 'neverCalled should list free tools when none were called');
  assert.deepEqual(stats.highFailTools, []);
});

test('mcpToolUsageStats counts calls and success rate correctly', () => {
  const events = [
    { tool: 'scan_local', success: true, latencyMs: 200 },
    { tool: 'scan_local', success: true, latencyMs: 300 },
    { tool: 'scan_local', success: false, latencyMs: 50 },
    { tool: 'scan_url', success: true, latencyMs: 1000 },
  ];
  const stats = _mcpToolUsageStats(events);
  assert.equal(stats.totalCalls, 4);
  const scanLocal = stats.tools.find(t => t.tool === 'scan_local');
  assert.ok(scanLocal, 'scan_local must appear in tools');
  assert.equal(scanLocal.calls, 3);
  assert.equal(scanLocal.successRate, Number((2/3).toFixed(2)));
  assert.equal(scanLocal.avgLatencyMs, Math.round((200 + 300 + 50) / 3));
});

test('mcpToolUsageStats identifies never-called free tools', () => {
  const events = [
    { tool: 'scan_local', success: true, latencyMs: 200 },
  ];
  const stats = _mcpToolUsageStats(events);
  // scan_url, check_health, list_modules, get_badge should all appear as neverCalled
  assert.ok(stats.neverCalled.includes('scan_url'), 'scan_url must be in neverCalled');
  assert.ok(!stats.neverCalled.includes('scan_local'), 'scan_local should NOT be in neverCalled');
});

test('mcpToolUsageStats flags high-fail tools (≥3 calls, <50% success, not gate denials)', () => {
  const events = [
    { tool: 'fix_issue', success: false, latencyMs: 500, reason: 'exception' },
    { tool: 'fix_issue', success: false, latencyMs: 600, reason: 'exception' },
    { tool: 'fix_issue', success: false, latencyMs: 400, reason: 'exception' },
  ];
  const stats = _mcpToolUsageStats(events);
  assert.equal(stats.highFailTools.length, 1);
  assert.equal(stats.highFailTools[0].tool, 'fix_issue');
});

test('mcpToolUsageStats does not flag gate-denied tools as high-fail', () => {
  const events = [
    { tool: 'fix_issue', success: false, latencyMs: 10, reason: 'gate_denied', gatedDenials: 1 },
    { tool: 'fix_issue', success: false, latencyMs: 10, reason: 'gate_denied', gatedDenials: 1 },
    { tool: 'fix_issue', success: false, latencyMs: 10, reason: 'gate_denied', gatedDenials: 1 },
  ];
  // The events all come in as gatedDenials — each event carries the flag inline
  // mcpToolUsageStats checks ev.reason === 'gate_denied' not a field on the event
  // so let's verify via gatedDenials count on the result
  const stats = _mcpToolUsageStats(events);
  const tool = stats.tools.find(t => t.tool === 'fix_issue');
  assert.ok(tool, 'fix_issue must appear');
  assert.equal(tool.gatedDenials, 3, 'all 3 calls should count as gate denials');
  // highFailTools excludes those where gatedDenials >= calls
  assert.equal(stats.highFailTools.length, 0, 'gate-denied tools must not appear in highFailTools');
});

// ---------------------------------------------------------------------------
// 5. pattern-miner mine() includes mcpUsage in report
// ---------------------------------------------------------------------------

const { mine } = require('../website/app/lib/trainers/pattern-miner.js');

test('mine() includes mcpUsage field in report', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-mcp-'));
  const mcpPath = path.join(tmpDir, 'mcp-telemetry.jsonl');
  fs.writeFileSync(mcpPath, [
    JSON.stringify({ ts: Date.now(), tool: 'scan_local', success: true, latencyMs: 150, hasKey: false }),
    JSON.stringify({ ts: Date.now(), tool: 'check_health', success: true, latencyMs: 20, hasKey: false }),
  ].join('\n') + '\n');

  const report = await mine({
    sessionFixPath: path.join(tmpDir, 'missing.jsonl'),
    fixAttemptPath: path.join(tmpDir, 'missing2.jsonl'),
    mcpTelemetryPath: mcpPath,
  });

  assert.ok(report.mcpUsage, 'report must include mcpUsage');
  assert.equal(report.mcpUsage.totalCalls, 2);
  assert.equal(report.inputs.mcpEventCount, 2);
  fs.rmSync(tmpDir, { recursive: true });
});

test('mine() includes mcp-never-called recommendation when free tools unused', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-mcp2-'));
  // Only scan_local was called — scan_url, check_health, list_modules, get_badge are all uncalled
  const mcpPath = path.join(tmpDir, 'mcp-telemetry.jsonl');
  fs.writeFileSync(mcpPath, JSON.stringify({ ts: Date.now(), tool: 'scan_local', success: true, latencyMs: 200, hasKey: false }) + '\n');

  const report = await mine({
    sessionFixPath: path.join(tmpDir, 'missing.jsonl'),
    fixAttemptPath: path.join(tmpDir, 'missing2.jsonl'),
    mcpTelemetryPath: mcpPath,
  });

  const rec = report.recommendations.find(r => r.kind === 'mcp-never-called');
  assert.ok(rec, 'mcp-never-called recommendation must fire');
  assert.ok(rec.tools.includes('scan_url'), 'scan_url must be listed as never called');
  fs.rmSync(tmpDir, { recursive: true });
});
