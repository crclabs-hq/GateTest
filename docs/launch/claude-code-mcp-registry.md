# Anthropic MCP server registry — submission

**Where to submit:** https://modelcontextprotocol.io/servers — submission
mechanism evolves; check the docs at post-time. As of writing the spec
maintains an examples list in the `modelcontextprotocol/servers` GitHub
repo. A PR there is the canonical route.

**Repo (if PR):** https://github.com/modelcontextprotocol/servers

**Entry data:**

| Field | Value |
|-------|-------|
| Name | GateTest |
| Description | 67-module code quality + security scanner. Catches SSRF, ReDoS, TLS bypass, N+1 queries, cron typos, money-as-float, Trojan Source, import cycles, and more. Zero dependencies. |
| Repository | https://github.com/ccantynz-alt/gatetest |
| Homepage | https://gatetest.ai |
| Language | Node.js |
| Install | `npm install -g gatetest` |
| Run | `gatetest mcp` |
| License | MIT |
| Categories | Code Quality, Security, Developer Tools |
| Tools | gatetest_version, gatetest_list_modules, gatetest_scan, gatetest_explain_check |

**Markdown snippet for the registry README:**

```markdown
### [GateTest](https://github.com/ccantynz-alt/gatetest)
67-module code quality and security scanner. Replaces SonarQube, Snyk,
ESLint, hadolint, actionlint, kube-score, gitleaks, tfsec, ts-prune,
and 10+ other tools with a single zero-dependency CLI. Includes a
`gatetest_explain_check` tool that returns a structured fix recipe
for any finding, so agents can write the patch immediately.

- **Install:** `npm install -g gatetest`
- **Config:** `{ "command": "gatetest", "args": ["mcp"] }`
- **Tools:** `gatetest_scan`, `gatetest_explain_check`,
  `gatetest_list_modules`, `gatetest_version`
- **Stack:** Node.js 20+, MIT, zero npm dependencies.
```
