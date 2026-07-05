'use strict';

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');

// ---------------------------------------------------------------------------
// mcp-http-request.test.js — tests for http_request MCP handler.
// Uses a real local HTTP server for most tests to avoid network dependency.
// ---------------------------------------------------------------------------

let mcp;
let testServer;
let testPort;

before(async () => {
  mcp = await import('../bin/gatetest-mcp.mjs');

  // Start a tiny local HTTP server for realistic tests
  testServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    } else if (req.url === '/echo') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, body, headers: req.headers }));
      });
    } else if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/health' });
      res.end();
    } else if (req.url === '/slow') {
      setTimeout(() => { res.writeHead(200); res.end('finally'); }, 10000);
    } else if (req.url === '/auth-check') {
      const auth = req.headers['authorization'] || '';
      res.writeHead(auth ? 200 : 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ auth }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    }
  });

  await new Promise(resolve => {
    testServer.listen(0, '127.0.0.1', () => {
      testPort = testServer.address().port;
      resolve();
    });
  });
});

const after = (fn) => process.on('exit', fn);
after(() => { if (testServer) testServer.close(); });

function localUrl(path) {
  return `http://127.0.0.1:${testPort}${path}`;
}

describe('MCP http_request handler', () => {
  test('handleHttpRequest is exported', () => {
    assert.strictEqual(typeof mcp.handleHttpRequest, 'function');
  });

  test('rejects missing url', async () => {
    const result = await mcp.handleHttpRequest({});
    assert.ok(result.isError === true || /url is required/i.test(result.content[0].text));
  });

  test('GET /health returns 200 JSON', async () => {
    const result = await mcp.handleHttpRequest({ url: localUrl('/health') });
    assert.ok(!result.isError, `unexpected error: ${result.content?.[0]?.text}`);
    const text = result.content.map(c => c.text).join('\n');
    assert.ok(/200/.test(text), `expected 200 in response: ${text.slice(0, 300)}`);
    assert.ok(/ok/i.test(text), `expected "ok" in response body`);
  });

  test('response content has text type', async () => {
    const result = await mcp.handleHttpRequest({ url: localUrl('/health') });
    for (const c of result.content) {
      assert.strictEqual(c.type, 'text');
    }
  });

  test('POST with body sends correctly', async () => {
    const result = await mcp.handleHttpRequest({
      url: localUrl('/echo'),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'value' }),
    });
    const text = result.content.map(c => c.text).join('\n');
    assert.ok(/POST/i.test(text), `expected POST in echo: ${text.slice(0, 300)}`);
  });

  test('Bearer auth adds Authorization header', async () => {
    const result = await mcp.handleHttpRequest({
      url: localUrl('/auth-check'),
      auth: { type: 'bearer', token: 'my-test-token' },
    });
    const text = result.content.map(c => c.text).join('\n');
    assert.ok(/Bearer my-test-token/i.test(text), `expected bearer token in response: ${text.slice(0, 300)}`);
  });

  test('Basic auth adds Authorization header', async () => {
    const result = await mcp.handleHttpRequest({
      url: localUrl('/auth-check'),
      auth: { type: 'basic', username: 'craig', password: 'secret' },
    });
    const text = result.content.map(c => c.text).join('\n');
    assert.ok(/Basic /i.test(text), `expected Basic auth in response: ${text.slice(0, 300)}`);
  });

  test('custom header auth works', async () => {
    const result = await mcp.handleHttpRequest({
      url: localUrl('/auth-check'),
      auth: { type: 'header', name: 'Authorization', value: 'ApiKey abc123' },
    });
    const text = result.content.map(c => c.text).join('\n');
    assert.ok(/ApiKey abc123/i.test(text), `expected custom header in response: ${text.slice(0, 300)}`);
  });

  test('redirect is followed by default', async () => {
    const result = await mcp.handleHttpRequest({ url: localUrl('/redirect') });
    const text = result.content.map(c => c.text).join('\n');
    assert.ok(/200/.test(text), `expected redirect to /health (200): ${text.slice(0, 300)}`);
    assert.ok(/ok/i.test(text));
  });

  test('404 response is returned (not treated as error)', async () => {
    const result = await mcp.handleHttpRequest({ url: localUrl('/doesnotexist') });
    const text = result.content.map(c => c.text).join('\n');
    assert.ok(/404/.test(text), `expected 404 in response: ${text.slice(0, 300)}`);
  });

  test('timeout enforced', async () => {
    const result = await mcp.handleHttpRequest({
      url: localUrl('/slow'),
      timeout: 1,
    });
    // Should be isError (timeout) not a 200
    const text = result.content.map(c => c.text).join('\n');
    const isTimedOut = result.isError === true || /timed out|timeout/i.test(text);
    assert.ok(isTimedOut, `expected timeout error: ${text.slice(0, 300)}`);
  });

  test('response text includes status, headers section, body section', async () => {
    const result = await mcp.handleHttpRequest({ url: localUrl('/health') });
    const text = result.content.map(c => c.text).join('\n');
    assert.ok(/Status:/i.test(text), 'has Status:');
    assert.ok(/Response headers/i.test(text), 'has Response headers section');
    assert.ok(/Response body/i.test(text), 'has Response body section');
  });

  test('unreachable host returns isError', async () => {
    // Port 1 is almost certainly not listening anywhere
    const result = await mcp.handleHttpRequest({
      url: 'http://127.0.0.1:1/test',
      timeout: 3,
    });
    assert.ok(result.isError === true || /failed|refused|timeout/i.test(result.content[0].text));
  });
});
