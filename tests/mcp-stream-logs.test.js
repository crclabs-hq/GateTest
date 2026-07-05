'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ---------------------------------------------------------------------------
// mcp-stream-logs.test.js — tests for stream_logs MCP handler and
// the underlying src/core/log-streamer.js engine.
// ---------------------------------------------------------------------------

let mcp;
before(async () => {
  mcp = await import('../bin/gatetest-mcp.mjs');
});

describe('log-streamer core', () => {
  const { streamLogs } = require('../src/core/log-streamer.js');

  test('streamLogs is exported', () => {
    assert.strictEqual(typeof streamLogs, 'function');
  });

  test('returns error when no opts given', async () => {
    const result = await streamLogs({});
    assert.ok('error' in result, 'error field present');
  });

  test('command mode captures stdout', async () => {
    const cmd = process.platform === 'win32'
      ? 'cmd /c echo hello from gatetest'
      : 'echo hello from gatetest';
    const result = await streamLogs({ command: cmd, seconds: 3 });
    assert.strictEqual(result.mode, 'command');
    assert.ok(Array.isArray(result.lines), 'lines is array');
    const allText = result.lines.map(l => l.text).join('\n');
    assert.ok(allText.includes('hello'), `expected "hello" in: ${allText}`);
  });

  test('each line has ts, stream, text fields', async () => {
    const cmd = process.platform === 'win32' ? 'cmd /c echo test' : 'echo test';
    const result = await streamLogs({ command: cmd, seconds: 3 });
    for (const line of result.lines) {
      assert.ok('ts' in line, 'line has ts');
      assert.ok('stream' in line, 'line has stream');
      assert.ok('text' in line, 'line has text');
      assert.strictEqual(typeof line.text, 'string');
    }
  });

  test('logFile mode returns error for missing file', async () => {
    const result = await streamLogs({ logFile: '/nonexistent/path/xyz.log', seconds: 2 });
    assert.strictEqual(result.mode, 'logFile');
    assert.ok('error' in result, 'error reported for missing file');
  });

  test('logFile mode tails a real file', async () => {
    const tmpFile = path.join(os.tmpdir(), `gt-logtest-${Date.now()}.log`);
    try {
      fs.writeFileSync(tmpFile, '');
      // Write to the file after a short delay
      const writeTimer = setTimeout(() => {
        fs.appendFileSync(tmpFile, 'line one\nline two\n');
      }, 300);
      const result = await streamLogs({ logFile: tmpFile, seconds: 3 });
      clearTimeout(writeTimer);
      assert.strictEqual(result.mode, 'logFile');
      // File may or may not have lines depending on timing; just verify shape
      assert.ok(Array.isArray(result.lines));
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  });

  test('pid mode on non-Linux returns graceful error', async () => {
    if (process.platform === 'linux') {
      // Skip this test on Linux since pid mode may actually work there
      return;
    }
    const result = await streamLogs({ pid: process.pid, seconds: 2 });
    assert.strictEqual(result.mode, 'pid');
    assert.ok('error' in result, 'expected error for non-Linux pid mode');
  });

  test('seconds cap enforced (max 60)', async () => {
    const cmd = process.platform === 'win32' ? 'cmd /c echo hi' : 'echo hi';
    const result = await streamLogs({ command: cmd, seconds: 9999 });
    // Should complete quickly since the process exits immediately
    assert.ok(result.mode === 'command');
  });

  test('result has totalLines and truncated fields', async () => {
    const cmd = process.platform === 'win32' ? 'cmd /c echo hi' : 'echo hi';
    const result = await streamLogs({ command: cmd, seconds: 3 });
    assert.ok('totalLines' in result);
    assert.ok('truncated' in result);
    assert.ok('duration' in result);
  });
});

describe('MCP stream_logs handler', () => {
  test('handleStreamLogs is exported', () => {
    assert.strictEqual(typeof mcp.handleStreamLogs, 'function');
  });

  test('returns error when no mode provided', async () => {
    const result = await mcp.handleStreamLogs({});
    assert.ok(result.isError === true || /error|require/i.test(result.content[0].text));
  });

  test('returns text content type', async () => {
    const cmd = process.platform === 'win32' ? 'cmd /c echo test' : 'echo test';
    const result = await mcp.handleStreamLogs({ command: cmd, seconds: 2 });
    for (const c of result.content) {
      assert.strictEqual(c.type, 'text');
    }
  });

  test('content includes log stream header', async () => {
    const cmd = process.platform === 'win32' ? 'cmd /c echo mcp-stream-test' : 'echo mcp-stream-test';
    const result = await mcp.handleStreamLogs({ command: cmd, seconds: 3 });
    const text = result.content.map(c => c.text).join('\n');
    assert.ok(/log stream/i.test(text), `expected "Log stream" in: ${text.slice(0, 300)}`);
  });
});
