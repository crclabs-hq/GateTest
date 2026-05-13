# Cursor MCP docs — example PR

**Cursor maintains MCP examples in their public docs.** The exact docs
repo / page may shift; current canonical home is:
https://docs.cursor.com/context/model-context-protocol

If their docs are sourced from a public repo (most Cursor docs are
versioned on GitHub), submit a PR adding GateTest to the "Example
servers" or "Recommended servers" section.

If their docs aren't open-source: file a request via their developer
support channel pointing at GateTest's MCP docs.

## Suggested entry

````markdown
### GateTest

Code quality + security scanning. 67 modules covering everything from
SSRF and ReDoS to N+1 queries and money-as-float bugs. Includes a
`gatetest_explain_check` tool so the agent can fetch a fix recipe for
any finding.

**Install:**
```bash
npm install -g gatetest
```

**Cursor MCP config** (`~/.cursor/mcp.json` or in-app settings):
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

**Repo:** https://github.com/ccantynz-alt/gatetest
**License:** MIT
````
