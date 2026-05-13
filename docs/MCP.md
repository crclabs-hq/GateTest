# GateTest as an MCP Server

GateTest ships a **Model Context Protocol (MCP)** stdio server so any
MCP-capable AI client — Claude Code, Cursor, Cline, Windsurf, Continue,
custom agents — can invoke all 67 GateTest modules as native tools.

No competitor in our space ships an MCP server today. SonarQube, Snyk,
Codacy, CodeClimate — none of them. GateTest is first.

## Why this matters

When you tell Claude Code "scan my repo," the agent can now call
`gatetest_scan` directly — no shell-out, no copy-paste, no missing
context. The model gets the full structured summary (gate status,
per-module results, error counts, fix suggestions) and can reason about
fixes immediately.

Same for Cursor's agent, Cline, Windsurf, anything that speaks MCP.

## Quick start

### 1. Install GateTest

```bash
npm install -g gatetest
```

This puts `gatetest` and `gatetest-mcp` on your PATH.

### 2. Add it to your MCP client config

#### Claude Code

Edit `~/.claude/mcp.json` (create if missing):

```json
{
  "mcpServers": {
    "gatetest": {
      "command": "gatetest",
      "args": ["mcp"]
    }
  }
}
```

#### Cursor

Settings → Features → Model Context Protocol → Add Server:

- Name: `gatetest`
- Command: `gatetest`
- Args: `mcp`

#### Cline / Windsurf / Continue

Same shape — see your client's MCP config docs and use:

```
command: gatetest
args:    [mcp]
```

### 3. Restart your client

The next time the agent reasons, it sees three new tools:

| Tool | What it does |
|------|--------------|
| `gatetest_version` | Returns version, total module count, list of every module name. Use for capability discovery. |
| `gatetest_list_modules` | Returns every module with name + one-line description. |
| `gatetest_scan` | Runs a scan on a local project directory. Either supply a `suite` (quick / standard / full) or an explicit `modules` array. Returns the full scan summary. |

## Example prompts (Claude Code)

> "Use gatetest to run a quick scan on this repo and tell me what's wrong."

Claude Code will call `gatetest_scan { suite: "quick" }` and get back a
structured summary it can reason about.

> "Run only the security and secrets modules on /Users/me/myrepo."

Claude Code calls `gatetest_scan { projectRoot: "/Users/me/myrepo",
modules: ["security", "secrets"] }`.

> "List every gatetest module you have."

Claude Code calls `gatetest_list_modules` and shows you the catalog.

## Wire protocol notes (for integrators)

- **Transport**: stdio (newline-delimited JSON over stdin/stdout).
- **Protocol**: JSON-RPC 2.0.
- **MCP protocol version**: `2024-11-05`.
- **Diagnostics**: written to stderr only — stdout is the protocol channel.
- **Zero dependencies**: per Bible Aggressive Stack rule. The server is
  implemented in pure Node.js.

### Methods supported

| Method | Purpose |
|--------|---------|
| `initialize` | Handshake. Returns protocol version + capabilities + server info. |
| `tools/list` | Returns all available tools and their input schemas. |
| `tools/call` | Invokes a tool with arguments. |
| `ping` | Keepalive — returns `{}`. |
| `notifications/initialized` | Absorbed; no response. |

### Error codes

Standard JSON-RPC 2.0:

| Code | Meaning |
|------|---------|
| -32700 | Parse error (malformed JSON) |
| -32600 | Invalid request (not JSON-RPC 2.0) |
| -32601 | Method not found |
| -32602 | Invalid params |
| -32603 | Internal error |

Tool-level errors (bad arguments, scan failures) are returned as
`{ content: [...], isError: true }` inside a normal `tools/call` result,
not as JSON-RPC errors — this lets the agent surface the error message
to the user and react.

## Verifying it works

From a terminal:

```bash
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"gatetest_version","arguments":{}}}' \
  | gatetest mcp
```

You should see two JSON-RPC responses — the `initialize` handshake and a
version payload listing all 67 modules.

## Roadmap

| Tool | Status |
|------|--------|
| `gatetest_version` | shipped |
| `gatetest_list_modules` | shipped |
| `gatetest_scan` | shipped |
| `gatetest_explain_check` (deep-dive a single check by name) | planned |
| `gatetest_apply_fix` (run a single module's auto-fix) | planned |
| `gatetest_review_diff` (Claude-powered review of a git diff) | planned |
| `gatetest_query_memory` (query the codebase-memory moat) | planned |
