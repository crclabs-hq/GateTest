# GateTest Remote MCP — `mcp.gatetest.ai`

The hosted MCP endpoint that gives **every** Claude user GateTest tools with zero
install — claude.ai web app, Claude mobile, Claude Desktop, Cursor, Windsurf,
corporate locked-down machines. The local stdio server (`npx @gatetest/mcp-server`)
only reaches users who can run npm; this reaches everyone else.

## Where it runs — and why it must stay there

**Host: the Jarvis server, `66.42.121.161` (Vultr).** Jarvis orchestrates on this
box — GateTest's MCP endpoint is co-located there BY DESIGN so Jarvis can control
GateTest directly. **Do not move it to a different server.** (Craig, 2026-07-07.)

Not Vercel — Vercel is a competitor (see the Bible / docs/ROADMAP.md).

## Architecture

```
Claude client ──HTTPS──▶ mcp.gatetest.ai (Caddy TLS on the box)
                              │
                        Bun + Hono  (this package, port 8787)
                              │
                    src/core.cjs  (JSON-RPC dispatch, key gate)
                              │
                 gatetest.ai product APIs (scan/guidance/fix/validate)
```

- `src/core.cjs` — transport-agnostic MCP core, plain CommonJS, tested by the
  repo suite (`tests/mcp-remote.test.js`). All 8 tools proxy gatetest.ai APIs.
- `src/index.ts` — thin Hono wrapper: CORS, `Mcp-Session-Id`, JSON-RPC envelope I/O.
- `src/modules-list.json` — generated from the real engine
  (`node bin/gatetest.js --list`). Regenerate when the module count changes.

## Tools

| Tool | Access | Proxies |
|---|---|---|
| `check_health` | free | `/api/v1/health` |
| `list_modules` | free | (embedded engine list, 120 modules) |
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
against `https://gatetest.ai/api/mcp/validate`, cached 1 hour in-process.

## Deploy (on the box)

```bash
# one-time
git clone https://github.com/crclabs-hq/gatetest.git /opt/gatetest
cd /opt/gatetest/packages/mcp-remote && bun install

# run under systemd
cat >/etc/systemd/system/gatetest-mcp.service <<'EOF'
[Unit]
Description=GateTest remote MCP endpoint
After=network.target

[Service]
WorkingDirectory=/opt/gatetest/packages/mcp-remote
ExecStart=/usr/local/bin/bun run src/index.ts
Restart=always
Environment=PORT=8787

[Install]
WantedBy=multi-user.target
EOF
systemctl enable --now gatetest-mcp
```

Caddy (terminates TLS for `mcp.gatetest.ai`, auto-provisions Let's Encrypt):

```
mcp.gatetest.ai {
    reverse_proxy localhost:8787
}
```

DNS (Cloudflare): `A  mcp  66.42.121.161  DNS-only` — flip to proxied +
"Full (strict)" SSL after the origin cert works.

## Verify

```bash
curl -s https://mcp.gatetest.ai/healthz
curl -s -X POST https://mcp.gatetest.ai/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
