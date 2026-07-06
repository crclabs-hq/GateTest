# Jarvis Deploy Brief — GateTest Remote MCP endpoint

**From:** GateTest engineering session (Claude Code, 2026-07-07, Craig-authorized)
**To:** Jarvis (66.42.121.161)
**Task:** Deploy the GateTest hosted MCP endpoint on this box, behind `mcp.gatetest.ai`.

## Context

GateTest is shipping a hosted MCP endpoint so claude.ai web/mobile users can use
GateTest tools with zero install. DNS is already live: `mcp.gatetest.ai` → A record
→ `66.42.121.161` (this box), DNS-only/grey-cloud. The code is in the GateTest repo
at `packages/mcp-remote/` — a Bun + Hono service, no Playwright, no heavy deps
(single dependency: hono). It is deliberately co-located on this box so Jarvis can
control GateTest directly.

## Constraints

1. Do NOT modify any existing Jarvis services, ports, or Caddy sites — append only.
2. The service binds `127.0.0.1:8787`. If 8787 is taken on this box, pick a free
   port and use it consistently in both the systemd unit (`Environment=PORT=...`)
   and the Caddy reverse_proxy line.
3. No secrets required. The service holds no keys — it proxies gatetest.ai APIs
   and validates customer keys against gatetest.ai/api/mcp/validate.
4. Telemetry writes to `/var/log/gatetest/mcp-telemetry.jsonl` (the service
   creates the directory itself; ensure the service user can write there).

## Steps

```bash
# 1. Get the code
git clone https://github.com/crclabs-hq/gatetest.git /opt/gatetest
cd /opt/gatetest/packages/mcp-remote
bun install   # install bun first if absent: curl -fsSL https://bun.sh/install | bash

# 2. Smoke-test it runs
PORT=8787 bun run src/index.ts &
sleep 2
curl -s http://127.0.0.1:8787/healthz          # expect {"ok":true,...}
curl -s -X POST http://127.0.0.1:8787/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'   # expect 8 tools
kill %1

# 3. systemd unit
cat >/etc/systemd/system/gatetest-mcp.service <<'EOF'
[Unit]
Description=GateTest remote MCP endpoint (mcp.gatetest.ai)
After=network.target

[Service]
WorkingDirectory=/opt/gatetest/packages/mcp-remote
ExecStart=/root/.bun/bin/bun run src/index.ts
Restart=always
RestartSec=3
Environment=PORT=8787

[Install]
WantedBy=multi-user.target
EOF
# (adjust ExecStart to the actual bun path: `which bun`)
systemctl daemon-reload && systemctl enable --now gatetest-mcp

# 4. Caddy site (append to the existing Caddyfile — do not overwrite)
# mcp.gatetest.ai {
#     reverse_proxy 127.0.0.1:8787
# }
# then: systemctl reload caddy
# If this box uses nginx instead of Caddy, use an equivalent server block +
# certbot for the mcp.gatetest.ai cert.
```

## Verify (all four must pass)

```bash
curl -s https://mcp.gatetest.ai/healthz
# → {"ok":true,"server":"gatetest-remote-mcp"}

curl -s -X POST https://mcp.gatetest.ai/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
# → serverInfo.name "gatetest"

curl -s -X POST https://mcp.gatetest.ai/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
# → 8 tools

curl -s -X POST https://mcp.gatetest.ai/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"scan_url","arguments":{"url":"https://gatetest.ai"}}}'
# → a real scan result with a health score (takes ~10-30s)
```

## Report back

Confirm to Craig: service status (`systemctl status gatetest-mcp`), the four verify
results, and which port/proxy path was used if anything deviated from the default.

## Updating later

```bash
cd /opt/gatetest && git pull && systemctl restart gatetest-mcp
```
