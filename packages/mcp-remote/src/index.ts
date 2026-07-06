/**
 * GateTest Remote MCP — Hono/Bun HTTP transport.
 *
 * MCP Streamable HTTP endpoint at POST /mcp. All protocol + tool logic lives
 * in core.js (transport-agnostic, tested by the repo's node --test suite);
 * this file only does HTTP: CORS, session header, JSON-RPC envelope I/O.
 *
 * Runs on the Jarvis server (66.42.121.161) behind mcp.gatetest.ai — see
 * ../README.md for deployment. Start: `bun run src/index.ts`.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';

// core.js is CommonJS — Bun interops transparently.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createMcpCore } = require('./core.cjs');

const PORT = Number(process.env.PORT || 8787);
const API_BASE = process.env.GATETEST_API_BASE_URL || 'https://gatetest.ai';
const TELEMETRY_FILE = process.env.GATETEST_MCP_TELEMETRY || '/var/log/gatetest/mcp-telemetry.jsonl';

// Flywheel: append one JSONL event per tool call — the same contract the local
// stdio server writes to ~/.gatetest/mcp-telemetry.jsonl, so the nightly
// pattern-miner trains on remote usage too. Fire-and-forget, never blocks.
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
let telemetryReady = false;
async function logToolCall(event: unknown) {
  try {
    if (!telemetryReady) {
      await mkdir(dirname(TELEMETRY_FILE), { recursive: true });
      telemetryReady = true;
    }
    await appendFile(TELEMETRY_FILE, JSON.stringify(event) + '\n');
  } catch {
    // telemetry must never break a tool call
  }
}

const core = createMcpCore({ apiBase: API_BASE, onToolCall: logToolCall });

const app = new Hono();

app.use(
  '/mcp',
  cors({
    origin: '*',
    allowHeaders: ['Content-Type', 'Authorization', 'X-GateTest-Key', 'Mcp-Session-Id'],
    exposeHeaders: ['Mcp-Session-Id'],
  }),
);

// Health probe for the reverse proxy / uptime monitor.
app.get('/healthz', (c) => c.json({ ok: true, server: 'gatetest-remote-mcp' }));

// Some MCP clients probe GET /mcp for SSE server-push; we serve request/response
// only, which the Streamable HTTP spec allows a server to signal with 405.
app.get('/mcp', (c) => c.body(null, 405));

app.post('/mcp', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }

  // Session id: honour the client's Mcp-Session-Id, mint one on initialize.
  const sessionId = c.req.header('Mcp-Session-Id') || crypto.randomUUID();
  c.header('Mcp-Session-Id', sessionId);

  const headers = { ...c.req.header() };
  const messages = Array.isArray(body) ? body : [body];

  const responses = [];
  for (const message of messages) {
    const res = await core.handleRpc(message, { headers, sessionId });
    if (res !== null) responses.push(res);
  }

  // Pure-notification batch: 202 Accepted with no body, per the spec.
  if (responses.length === 0) return c.body(null, 202);
  return c.json(Array.isArray(body) ? responses : responses[0]);
});

export default { port: PORT, fetch: app.fetch };

console.log(`GateTest remote MCP listening on :${PORT} (engine: ${API_BASE})`);
