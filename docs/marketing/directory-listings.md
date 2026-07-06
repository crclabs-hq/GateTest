# MCP Directory Listings Pack — GateTest

**Status:** DRAFT for Craig. Each block below is ready to paste into the named directory's submission form. Individually small, collectively they build SEO for "gatetest mcp" and put GateTest in front of every MCP-curious developer. ~2 minutes each.

**Shared assets (use everywhere):**
- **Name:** GateTest
- **Homepage:** https://gatetest.ai
- **MCP page:** https://gatetest.ai/mcp
- **Repo:** https://github.com/crclabs-hq/gatetest
- **Install (local):** `npx -y @gatetest/mcp-server`
- **Install (remote URL):** `https://mcp.gatetest.ai/mcp`
- **Icon:** https://gatetest.ai/icon.png
- **License:** MIT
- **Category tags:** developer-tools, code-quality, security, testing, ai-agent
- **One-liner:** Give Claude verified eyes, ears, and hands on your codebase.

**Standard 2-3 sentence description (reuse):**
> GateTest is a 120-module code-quality and security engine delivered over MCP. It gives your AI assistant capabilities it can't get alone: scan any live website or public GitHub repo (free, no key), screenshot rendered pages, pull real production errors from Sentry/Datadog/Rollbar, auto-fix findings, and prove the fix worked by re-running your tests. Free tools work with no key; a $29/mo subscription unlocks the full deep scan and AI auto-fix.

---

## Smithery (smithery.ai)
- Submit: connect the GitHub repo at smithery.ai/new
- Uses `server.json` / smithery.yaml auto-detection. Confirm the repo's `server.json` is picked up.
- Highlight: both stdio + remote transports; free tier requires no key (good for their "try it" sandbox).

## PulseMCP (pulsemcp.com)
- Submit: pulsemcp.com/submit
- Name, one-liner, repo URL, category tags (above). PulseMCP indexes by repo — keep the README sharp.

## Glama (glama.ai/mcp/servers)
- Submit: glama.ai has an automated GitHub crawler + a manual submit. Ensure repo topics include `mcp`, `model-context-protocol`.
- Glama scores servers on security/quality — the fact that GateTest IS a code-quality tool is on-brand; mention the 120-module engine.

## mcp.so
- Submit: mcp.so/submit
- Paste name, description, repo, npm package `@gatetest/mcp-server`, category tags.

## Cursor directory (cursor.directory / cursor.com/mcp)
- Submit via their MCP directory form.
- Emphasize the **remote URL** install (`https://mcp.gatetest.ai/mcp`) — Cursor supports URL-based MCP add, zero terminal.

## Cline MCP Marketplace (github.com/cline/mcp-marketplace)
- Submit: open an issue/PR on the cline/mcp-marketplace repo per their template.
- Requires: name, description, GitHub URL, logo, and a working install command. Provide `npx -y @gatetest/mcp-server`.

## Docker MCP Catalog (hub.docker.com / MCP catalog)
- Optional/later: requires a container image. Only pursue if a Dockerized MCP is worth the packaging effort — the npx + remote-URL paths already cover most users. Note as a fast-follow, not day-one.

---

**Cross-directory tip:** every listing should link back to `https://gatetest.ai/mcp` (which now has all 4 install paths). The consistent "eyes, ears & hands" framing + the free `scan_url`/`scan_repo` hook is what converts a directory browser into a first run.
