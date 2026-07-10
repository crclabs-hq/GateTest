# @gatetest/mcp-server

**Give Claude eyes, ears, and hands** — the three capabilities missing from every AI coding agent.

- **Eyes** — `capture_screenshot` returns a real image of the rendered page. Claude sees nav, layout, broken CTAs, tiny fonts. Works with `localhost`.
- **Ears** — `get_production_errors` pulls file:line from Sentry/Datadog/Rollbar. `run_live_checks` hears JS errors, CSP violations, API timeouts on any live URL.
- **Hands** — `verify_fix` re-runs the gate on exactly the files you edited and returns a hard ✅/❌. No more "I think that fixed it."
- **Root Cause** — `resolve_stack_trace` turns a minified bundle location into the original file:line via source maps. `blame_regression` finds which git commit introduced a specific line — read-only, never checks out or mutates the working tree.

24 tools. 120-module engine. Stdio transport — no account, no webhook, no infra.

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

Works with Claude Code, Cursor, Windsurf, Continue, Cline, and any MCP-compatible agent.

## Tools

### Core engine (local filesystem, no network, no API key)

| Tool | When to use |
|------|-------------|
| `scan_local` | Before opening a PR — 120 modules across security, reliability, code quality |
| `run_module` | One specific module (e.g. `secrets`, `tlsSecurity`, `importCycle`) |
| `list_modules` | See all 120 modules with descriptions |
| `check_health` | Verify the engine loaded + get the full agent workflow cheat-sheet |
| `audit_log` | Past scan history for a project path |
| `compare_repos` | Finding patterns across scan history |

### AI fix tools (needs `ANTHROPIC_API_KEY`)

| Tool | When to use |
|------|-------------|
| `fix_issue` | After `scan_local` identifies a specific error — AI writes the fix in place |
| `compose_pr` | Render a PR body for a batch of fixes |
| `explain_finding` | Forensic-tier Claude diagnosis: explanation, root cause, recommendation |

### Hosted API (scans via gatetest.ai, no local filesystem access needed)

| Tool | When to use |
|------|-------------|
| `scan_url` | Scan any live public URL — security headers, TLS, runtime errors, and more |
| `scan_repo` | Scan any public GitHub repo — quick-tier preview |
| `get_badge` | Embeddable quality badge for a README |
| `get_report` | Full result of the last scan this session |

### 👁 EYES — see the rendered page

| Tool | When to use |
|------|-------------|
| `capture_screenshot` | After every UI change — returns a real JPEG/PNG image Claude can see |
| `get_visual_diff` | After a visual regression scan — baseline vs current vs diff composite |

### 👂 EARS — hear what's breaking

| Tool | When to use |
|------|-------------|
| `run_live_checks` | After deploying locally — JS errors, console warnings, API health on any URL |
| `get_production_errors` | **Call first** — top Sentry/Datadog/Rollbar errors with file:line |

### 🤝 HANDS — prove the fix worked

| Tool | When to use |
|------|-------------|
| `verify_fix` | After every code edit — hard ✅ FIX VERIFIED or ❌ NOT VERIFIED |

### 🔬 ROOT CAUSE — know exactly what broke and why

| Tool | When to use |
|------|-------------|
| `resolve_stack_trace` | Paste a minified/bundled Error.stack — get back the original TS/JSX file:line via source maps |
| `blame_regression` | Find which git commit introduced a specific file:line (or rank candidates across several hits) — read-only |

Both are also CLI subcommands (`gatetest trace`, `gatetest blame`) backed by
the exact same engine — use them by hand or let Claude call them mid-fix-loop.

## Agent workflow

```
# Production incident
get_production_errors → scan_local → fix_issue → verify_fix → capture_screenshot

# Before a PR
scan_local → fix_issue → verify_fix

# After a UI change
capture_screenshot (before) → edit → capture_screenshot (after)

# Local dev check
run_live_checks { url: "http://localhost:3000" }
```

## Example prompts

Once installed, ask Claude:

- *"What are the top errors real users are hitting right now?"* → `get_production_errors`
- *"Show me what the pricing page looks like on mobile"* → `capture_screenshot { url: "...", width: 390 }`
- *"Did my auth.ts change actually fix the issue?"* → `verify_fix { path: "...", files: ["src/auth.ts"] }`
- *"Run a full GateTest scan on /path/to/my/project"* → `scan_local`
- *"Check what's failing on localhost:3000 right now"* → `run_live_checks { url: "http://localhost:3000" }`
- *"Fix this finding: rejectUnauthorized is set to false in auth.js"* → `fix_issue`

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` | Optional | Enables `fix_issue` and `explain_finding` |
| `SENTRY_AUTH_TOKEN` | Optional | `get_production_errors` — Sentry source |
| `SENTRY_ORG` | With Sentry token | Your Sentry org slug |
| `SENTRY_PROJECT` | With Sentry token | Your Sentry project slug |
| `DATADOG_API_KEY` | Optional | `get_production_errors` — Datadog source |
| `DATADOG_APP_KEY` | With Datadog API key | Datadog Logs API access |
| `ROLLBAR_READ_TOKEN` | Optional | `get_production_errors` — Rollbar source |

`get_production_errors` returns setup instructions when no credentials are configured — no error, just a 30-second guide.

## What the 120 modules cover

- **Security** — secrets, TLS bypass, SSRF, cookie config, web headers, SQL injection vectors, hardcoded URLs
- **Reliability** — race conditions, resource leaks, retry hygiene, N+1 queries, async iteration bugs
- **Code quality** — import cycles, dead code, money float bugs, datetime bugs, feature flag hygiene
- **Infrastructure** — Terraform/IaC, Kubernetes, Dockerfile, CI security, shell scripts
- **AI safety** — prompt injection, bundled API keys, deprecated models, AI guardrails
- **Visual & runtime** — visual regression, interactive element liveness, API health, console errors, cross-browser
- **And more** — ReDoS, homoglyphs, cron expressions, OpenAPI drift, log PII, TLS security...

## Links

- [gatetest.ai](https://gatetest.ai) — web scan, pricing, playground
- [GitHub](https://github.com/crclabs-hq/gatetest) — source
- [Issues](https://github.com/crclabs-hq/gatetest/issues)
