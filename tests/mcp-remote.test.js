// ============================================================================
// Remote MCP core — packages/mcp-remote/src/core.cjs
//
// The hosted mcp.gatetest.ai endpoint's transport-agnostic JSON-RPC core.
// Tests use an injected fetchImpl so no network is touched.
// ============================================================================
const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  createMcpCore,
  extractKey,
  keyShapeValid,
  createKeyValidator,
  TOOLS,
  FREE_TOOLS,
  PROTOCOL_VERSION,
} = require('../packages/mcp-remote/src/core.cjs');

const VALID_KEY = 'gtmcp_' + 'a'.repeat(64); // 70 chars

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    for (const [match, responder] of routes) {
      if (String(url).includes(match)) {
        const out = typeof responder === 'function' ? responder(url, opts) : responder;
        return {
          ok: (out.status || 200) < 400,
          status: out.status || 200,
          json: async () => out.body,
          text: async () => JSON.stringify(out.body),
        };
      }
    }
    throw new Error(`no fake route for ${url}`);
  };
  impl.calls = calls;
  return impl;
}

// ---------------------------------------------------------------------------
// Key extraction + shape
// ---------------------------------------------------------------------------

describe('remote MCP — key extraction', () => {
  it('reads Authorization: Bearer', () => {
    assert.equal(extractKey({ authorization: `Bearer ${VALID_KEY}` }), VALID_KEY);
  });

  it('reads X-GateTest-Key (case-insensitive)', () => {
    assert.equal(extractKey({ 'X-GateTest-Key': VALID_KEY }), VALID_KEY);
  });

  it('reads Headers-like objects with .get()', () => {
    const headers = { get: (n) => (n === 'authorization' ? `Bearer ${VALID_KEY}` : null) };
    assert.equal(extractKey(headers), VALID_KEY);
  });

  it('returns undefined when absent', () => {
    assert.equal(extractKey({}), undefined);
  });

  it('keyShapeValid enforces gtmcp_ prefix and 70-char minimum', () => {
    assert.equal(keyShapeValid(VALID_KEY), true);
    assert.equal(keyShapeValid('gtmcp_short'), false);
    assert.equal(keyShapeValid('wrong_' + 'a'.repeat(64)), false);
    assert.equal(keyShapeValid(undefined), false);
  });
});

// ---------------------------------------------------------------------------
// Key validator — validate endpoint + cache + stale-cache fallback
// ---------------------------------------------------------------------------

describe('remote MCP — key validator', () => {
  it('hits /api/mcp/validate and caches for 1 hour', async () => {
    const fetchImpl = fakeFetch([['/api/mcp/validate', { body: { valid: true } }]]);
    let t = 1_000_000;
    const validate = createKeyValidator({ apiBase: 'https://x', fetchImpl, now: () => t });

    assert.equal(await validate(VALID_KEY), true);
    assert.equal(await validate(VALID_KEY), true);
    assert.equal(fetchImpl.calls.length, 1, 'second call served from cache');

    t += 61 * 60 * 1000; // past TTL
    assert.equal(await validate(VALID_KEY), true);
    assert.equal(fetchImpl.calls.length, 2, 'expired cache revalidates');
  });

  it('falls back to stale cache on network error', async () => {
    let fail = false;
    const fetchImpl = async () => {
      if (fail) throw new Error('network down');
      return { ok: true, status: 200, json: async () => ({ valid: true }), text: async () => '{}' };
    };
    let t = 0;
    const validate = createKeyValidator({ apiBase: 'https://x', fetchImpl, now: () => t });
    assert.equal(await validate(VALID_KEY), true);
    fail = true;
    t += 2 * 60 * 60 * 1000; // cache expired AND network down
    assert.equal(await validate(VALID_KEY), true, 'stale cache honoured over lockout');
  });

  it('fast-rejects malformed keys without any network call', async () => {
    const fetchImpl = fakeFetch([]);
    const validate = createKeyValidator({ apiBase: 'https://x', fetchImpl });
    assert.equal(await validate('gtmcp_tooshort'), false);
    assert.equal(fetchImpl.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// JSON-RPC protocol surface
// ---------------------------------------------------------------------------

describe('remote MCP — protocol', () => {
  it('initialize returns protocol version, capabilities, server info', async () => {
    const core = createMcpCore({ fetchImpl: fakeFetch([]) });
    const res = await core.handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(res.result.protocolVersion, PROTOCOL_VERSION);
    assert.equal(res.result.serverInfo.name, 'gatetest');
    assert.ok(res.result.capabilities.tools);
    assert.ok(res.result.capabilities.prompts);
    assert.match(res.result.instructions, /scan_url/);
  });

  it('tools/list returns all 8 remote tools', async () => {
    const core = createMcpCore({ fetchImpl: fakeFetch([]) });
    const res = await core.handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(res.result.tools.length, 8);
    const names = res.result.tools.map((t) => t.name);
    for (const n of ['check_health', 'list_modules', 'get_badge', 'scan_url', 'scan_repo', 'get_report', 'explain_finding', 'fix_issue']) {
      assert.ok(names.includes(n), `missing tool ${n}`);
    }
  });

  it('local-only tools are NOT exposed remotely', () => {
    const names = TOOLS.map((t) => t.name);
    for (const n of ['scan_local', 'run_tests', 'stream_logs', 'query_db', 'http_request']) {
      assert.ok(!names.includes(n), `${n} must stay local-only`);
    }
  });

  it('notifications get no response', async () => {
    const core = createMcpCore({ fetchImpl: fakeFetch([]) });
    const res = await core.handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(res, null);
  });

  it('unknown method returns -32601', async () => {
    const core = createMcpCore({ fetchImpl: fakeFetch([]) });
    const res = await core.handleRpc({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
    assert.equal(res.error.code, -32601);
  });

  it('malformed message returns -32600', async () => {
    const core = createMcpCore({ fetchImpl: fakeFetch([]) });
    const res = await core.handleRpc({ hello: 'world' });
    assert.equal(res.error.code, -32600);
  });

  it('prompts/list + prompts/get serve the quick-start onboarding', async () => {
    const core = createMcpCore({ fetchImpl: fakeFetch([]) });
    const list = await core.handleRpc({ jsonrpc: '2.0', id: 4, method: 'prompts/list' });
    assert.equal(list.result.prompts[0].name, 'gatetest-quick-start');
    const got = await core.handleRpc({
      jsonrpc: '2.0', id: 5, method: 'prompts/get',
      params: { name: 'gatetest-quick-start', arguments: { target: 'https://example.com' } },
    });
    assert.match(got.result.messages[0].content.text, /https:\/\/example\.com/);
  });
});

// ---------------------------------------------------------------------------
// Subscription gate
// ---------------------------------------------------------------------------

describe('remote MCP — subscription gate', () => {
  it('free tools work with no key', async () => {
    const core = createMcpCore({ fetchImpl: fakeFetch([]) });
    const res = await core.handleRpc({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'list_modules', arguments: {} },
    });
    assert.ok(!res.result.isError);
    assert.match(res.result.content[0].text, /120/);
  });

  it('gated tool without key returns upgrade instructions, not a crash', async () => {
    const core = createMcpCore({ fetchImpl: fakeFetch([]) });
    const res = await core.handleRpc({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'explain_finding', arguments: { module: 'x', detail: 'y' } },
    });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /gatetest\.ai\/mcp/);
  });

  it('gated tool with a valid key goes through', async () => {
    const fetchImpl = fakeFetch([
      ['/api/mcp/validate', { body: { valid: true } }],
      ['/api/scan/guidance', { body: { guidance: [{ module: 'x', title: 'T', why: 'W', steps: ['s1'] }] } }],
    ]);
    const core = createMcpCore({ apiBase: 'https://gatetest.ai', fetchImpl });
    const res = await core.handleRpc(
      {
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'explain_finding', arguments: { module: 'x', detail: 'y' } },
      },
      { headers: { authorization: `Bearer ${VALID_KEY}` } },
    );
    assert.ok(!res.result.isError, res.result.content[0].text);
    assert.match(res.result.content[0].text, /Why it matters/);
  });

  it('FREE_TOOLS set matches the documented free tier', () => {
    assert.deepEqual(
      [...FREE_TOOLS].sort(),
      ['check_health', 'get_badge', 'list_modules', 'scan_repo', 'scan_url'],
    );
  });
});

// ---------------------------------------------------------------------------
// Tool handlers (proxy behaviour)
// ---------------------------------------------------------------------------

describe('remote MCP — tool handlers', () => {
  it('scan_url proxies /api/web/scan and formats the result', async () => {
    const fetchImpl = fakeFetch([
      ['/api/web/scan', {
        body: {
          healthScore: { score: 88, grade: 'B' },
          totalFindings: 2, errorCount: 1, warningCount: 1,
          findings: [{ severity: 'error', module: 'webHeaders', title: 'Missing CSP' }],
        },
      }],
    ]);
    const core = createMcpCore({ fetchImpl });
    const res = await core.handleRpc({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'scan_url', arguments: { url: 'https://example.com' } },
    });
    const text = res.result.content[0].text;
    assert.match(text, /88\/100/);
    assert.match(text, /Missing CSP/);
  });

  it('scan_repo proxies /api/playground/scan', async () => {
    const fetchImpl = fakeFetch([
      ['/api/playground/scan', {
        body: { grade: 'A', healthScore: 95, totalIssues: 0, duration: 4200, topFindings: [] },
      }],
    ]);
    const core = createMcpCore({ fetchImpl });
    const res = await core.handleRpc({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'scan_repo', arguments: { repoUrl: 'https://github.com/o/r' } },
    });
    assert.match(res.result.content[0].text, /Grade:\*\* A/);
  });

  it('get_report returns the same session\'s last scan; other sessions see nothing', async () => {
    const fetchImpl = fakeFetch([
      ['/api/mcp/validate', { body: { valid: true } }],
      ['/api/web/scan', { body: { healthScore: { score: 70, grade: 'C' }, findings: [] } }],
    ]);
    const core = createMcpCore({ fetchImpl });
    const auth = { headers: { authorization: `Bearer ${VALID_KEY}` } };

    await core.handleRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'scan_url', arguments: { url: 'https://a.com' } } },
      { ...auth, sessionId: 's1' },
    );
    const hit = await core.handleRpc(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_report', arguments: {} } },
      { ...auth, sessionId: 's1' },
    );
    assert.match(hit.result.content[0].text, /https:\/\/a\.com/);

    const miss = await core.handleRpc(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_report', arguments: {} } },
      { ...auth, sessionId: 's2' },
    );
    assert.equal(miss.result.isError, true);
  });

  it('fix_issue passes customerPat through and surfaces the PR URL', async () => {
    let sentBody = null;
    const fetchImpl = fakeFetch([
      ['/api/mcp/validate', { body: { valid: true } }],
      ['/api/scan/fix', (url, opts) => {
        sentBody = JSON.parse(opts.body);
        return { body: { prUrl: 'https://github.com/o/r/pull/7' } };
      }],
    ]);
    const core = createMcpCore({ fetchImpl });
    const res = await core.handleRpc(
      {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: {
          name: 'fix_issue',
          arguments: { repoUrl: 'https://github.com/o/r', file: 'src/a.js', issue: 'bug', githubToken: 'ghp_test' },
        },
      },
      { headers: { authorization: `Bearer ${VALID_KEY}` } },
    );
    assert.equal(sentBody.customerPat, 'ghp_test');
    assert.deepEqual(sentBody.issues, [{ file: 'src/a.js', issue: 'bug' }]);
    assert.match(res.result.content[0].text, /pull\/7/);
  });

  it('handler exceptions become isError tool results, never protocol errors', async () => {
    const fetchImpl = async () => { throw new Error('boom'); };
    const core = createMcpCore({ fetchImpl });
    const res = await core.handleRpc({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'scan_url', arguments: { url: 'https://x.com' } },
    });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /boom/);
    assert.ok(!res.error, 'must be a tool-level error, not a JSON-RPC error');
  });
});
