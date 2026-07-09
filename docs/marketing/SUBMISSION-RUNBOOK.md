# Submission-Day Runbook — fire the moment gatetest.ai is back

**Created 2026-07-08.** The listing blitz was prepared while production was down
(DNS pointed at 66.42.121.161 instead of Vercel — Traefik default cert, "no
available server"). Several directories health-check the remote URL at
submission time, and every human reviewer clicks the homepage — so NOTHING
below is submitted until the domain is restored.

**Research basis:** live investigation of each directory's mechanism, 2026-07-08.
Supersedes the mechanism notes in `directory-listings.md` (copy blocks there are
still the canonical text to paste).

---

## Gate 0 — confirm the site is actually back (run all three)

```bash
curl -s -o /dev/null -w "%{http_code}" https://gatetest.ai/           # expect 200
curl -s https://gatetest.ai/api/status | head -c 400                  # expect JSON, ready:true-ish
curl -s -X POST https://gatetest.ai/api/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 400   # expect 8 tools
curl -s -o /dev/null -w "%{http_code}" https://gatetest.ai/icon.png   # expect 200 (added to public/ 2026-07-08)
```

All four green → proceed top to bottom.

---

## Wave 1 — Claude-executable via `gh` (agent runs these; Craig approves publish actions)

### 1a. GitHub release with the Desktop extension (already built: `dist/gatetest.mcpb`)
```bash
gh release create v1.1.3 dist/gatetest.mcpb \
  --title "GateTest MCP v1.1.3 — Claude Desktop one-click extension" \
  --notes "<see notes in task history — install via double-click, optional gtmcp_ key, free tools keyless>"
```
Then add the one-click install button to `website/app/mcp/page.tsx` pointing at
`https://github.com/crclabs-hq/GateTest/releases/download/v1.1.3/gatetest.mcpb`.

### 1b. Anthropic MCP Registry (**Craig moment: GitHub device login**)
```bash
# mcp-publisher is a Go binary from GitHub releases, not npm (confirmed 2026-07-09 —
# @modelcontextprotocol/publisher 404s on the npm registry). No Windows build exists;
# run this from WSL/a Linux box, or `make publisher` from a Go-toolchain checkout of
# modelcontextprotocol/registry.
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher && sudo mv mcp-publisher /usr/local/bin/
mcp-publisher login github        # Craig completes browser/device flow (owns io.github.ccantynz-alt)
mcp-publisher validate ./server.json
mcp-publisher publish ./server.json
```
PulseMCP crawls this registry daily — publishing here gets PulseMCP for free.

### 1c. Cline MCP Marketplace — GitHub issue on `cline/mcp-marketplace`
Template `mcp-server-submission.yml`. Payload:
- **Repo URL:** https://github.com/crclabs-hq/GateTest
- **Logo:** 400×400 PNG — `packages/mcp-server/icon.png` (exists, exactly 400×400)
- **Reason:** standard 2-3 sentence description from `directory-listings.md` + "free tools need no key — Cline users can scan any URL/repo immediately"
- **Setup confirmation:** README install steps verified (`npx -y @gatetest/mcp-server`)
- Review time observed: ~2 days.

### 1d. mcp.so — GitHub issue on `chatmcp/mcpso`
Name, one-liner, tool count (22), transports (stdio + streamable-http), repo URL,
homepage, npm package `@gatetest/mcp-server`, icon URL.

### 1e. Docker MCP Catalog — GitHub PR on `docker/mcp-registry` (**wait — CI validates the remote endpoint**)
`servers/gatetest/server.yaml`, MIT license OK. Their CI probes the remote URL —
only submit after Gate 0 passes. Fast-follow, not day-one (per directory-listings.md).

## Wave 2 — Craig's web forms (~2 min each; copy blocks in `directory-listings.md`)

| Directory | URL | Notes |
|---|---|---|
| claude.ai Connectors | Anthropic developer console form | Field pack in `registry-submission.md` §3. Bearer-token honesty note ready; free tools carry the listing if OAuth is required. |
| Smithery | smithery.ai/new (account) | Connect the GitHub repo; server.json auto-detected. Likely validates the remote URL — Gate 0 first. |
| Glama | glama.ai submit (account) | **Health-checks the remote URL** — Gate 0 first. Ensure repo topics include `mcp`, `model-context-protocol`. |
| Cursor directory | cursor.directory/mcp/new (login) | Emphasize remote-URL install. 250k+ monthly devs. |
| PulseMCP | pulsemcp.com/submit | Optional — daily-crawls the Anthropic registry, so 1b usually covers it. |
| mcp.directory | mcp.directory/submit | GitHub URL + npm package; no auth wall observed. |
| mcpservers.org | mcpservers.org/submit | Awesome-list style. |
| MCP Market | mcpmarket.com/submit (account) | GitHub repo URL. |

## Wave 3 — launch posts (Craig posts, same day as Gate 0 + Wave 1)

- **Show HN:** `show-hn.md` — title #1, body ready, first-comment ready. Craig at keyboard 2h.
- **Product Hunt:** `product-hunt.md` — listing kit.
- Prep item still open before HN: 2-3 real before/after fix PRs linked from the README (trust artifacts).

---

## Standing notes
- `packages/mcp-remote/` (Jarvis/Bun staging) stays untouched — superseded by the in-repo Vercel endpoint.
- Every listing links back to `https://gatetest.ai/mcp`.
- If any directory requires OAuth for authed connectors: free tools satisfy the listing; OAuth front-end is a flagged fast-follow build (Craig authorization — new auth surface).
