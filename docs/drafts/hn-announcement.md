# HN Announcement Draft — Eyes, Ears & Hands for AI Coding Agents

**FOR CRAIG TO POST — requires Boss Rule #8 authorization (public-facing comms)**

---

## Option A — Show HN post (recommended)

**Title:**
> Show HN: GateTest MCP – give Claude eyes (screenshot), ears (prod errors), hands (verify fix)

**Body:**
```
I've been building GateTest (gatetest.ai) — a 120-module code quality gate
that runs as an MCP server inside Claude Code, Cursor, Windsurf, etc.

The problem I kept running into: AI agents write UI blind, never hear the app
fail, and claim "fixed" without proof. So I built three new tool families into
the MCP server:

👁 EYES — capture_screenshot returns a real JPEG of the rendered page. Claude
can actually see what it built — nav, layout, broken CTAs, font sizes that are
too small. Works with localhost:3000.

👂 EARS — get_production_errors pulls the top errors from Sentry/Datadog/Rollbar
with exact file:line and occurrence counts. run_live_checks hears JS errors,
console warnings, CSP violations, and slow API endpoints on any live URL.

🤝 HANDS — verify_fix re-runs the relevant gate modules on exactly the files
you edited and returns a hard ✅ FIX VERIFIED or ❌ NOT VERIFIED. No more
"I think that fixed it."

Install in one command:
  claude mcp add gatetest -- npx -y @gatetest/mcp-server

24 tools total. Stdio transport — no account, no webhook, no infra. The engine
runs in-process on your local filesystem.

Full tool reference and example prompts: github.com/crclabs-hq/GateTest/tree/main/packages/mcp-server
```

---

## Option B — shorter, punchier (if HN prefers brevity)

**Title:**
> Show HN: MCP server that gives Claude eyes (see pages), ears (prod errors), hands (verify fixes)

**Body:**
```
Three things AI coding agents can't do natively:
1. See what the UI actually looks like after a change
2. Hear what's failing in production right now
3. Prove a fix actually worked without assuming

GateTest MCP (open source, 24 tools) closes all three:
- capture_screenshot → real image of any URL including localhost
- get_production_errors → Sentry/Datadog/Rollbar with file:line
- verify_fix → hard ✅/❌ on exactly the files you edited

claude mcp add gatetest -- npx -y @gatetest/mcp-server

gatetest.ai / github.com/crclabs-hq/GateTest
```

---

## Claude Plugin Directory submission (Boss Rule #7 — Craig must submit)

The official registry is at: https://modelcontextprotocol.io/registry

To submit, Craig needs to:
1. Go to the registry submission page
2. Point it at `server.json` in the repo root (already updated this session with the new description + all 7 env vars documented)
3. The `name` field is `ai.gatetest.www/gatetest` — matches what was published in commit `1a5ecf4`

The `server.json` is already live on `main` — it just needs Craig to trigger the registry re-index or re-submit.

---

## Other distribution channels (all require Craig)

- **npm package update** — `packages/mcp-server/` has a separate `@gatetest/mcp-server` npm package at v1.0.0. Bumping its version and running `npm publish` from that directory would push the new README + description to npm. The package itself still works (the binary hasn't changed); this is cosmetic/discovery.
- **Twitter/X** — Short form: "We gave Claude eyes 👁 ears 👂 and hands 🤝. Screenshot live pages. Pull prod errors from Sentry. Prove fixes worked. One MCP server. claude mcp add gatetest -- npx -y @gatetest/mcp-server"
- **Claude Discord / community** — Drop in #mcp-servers or #show-and-tell with Option B text
