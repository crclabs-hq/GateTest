# GateTest — GitHub Marketplace Listing

> **Craig action required:** Go to github.com/apps/GateTestHQ → Edit listing → paste the content below.

---

## Short description (≤160 chars)

110-module QA gate that finds real bugs — race conditions, money in floats, CI supply-chain attacks. Auto-fix PR on every failure.

---

## Long description (Markdown, rendered in Marketplace)

**GateTest replaces 10+ fragmented QA tools with one gate. 110 modules. One decision.**

Your CI runs ESLint, Snyk, SonarQube, and six other tools separately. GateTest runs all of them — plus 60 modules that don't exist anywhere else — in a single pass, and opens a pull request with the fixes.

### What it catches that others miss

| Pattern | Why it slips through |
|---|---|
| `parseFloat()` on billing amounts | No other static tool checks variable names against precision |
| `findOne → create` with no transaction | N+1 check tools don't look for the lost-update pattern |
| Credentials > 90 days (git-dated, not guessed) | Other tools check presence — not rotation age |
| `forEach(async ...)` — errors swallowed | ESLint rules exist but are off by default and fragmented |
| Unpinned Action + write GITHUB_TOKEN + shell injection | Three independent findings that combine into a CI takeover |
| Circular imports (Tarjan SCC) | `madge` is a separate install with no gate integration |

### Proven on real codebases

Four production repos scanned for our Hall of Scans:
- **754 errors** in a scheduling platform — 2 critical chains, both exploitable in <30 min
- **649 errors** in a cron service — hardcoded secret + missing from `.env.example` = rotation is structurally impossible
- **37 errors** in GateTest itself — found before shipping, all fixed

### Tiers

| Tier | Price | What you get |
|---|---|---|
| Quick Scan | $29 | 4-module preview: syntax, lint, secrets, code quality |
| Full Scan | $99 | All 110 modules, scan-only |
| Scan + Fix | $199 | 110 modules + auto-fix PR + pair-review agent + architecture annotator |
| Forensic | $399 | Everything + per-finding Claude diagnosis + cross-finding attack chain correlation + executive summary |

### How it works

1. Install on any public or private repo (or entire org)
2. Push code or open a PR — GateTest hooks into GitHub webhooks automatically
3. Results appear as inline annotations on the diff, commit status, and PR comment
4. If ANTHROPIC_API_KEY is set on your org, GateTest opens an auto-fix PR — you review, you merge

### Privacy

Code is scanned in memory and never stored. No database of your codebase. No training on your code.

---

## Category

**Code quality** (primary)  
**Security** (secondary)

---

## Pricing model

Per-scan payment (not subscription). Customer pays at checkout for the tier they want.

---

## Screenshot specifications

> Craig: use the Vercel preview URL on any PR to grab these screenshots.

1. **Scan in progress** — `/scan/preview` page with the terminal progress animation running on `vercel/next.js`
2. **Results — errors found** — `/scan/preview` after scan completes showing 3-5 real findings with severity badges
3. **PR comment** — GitHub PR with GateTest's inline findings annotation and the summary comment
4. **Hall of Scans** — `/scans` page showing the 754-error Crontech scan card with the supply-chain attack chain
5. **Pricing grid** — `/#pricing` showing all 4 tiers side by side

---

## Categories to tick in GitHub App settings

- [x] Code review
- [x] Code quality
- [x] Security
- [x] Continuous integration
- [x] Testing

---

## App name in Marketplace

**GateTest — 110-Module QA Gate**

---

## Website

https://gatetest.ai

---

## Support URL

https://gatetest.ai  
(or mailto:hello@gatetest.ai)
