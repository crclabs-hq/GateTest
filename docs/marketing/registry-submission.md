# Registry Submission Kit — GateTest MCP

**Status:** DRAFT for Craig. Nothing here is submitted automatically. Each step below is Craig's action (public-facing = Boss Rule #8).

Goal: get GateTest listed in (1) the official **Anthropic MCP Registry** (`registry.modelcontextprotocol.io`) and (2) the **claude.ai Connectors** directory — the two highest-intent discovery surfaces, replacing the rejected GitHub Marketplace channel.

---

## 1. Pre-flight: server.json validation

Both `server.json` (repo root) and `packages/mcp-server/server.json` now carry **two** transports:

- `remote` → `streamable-http` → `https://gatetest.ai/api/mcp` (reaches web/mobile/no-npm users)
- `npm` → `stdio` → `npx -y @gatetest/mcp-server` (full 22-tool local install)

Checklist before submitting:
- [ ] `https://gatetest.ai/api/mcp` is live — deploys with the site on Vercel (in-repo route, isolated from Jarvis/Vapron/Gluecron; Craig 2026-07-07). Verify: `curl -s -X POST https://gatetest.ai/api/mcp -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` returns 8 tools. (Optional nicer branding later: add `mcp.gatetest.ai` as a Vercel domain alias.)
- [ ] `name` field matches the namespace you own on the registry (`io.github.ccantynz-alt/gatetest` — must match the GitHub account you auth with)
- [ ] `version` bumped if anything changed since last publish
- [ ] `icon` URL (`https://gatetest.ai/icon.png`) resolves publicly

---

## 2. Anthropic MCP Registry — publish commands

The registry uses the `mcp-publisher` CLI with GitHub-based namespace auth. Craig runs these from the repo root:

```bash
# install the publisher CLI (one-time) — it's a Go binary from GitHub releases,
# NOT an npm package. `npm install -g @modelcontextprotocol/publisher` 404s.
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher
sudo mv mcp-publisher /usr/local/bin/
# macOS alternative: brew install mcp-publisher (if the tap exists at submission time)
# Windows: no prebuilt binary as of 2026-07 — use WSL/a Linux box, or `make publisher` from a
# local clone of github.com/modelcontextprotocol/registry (needs Go toolchain).

# authenticate — opens a browser, proves you own the io.github.ccantynz-alt namespace
mcp-publisher login github

# validate the manifest without publishing
mcp-publisher validate ./server.json

# publish
mcp-publisher publish ./server.json
```

If the CLI name/flags differ from the above at submission time, check `mcp-publisher --help` — the flow is always: login (GitHub) → validate → publish. The namespace (`io.github.<account>`) must match the GitHub account you log in with, or publish is rejected.

After publishing, GateTest appears in the registry that Claude Code, Cursor, and other clients read from — users can add it by name.

---

## 3. claude.ai Connectors directory — submission draft

claude.ai has a browsable Connectors/Integrations directory where users one-click-add remote MCP servers. Submit via the form in Anthropic's developer console (Craig's account).

**Copy to paste:**

- **Name:** GateTest
- **Tagline:** Give Claude verified eyes, ears, and hands on your codebase.
- **Category:** Developer Tools / Code Quality
- **Remote MCP URL:** `https://gatetest.ai/api/mcp`
- **Description:**
  > GateTest is a 120-module code-quality and security engine delivered over MCP. It gives Claude capabilities it can't get alone: scan any live website or public GitHub repo for security, reliability, and quality issues (free, no key), explain any finding in plain English, and open a fix PR — all from the chat. A $29/mo key unlocks the full deep scan and AI auto-fix. Free tools: scan_url, scan_repo, list_modules, get_badge.
- **Auth model:** Bearer token (`Authorization: Bearer gtmcp_...`). Free tools require no auth.

**Honesty note to include / be ready for:** Anthropic's directory generally prefers **OAuth** for authenticated connectors. GateTest currently uses a static Bearer subscription key (same model as many API-key MCPs). If the directory requires OAuth, that's a follow-up build (an OAuth authorization-code flow in front of the subscription store) — flag it as a fast-follow rather than a blocker. The **free** tools need no auth and satisfy a directory listing on their own.

---

## 4. After listing — what to watch

- Registry install analytics (if exposed) to see pickup.
- The MCP telemetry the remote endpoint already writes (`/var/log/gatetest/mcp-telemetry.jsonl` on the box) — feeds the nightly pattern-miner; watch which tools registry users actually call.
