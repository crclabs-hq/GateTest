# GateTest Remote MCP — `https://gatetest.io/api/mcp`

The hosted MCP endpoint that gives **every** MCP client GateTest tools with zero
install — claude.ai web and mobile, Claude Desktop, Cursor, Windsurf,
corporate locked-down machines. The local stdio server (`npx @gatetest/mcp-server`)
only reaches users who can run npm; this reaches everyone else.

**The live endpoint is `POST https://gatetest.io/api/mcp`** — the Next.js route
`website/app/api/mcp/route.ts`, deployed with the site. It is what the MCP
registry lists (`server.json`, `ai.gatetest.www/gatetest`, transport
`streamable-http`). `mcp.gatetest.io` was the planned hostname for a dedicated
box; the record was never kept and the name is NXDOMAIN (2026-09-14) — do not
point anything at it.

## What this package is

An optional **self-hosted** wrapper around the same core, for running the
endpoint on a box of your own instead of with the site: Bun + Hono, one HTTP
route, nothing else. It is not what serves `gatetest.io/api/mcp`.

```
MCP client    ──HTTPS──▶ gatetest.io/api/mcp   (Next.js route, deployed with the site)
                              │
             website/app/lib/mcp-remote-core.cjs   (JSON-RPC dispatch, key gate)
                              │
                 gatetest.io product APIs (scan/guidance/fix/validate)

self-hosted alternative:
MCP client    ──HTTPS──▶ your reverse proxy ──▶ Bun + Hono (this package, port 8787)
                                                        │
                                          the same mcp-remote-core.cjs
```

- `website/app/lib/mcp-remote-core.cjs` — transport-agnostic MCP core, plain
  CommonJS, tested by the repo suite (`tests/mcp-remote.test.js`). All 8 tools
  proxy gatetest.io APIs. One copy, used by both transports.
- `src/index.ts` — thin Hono wrapper: CORS, `Mcp-Session-Id`, JSON-RPC envelope I/O.
- `website/app/lib/mcp-remote-modules.json` — generated from the real engine by
  `scripts/generate-mcp-remote-modules.js` (`tests/mcp-remote-modules-sync.test.js`
  fails the suite when it drifts).

## Tools

| Tool | Access | Proxies |
|---|---|---|
| `check_health` | free | `/api/v1/health` |
| `list_modules` | free | (embedded engine list, 121 modules) |
| `get_badge` | free | `/badge/:owner/:repo` |
| `scan_url` | free | `POST /api/web/scan` |
| `scan_repo` | free | `POST /api/playground/scan` |
| `get_report` | key | (session memory) |
| `explain_finding` | key | `POST /api/scan/guidance` |
| `fix_issue` | key | `POST /api/scan/fix` (customer GitHub PAT passed through, never stored) |

Local-only forever (need the user's filesystem/processes — install
`npx -y @gatetest/mcp-server` for these): `scan_local`, `run_tests`,
`stream_logs`, `query_db`, `http_request`, `capture_screenshot`,
`get_production_errors` (vendor creds live in the user's env).

Key gate: `Authorization: Bearer gtmcp_xxx` (or `X-GateTest-Key`), validated
against `https://gatetest.io/api/mcp/validate`, cached 1 hour in-process.

## Connect a client to the hosted endpoint

```json
{
  "mcpServers": {
    "gatetest": {
      "url": "https://gatetest.io/api/mcp",
      "headers": { "Authorization": "Bearer gtmcp_..." }
    }
  }
}
```

The `Authorization` header is optional — the free tools work without it.

## Self-host (optional)

```bash
git clone https://github.com/crclabs-hq/gatetest.git /opt/gatetest
cd /opt/gatetest/packages/mcp-remote && bun install
PORT=8787 GATETEST_API_BASE_URL=https://gatetest.io bun run src/index.ts
```

Run it under your process supervisor (a systemd unit with
`WorkingDirectory=/opt/gatetest/packages/mcp-remote` and
`ExecStart=/usr/local/bin/bun run src/index.ts` is enough), bound to
`127.0.0.1`, and let the platform's reverse proxy terminate TLS for whatever
hostname you give it. `GATETEST_MCP_TELEMETRY` (default
`/var/log/gatetest/mcp-telemetry.jsonl`) is the flywheel event log; set it to a
writable path.

## Verify

```bash
# the hosted endpoint
curl -s -X POST https://gatetest.io/api/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# a self-hosted instance
curl -s http://127.0.0.1:8787/healthz
curl -s -X POST http://127.0.0.1:8787/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
