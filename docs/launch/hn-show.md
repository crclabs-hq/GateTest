# Show HN — GateTest

**Suggested submission title (max 80 chars):**

> Show HN: GateTest – 67-module code quality gate with an MCP server (kills SonarQube)

**Alternative titles** (keep one in reserve):

- "Show HN: I shipped 67 static-analysis modules as one zero-dep npm package"
- "Show HN: A code QA tool Claude Code can call as a native MCP tool"
- "Show HN: One CLI that replaces SonarQube, Snyk, ESLint, and 7 others"

**URL field:** `https://gatetest.ai`

**Submission body:**

---

Hey HN — I built GateTest because I was tired of duct-taping 10+ tools to ship a clean codebase. SonarQube for code quality, Snyk for deps, ESLint for style, hadolint for Dockerfiles, actionlint for CI, gitleaks for secrets, kube-score for k8s, tfsec for Terraform — different configs, different dashboards, different bills.

GateTest is **67 modules behind one CLI**. Zero npm dependencies. One JSON config. One scan, one decision: gate passes or gate fails.

```bash
npm install -g gatetest
gatetest --suite full
```

**What's in the 67 modules** — the full list is at gatetest.ai, but a few greatest-hits the competition genuinely doesn't have a unified answer for:

- **N+1 query detector** — ORM-agnostic, recognises the `await Promise.all(arr.map(...))` batched-ok pattern (so the "fix" doesn't keep flagging)
- **ReDoS** — catastrophic backtracking, alternation overlap, user-controlled regex construction (CWE-1333)
- **TLS bypass** — `rejectUnauthorized: false`, `verify=False`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, `ssl.CERT_NONE`
- **Trojan Source / homoglyph** — CVE-2021-42574 bidi-override chars, Cyrillic-in-Latin identifiers
- **Money-as-float** — flags `parseFloat(price)`, `Number(amount)`, money-named vars cast through `float()` in Python; library-aware (decimal.js / dinero.js / big.js / Python `decimal` mark the file safe)
- **PR size** — the unreviewably-large diff problem, with lockfile / minified / snapshot auto-exclude
- **Cron expression validator** — catches the silent-killer "Feb 31" bugs that never fire, across GitHub Actions, k8s CronJob, Vercel, node-cron, croner, APScheduler, Spring
- **Import cycles** — iterative Tarjan SCC, type-import-aware
- **Logging PII** — `console.log(password)`, `logger.info(req.body)`, template-string interp of bare sensitive identifiers
- **Stale feature flags** — `if (true)`, `if (false)`, SCREAMING_SNAKE flag-named const literals

**The actual unlock: it ships as an MCP server.**

Model Context Protocol is the spec Claude Code, Cursor, Cline, Windsurf, Continue, and Devin all speak. Add this to your `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "gatetest": { "command": "gatetest", "args": ["mcp"] }
  }
}
```

Restart your editor. The agent now has four tools:

- `gatetest_version`
- `gatetest_list_modules`
- `gatetest_scan` — run a suite or specific modules, get back a structured summary
- `gatetest_explain_check` — given (module, checkId), returns what it means, why it matters, vulnerable + safe examples, fix steps, CWE reference

So when Claude finds something it can ask us "what is this and how do I fix it?" and write the patch immediately. No copy-paste, no context loss.

As far as I know **no other code-quality vendor has shipped an MCP server**. SonarQube, Snyk, Codacy, CodeClimate, DeepSource — checked at the time of posting, none of them.

**Stack:**

- Node.js 20+. Pure JavaScript core. TypeScript on the website only.
- Zero npm dependencies. Hand-rolled JSON-RPC 2.0 for MCP, hand-rolled Stripe API calls (no `stripe` package), hand-rolled GitHub API calls. The CLI is 100% installable on a clean box with just Node.
- 1000+ tests, all `node --test` (no Jest, no Vitest).
- MIT licensed.

**Pricing:**

- CLI: free.
- Web scans on gatetest.ai: pay-on-completion via Stripe ($29 quick / $99 full / $199 with auto-fix PR). Customer is only charged after the scan delivers — Stripe Payment Intent with manual capture.

**Demo it locally:**

```bash
npm install -g gatetest
gatetest --suite quick --project /path/to/your/repo
gatetest --help
```

**Or have an agent demo it:**

After wiring the MCP server, ask Claude Code: *"use gatetest to run a quick scan on this repo and explain anything it finds."*

**Repo:** https://github.com/ccantynz-alt/gatetest

Happy to answer anything — module internals, the MCP wire, the zero-dep philosophy, the pay-on-completion model. I'm the only person working on this so the latency on architectural questions is whatever it takes to type.

---

## After-the-post tactical notes

- Pin a top comment immediately with: clarification on what "kills SonarQube" means (we don't do code-coverage, that's the boundary), and a link to the MCP docs.
- Watch for "but Semgrep does that" comments — answer honestly: Semgrep is great, but it's a rule engine you write rules for. GateTest is 67 pre-built rules with vendor-specific awareness (Prisma N+1, dinero.js money safe-harbour, Stripe webhook spec compliance, etc.). They are different products with different effort profiles.
- Watch for "but you have <2k stars" comments — answer: today is launch day. Star us if it's useful.
- Be honest about what we don't do: we don't run tests, we don't do code coverage, we don't run mutation testing on JVM (we run it on JS). Be honest, be specific, be confident.

## What HN comments are LIKELY to surface (rehearse answers)

1. **"How is this different from Semgrep / Sonar / Snyk?"**
   - Unified install. One config. Pre-built rules with vendor-specific
     awareness. MCP server.
2. **"Why no dependencies? Doesn't that mean reinventing everything?"**
   - Yes, deliberately. Means we install on any Node 20+ machine in <2s with no
     `npm install` step in CI. Worth the dev cost.
3. **"What's the false-positive rate?"**
   - We dogfooded against our own codebase: every error-severity hit either a
     real bug we fixed, or required a `// <module>-ok` suppression with a
     written rationale. See `CHANGELOG.md` for the v1.41 dogfood pass.
4. **"Can I write custom rules?"**
   - Yes — drop a JS file into `.gatetest/modules/` extending `BaseModule`.
     Documented in README.
5. **"Does it work in CI?"**
   - Yes — `gatetest --sarif` for GitHub Security, `--junit` for Jenkins.
     SARIF / JUnit reporters ship in v1.41.
6. **"Will this work with Python / Go / Rust / Java?"**
   - We have universal-language checkers for Python, Go, Rust, Java, Ruby,
     PHP, C#, Kotlin, Swift. The JS/TS coverage is deepest (we're a Node
     project) but the universal checkers cover common shapes across languages.
