# @gatetest/mcp-server

Connect Claude Code (and any MCP-compatible AI) to **GateTest's 91-module code quality engine**. Scan repos, run individual modules, auto-fix issues with Claude, and get Nuclear-tier diagnosis — all from inside your AI assistant.

## Install in 1 command

```bash
claude mcp add gatetest -- npx -y @gatetest/mcp-server
```

Or add to your Claude Code `settings.json` manually:

```json
{
  "mcpServers": {
    "gatetest": {
      "command": "npx",
      "args": ["-y", "@gatetest/mcp-server"]
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `scan_local` | Scan a local directory with GateTest's full engine |
| `run_module` | Run one specific module (e.g. `secrets`, `tlsSecurity`) |
| `list_modules` | List all 91 modules with descriptions |
| `check_health` | Verify the engine loaded correctly |
| `fix_issue` | AI-driven fix for a single finding *(needs `ANTHROPIC_API_KEY`)* |
| `compose_pr` | Render a PR body markdown for a batch of fixes |
| `explain_finding` | Nuclear-tier Claude diagnosis of a finding *(needs `ANTHROPIC_API_KEY`)* |
| `audit_log` | Query local scan history from the memory store |
| `compare_repos` | Compare finding patterns across scan history |

## Example usage in Claude Code

Once added, ask Claude things like:

- *"Run a full GateTest scan on /path/to/my/project"*
- *"Check just the TLS security and cookie security modules on this repo"*
- *"Explain this finding: [paste the finding text]"*
- *"Fix this issue in auth.js: rejectUnauthorized is set to false"*

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` | Optional | Enables `fix_issue` and `explain_finding` tools |

## What GateTest covers

91 modules across:
- **Security** — secrets, TLS, SSRF, cookie security, web headers, SQL injection vectors
- **Reliability** — race conditions, resource leaks, retry hygiene, async iteration bugs
- **Code quality** — import cycles, dead code, money float bugs, datetime bugs
- **Infrastructure** — Terraform/IaC, Kubernetes, Dockerfile, CI security
- **AI safety** — prompt injection, bundled API keys, deprecated models
- **And more** — ReDoS, homoglyphs, cron expressions, feature flag hygiene...

GateTest replaces SonarQube, Snyk, ESLint, and 10+ other tools with a single unified gate.

## Links

- [gatetest.ai](https://gatetest.ai) — web scan & pricing
- [GitHub](https://github.com/crclabs-hq/gatetest) — source
- [Issues](https://github.com/crclabs-hq/gatetest/issues)
