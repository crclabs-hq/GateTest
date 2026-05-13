# PR to `punkpeye/awesome-mcp-servers`

**Repo:** https://github.com/punkpeye/awesome-mcp-servers

**PR title:**

> Add gatetest — 67-module code-quality scanner exposed as an MCP server

**PR body:**

---

Adds GateTest to the list under a new **Code Quality / Security Analysis** section
(or whichever existing section the maintainer feels is the best fit — happy
to relocate).

GateTest is an MCP server that exposes a 67-module code-quality / security
analyser. Designed for AI dev agents — Claude Code, Cursor, Cline, Windsurf,
Continue — so when an agent finds an issue it can ask GateTest "what does
this mean and how do I fix it?" and get a structured answer back.

Four tools today:

- `gatetest_version` — capability discovery
- `gatetest_list_modules` — catalog of 67 modules
- `gatetest_scan` — run a suite or specific modules, returns structured summary
- `gatetest_explain_check` — explanation + fix recipe per check

Zero npm dependencies. Pure Node.js. Protocol 2024-11-05.

**Install:**
```bash
npm install -g gatetest
```

**Config:**
```json
{
  "mcpServers": {
    "gatetest": { "command": "gatetest", "args": ["mcp"] }
  }
}
```

**Repo:** https://github.com/ccantynz-alt/gatetest
**Homepage:** https://gatetest.ai
**Docs:** https://github.com/ccantynz-alt/gatetest/blob/main/docs/MCP.md

---

## Diff to apply to README.md

Find an appropriate section heading (suggested: "Code Quality / Security
Analysis" — add new section if it doesn't exist; alphabetical within).

Add this line:

```markdown
- [gatetest](https://github.com/ccantynz-alt/gatetest) - 🟢 - 🏠 - Code quality + security analyser. 67 modules behind one CLI: SSRF, ReDoS, TLS bypass, money-as-float, Trojan Source, N+1 queries, cron-typo detection, import cycles, PR-size enforcement, etc. Zero deps. Tools: scan, explain check.
```

(Emoji legend from awesome-mcp-servers conventions — 🟢 = stable, 🏠 = local-only.
If their conventions have shifted, defer to the maintainer.)
