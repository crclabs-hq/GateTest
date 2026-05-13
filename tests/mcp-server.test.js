// ============================================================================
// MCP SERVER CONTRACT TESTS
// ============================================================================
// Validates the GateTest MCP (Model Context Protocol) stdio server against
// the protocol spec. Without these, a regression here could silently break
// every AI client integration — Claude Code, Cursor, Cline, Windsurf, etc.
//
// Tests dispatch the server in-process (not over child stdio) for speed and
// determinism. End-to-end stdio framing is exercised by the smoke test in
// the sweep.
// ============================================================================
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const server = require('../src/mcp/server');
const { BUILT_IN_MODULES } = require('../src/core/registry');

// Helper: capture the next message written by send() inside dispatch().
function captureSends(fn) {
  const captured = [];
  const origWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    captured.push(chunk.toString());
    return true;
  };
  return Promise.resolve(fn()).finally(() => {
    process.stdout.write = origWrite;
  }).then(() => captured.map((line) => JSON.parse(line.trim())));
}

describe('MCP server — protocol shape', () => {
  it('exports the expected protocol constants', () => {
    assert.strictEqual(server.SERVER_NAME, 'gatetest');
    assert.strictEqual(server.PROTOCOL_VERSION, '2024-11-05');
    assert.ok(server.SERVER_VERSION, 'server version is set from package.json');
    assert.strictEqual(typeof server.start, 'function');
    assert.strictEqual(typeof server.dispatch, 'function');
  });

  it('exposes the v1 tools with valid JSON Schema', () => {
    const names = Object.keys(server.TOOLS);
    assert.ok(names.includes('gatetest_version'));
    assert.ok(names.includes('gatetest_list_modules'));
    assert.ok(names.includes('gatetest_scan'));
    assert.ok(names.includes('gatetest_explain_check'));
    for (const [, def] of Object.entries(server.TOOLS)) {
      assert.strictEqual(def.inputSchema.type, 'object');
      assert.strictEqual(typeof def.description, 'string');
      assert.ok(def.description.length > 0);
      assert.strictEqual(typeof def.handler, 'function');
    }
  });
});

describe('MCP server — tools/call gatetest_explain_check', () => {
  it('returns an exact-match explanation for a known module + check', async () => {
    const responses = await captureSends(() =>
      server.dispatch({
        jsonrpc: '2.0',
        id: 100,
        method: 'tools/call',
        params: {
          name: 'gatetest_explain_check',
          arguments: { module: 'tlsSecurity', checkId: 'js-reject-unauthorized' },
        },
      }),
    );
    const payload = JSON.parse(responses[0].result.content[0].text);
    assert.strictEqual(payload.match, 'exact');
    assert.strictEqual(payload.explanation.module, 'tlsSecurity');
    assert.strictEqual(payload.explanation.checkId, 'js-reject-unauthorized');
    assert.ok(payload.explanation.whatItMeans.length > 0);
    assert.ok(payload.explanation.whyItMatters.length > 0);
    assert.ok(Array.isArray(payload.explanation.fixSteps));
    assert.ok(payload.explanation.fixSteps.length > 0);
    assert.match(payload.explanation.learnMore, /CWE-295/);
  });

  it('returns every entry for a module when no checkId is passed', async () => {
    const responses = await captureSends(() =>
      server.dispatch({
        jsonrpc: '2.0',
        id: 101,
        method: 'tools/call',
        params: { name: 'gatetest_explain_check', arguments: { module: 'tlsSecurity' } },
      }),
    );
    const payload = JSON.parse(responses[0].result.content[0].text);
    assert.strictEqual(payload.match, 'module');
    assert.ok(Array.isArray(payload.explanations));
    assert.ok(payload.explanations.length >= 2);
    for (const e of payload.explanations) {
      assert.strictEqual(e.module, 'tlsSecurity');
    }
  });

  it('falls back to a generic explanation when the check ID is unknown', async () => {
    const responses = await captureSends(() =>
      server.dispatch({
        jsonrpc: '2.0',
        id: 102,
        method: 'tools/call',
        params: {
          name: 'gatetest_explain_check',
          arguments: { module: 'security', checkId: 'nonexistent-rule-xyz' },
        },
      }),
    );
    const payload = JSON.parse(responses[0].result.content[0].text);
    // 'security' is a real module; it has no structured entries → generic.
    assert.strictEqual(payload.match, 'generic');
    assert.ok(payload.explanation.whatItMeans.length > 0);
  });

  it('returns isError for an unknown module name', async () => {
    const responses = await captureSends(() =>
      server.dispatch({
        jsonrpc: '2.0',
        id: 103,
        method: 'tools/call',
        params: {
          name: 'gatetest_explain_check',
          arguments: { module: 'not_a_real_module_xyz' },
        },
      }),
    );
    assert.strictEqual(responses[0].result.isError, true);
    assert.match(responses[0].result.content[0].text, /Unknown module/);
  });

  it('partial-matches when the checkId is a prefix of a registered rule', async () => {
    const responses = await captureSends(() =>
      server.dispatch({
        jsonrpc: '2.0',
        id: 104,
        method: 'tools/call',
        params: {
          name: 'gatetest_explain_check',
          // "reject-unauthorized" is a substring of "js-reject-unauthorized"
          arguments: { module: 'tlsSecurity', checkId: 'reject-unauthorized' },
        },
      }),
    );
    const payload = JSON.parse(responses[0].result.content[0].text);
    assert.strictEqual(payload.match, 'partial');
    assert.strictEqual(payload.explanation.checkId, 'js-reject-unauthorized');
  });
});

describe('MCP server — initialize handshake', () => {
  it('returns protocol version, capabilities, and server info', async () => {
    const responses = await captureSends(() =>
      server.dispatch({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {} },
      }),
    );
    assert.strictEqual(responses.length, 1);
    const res = responses[0];
    assert.strictEqual(res.jsonrpc, '2.0');
    assert.strictEqual(res.id, 1);
    assert.strictEqual(res.result.protocolVersion, '2024-11-05');
    assert.deepStrictEqual(res.result.capabilities, { tools: {} });
    assert.strictEqual(res.result.serverInfo.name, 'gatetest');
    assert.ok(res.result.serverInfo.version);
  });
});

describe('MCP server — tools/list', () => {
  it('returns every registered tool with description and inputSchema', async () => {
    const responses = await captureSends(() =>
      server.dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    );
    assert.strictEqual(responses.length, 1);
    const { tools } = responses[0].result;
    assert.strictEqual(tools.length, Object.keys(server.TOOLS).length);
    for (const t of tools) {
      assert.strictEqual(typeof t.name, 'string');
      assert.strictEqual(typeof t.description, 'string');
      assert.strictEqual(t.inputSchema.type, 'object');
    }
  });
});

describe('MCP server — tools/call gatetest_version', () => {
  it('returns module count matching the registry', async () => {
    const responses = await captureSends(() =>
      server.dispatch({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'gatetest_version', arguments: {} },
      }),
    );
    const res = responses[0].result;
    assert.ok(Array.isArray(res.content));
    const payload = JSON.parse(res.content[0].text);
    assert.strictEqual(payload.name, 'gatetest');
    assert.strictEqual(payload.protocolVersion, '2024-11-05');
    assert.strictEqual(payload.moduleCount, Object.keys(BUILT_IN_MODULES).length);
    assert.ok(payload.modules.includes('security'));
  });
});

describe('MCP server — tools/call gatetest_list_modules', () => {
  it('returns every module with name and description', async () => {
    const responses = await captureSends(() =>
      server.dispatch({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'gatetest_list_modules', arguments: {} },
      }),
    );
    const payload = JSON.parse(responses[0].result.content[0].text);
    assert.strictEqual(payload.total, payload.modules.length);
    assert.ok(payload.total > 0);
    const security = payload.modules.find((m) => m.name === 'security');
    assert.ok(security, 'security module is present');
    assert.ok(security.description.length > 0);
  });
});

describe('MCP server — tools/call gatetest_scan', () => {
  it('runs the syntax module on an empty tmpdir and returns a summary', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-mcp-test-'));
    try {
      const responses = await captureSends(() =>
        server.dispatch({
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: {
            name: 'gatetest_scan',
            arguments: { projectRoot: tmp, modules: ['syntax'] },
          },
        }),
      );
      const payload = JSON.parse(responses[0].result.content[0].text);
      assert.ok(['PASSED', 'BLOCKED'].includes(payload.gateStatus));
      assert.strictEqual(payload.modules.total, 1);
      assert.ok(Array.isArray(payload.results));
      // Server must not have set process.exitCode even if scan was BLOCKED —
      // long-lived server mode must never poison the parent process.
      assert.strictEqual(process.exitCode, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects passing both suite and modules', async () => {
    const responses = await captureSends(() =>
      server.dispatch({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'gatetest_scan',
          arguments: { suite: 'quick', modules: ['syntax'] },
        },
      }),
    );
    const res = responses[0].result;
    assert.strictEqual(res.isError, true);
    assert.match(res.content[0].text, /Tool error/);
  });

  it('rejects nonexistent projectRoot', async () => {
    const responses = await captureSends(() =>
      server.dispatch({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'gatetest_scan',
          arguments: { projectRoot: '/this/path/does/not/exist/anywhere' },
        },
      }),
    );
    const res = responses[0].result;
    assert.strictEqual(res.isError, true);
    assert.match(res.content[0].text, /does not exist/);
  });
});

describe('MCP server — error handling', () => {
  it('returns -32601 Method not found for unknown methods', async () => {
    const responses = await captureSends(() =>
      server.dispatch({ jsonrpc: '2.0', id: 8, method: 'nonexistent/method' }),
    );
    assert.strictEqual(responses[0].error.code, -32601);
  });

  it('returns -32600 Invalid request when jsonrpc field is wrong', async () => {
    const responses = await captureSends(() =>
      server.dispatch({ jsonrpc: '1.0', id: 9, method: 'initialize' }),
    );
    assert.strictEqual(responses[0].error.code, -32600);
  });

  it('returns invalid-params error for unknown tool', async () => {
    const responses = await captureSends(() =>
      server.dispatch({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'no_such_tool', arguments: {} },
      }),
    );
    // tools/call wraps tool errors as isError instead of JSON-RPC error.
    // The "unknown tool" case is a tool-resolution error and per current
    // implementation throws with code ERROR_INVALID_PARAMS — which becomes
    // a JSON-RPC error response, not an isError content block.
    assert.strictEqual(responses[0].error.code, -32602);
  });

  it('absorbs notifications without sending a response', async () => {
    const responses = await captureSends(() =>
      server.dispatch({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    );
    assert.strictEqual(responses.length, 0);
  });

  it('responds to ping for keepalive', async () => {
    const responses = await captureSends(() =>
      server.dispatch({ jsonrpc: '2.0', id: 11, method: 'ping' }),
    );
    assert.strictEqual(responses.length, 1);
    assert.deepStrictEqual(responses[0].result, {});
  });
});
