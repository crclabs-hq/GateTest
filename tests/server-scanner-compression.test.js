'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const zlib = require('node:zlib');

const ServerScanner = require('../src/scanners/server-scanner');

// Regression for the compression probe blaming a server for not compressing
// when GateTest itself never sent Accept-Encoding — reproduced live against
// tallrig.com and gluecron.com (2026-09-21), both of which return
// Content-Encoding: gzip once asked (verified with curl), yet the crawl
// reported "No compression (gzip/brotli)" for both. `_timedRequest` in
// src/scanners/server-scanner.js now sends
// `Accept-Encoding: gzip, br, zstd` on every request it makes, so a server
// answering `identity` is a genuine finding, not a self-inflicted one.
describe('server-scanner — compression probe sends Accept-Encoding', () => {
  let gzipServer;
  let plainServer;
  let gzipUrl;
  let plainUrl;

  function startServer(handler) {
    return new Promise((resolve) => {
      const server = http.createServer(handler);
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  }

  const BODY = Buffer.from(
    '<html><body>' + 'hello world, this text exists only to give gzip something to shrink. '.repeat(20) + '</body></html>'
  );

  async function setup() {
    if (gzipServer) return;

    // POSITIVE CONTROL — gzips ONLY when the request says it can be gzipped.
    // If the probe never sent Accept-Encoding, this server would answer
    // identity and the finding would (wrongly) be a warning.
    gzipServer = await startServer((req, res) => {
      const acceptEncoding = req.headers['accept-encoding'] || '';
      if (acceptEncoding.includes('gzip')) {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
        res.end(zlib.gzipSync(BODY));
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(BODY);
      }
    });
    gzipUrl = `http://127.0.0.1:${gzipServer.address().port}/`;

    // NEGATIVE CONTROL — never compresses, regardless of what is asked for.
    // Must stay a genuine warning after the fix.
    plainServer = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(BODY);
    });
    plainUrl = `http://127.0.0.1:${plainServer.address().port}/`;
  }

  after(() => {
    if (gzipServer) gzipServer.close();
    if (plainServer) plainServer.close();
  });

  function compressionLine(results) {
    const perf = results.modules.find((m) => m.name === 'performance');
    assert.ok(perf, 'expected a performance module result');
    const line = perf.details.find((d) => /compression/i.test(d));
    assert.ok(line, 'expected a compression finding in performance details');
    return line;
  }

  it('POSITIVE — a server that only gzips on request reports pass with the encoding it actually returned', async () => {
    await setup();
    const results = await new ServerScanner().scan(gzipUrl);
    const line = compressionLine(results);
    assert.match(line, /^pass: gzip compression \(Content-Encoding: gzip\)/);
  });

  it('CONTROL — a server that never compresses is still (genuinely) flagged', async () => {
    await setup();
    const results = await new ServerScanner().scan(plainUrl);
    const line = compressionLine(results);
    assert.match(line, /^warning: No compression/);
    // Says what was sent, so a human reading the finding can tell this was
    // actually asked for and not a probe that forgot to ask.
    assert.match(line, /Accept-Encoding: gzip, br, zstd/);
  });
});
