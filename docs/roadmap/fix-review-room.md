# The Fix Review Room — a genuinely differentiated PR-iteration feature

**Status:** researched + designed 2026-07-20, not built. This is a roadmap document, not a build plan for the next session — Craig's explicit call was research + full design this session, build later, since it's a multi-week effort with a real prerequisite (see Phase 0).

## Why this, why now

Craig's ask: developers should be able to review and iterate on a GateTest-generated fix PR *through the website* — not a dead end, not "here's your PR, good luck." Competitive research (CodeRabbit, Greptile, Qodo Merge, Sourcery, GitHub Copilot) found that **every one of them does PR iteration exclusively as a comment thread on the git host** (`@coderabbitai fix this`, `/improve`, Copilot's draft-comment flow). None ship a dedicated web UI for it. GateTest already has a website, a persistent scan-history dashboard, and customer auth (GitHub/GitLab/Google OAuth) — building the iteration loop *there* while still syncing to the PR is mechanically different from anything a competitor ships today, not just a repaint of a feature that already exists elsewhere.

## What already exists (confirmed by direct code audit — don't rebuild this)

- **A working auto-fix pipeline** that opens a real GitHub PR on Scan+Fix/Forensic purchase: `website/app/api/scan/fix/route.ts` → clustering/fix-cap → per-file iterative Claude fix loop with retries → syntax gate → mutation guard → cross-fix scanner re-validation → test generation → (tier-gated) architecture annotation, pair-review, CISO report → PR opened via `website/app/lib/gluecron-client.ts`.
- **Idempotent PR-comment posting** from the free/webhook flow: `src/core/host-bridge.js`'s `upsertPrComment()` finds a prior GateTest comment via a hidden HTML marker and PATCHes it in place instead of stacking new comments. Genuinely good, working infrastructure — see Phase 0 below for why it's not what the paid flow uses today.
- **Customer accounts + scan history**: `website/app/lib/customer-session.ts` (HMAC-signed + AES-256-GCM-encrypted cookie, GitHub/GitLab/Google OAuth) and `website/app/dashboard/page.tsx` (`ScanRecord` list: repo, tier, status, score, date, per-module breakdown).
- **A general "CI failed, try to fix it" watcher**: `.github/workflows/ai-ci-fixer.yml` + `scripts/ai-ci-fixer.js`, triggered by `workflow_run` webhook failures, with branch-rotation retry (`-attempt-2` through `-attempt-10`). This is the closest existing thing to "resubmit," but it's a free/opt-in GitHub Action (needs the customer's own `ANTHROPIC_API_KEY`), triggers on *any* red workflow run (not specifically "the fix-PR GateTest opened just failed CI"), always opens *yet another new* PR rather than pushing to the one it's nominally retrying, and is completely invisible from the website.

## Confirmed gaps (the real work)

1. **No in-app PR view, anywhere.** `scan/status/page.tsx` renders a bare `<a href={prUrl}>` pointing off-site to GitHub. No diff, no CI status, no re-scan-of-the-PR result inside GateTest itself.
2. **No iterate-on-the-same-PR loop.** The "Re-fix" button always does `branchName = \`gatetest/auto-fix-${Date.now()}\`` — a brand-new branch and PR every time, discarding whatever happened to the previous attempt. There's no way to push an additional commit to an existing PR's branch, and no request field for "here's why the last attempt failed, try again with this context."
3. **The dashboard tracks scans, not PRs.** `ScanRecord` has no `pr_url` or fix-status field — a returning customer has no persistent "my open fix PRs across all my repos" view.
4. **Two divergent PR-creation implementations** that any of this would need to reconcile first — see Phase 0.

## Phase 0 (prerequisite) — reconcile the two PR-creation code paths

The website's paid fix flow (`gluecron-client.ts`) and the CLI/CI flow (`src/core/host-bridge.js` + `github-bridge.js`/`gluecron-bridge.js`) are two separately-maintained implementations with overlapping but not identical behavior. Concretely: the website flow posts several separate plain-POST bot comments per fix run (verification, architecture, pair-review, confidence — one POST each), while `HostBridge.upsertPrComment()` already solves exactly this with an idempotent PATCH-in-place pattern, circuit breaker, and retry logic — none of which the website flow uses.

**Before building anything in Phase 1+, extend `HostBridge` into the website's fix route** (or otherwise unify on one PR-interaction layer) rather than building a new iteration feature on top of the weaker client. Building Phase 2 (push-additional-commit) on the current `gluecron-client.ts` would mean re-solving idempotency/retry problems `HostBridge` already solved.

## Phase 1 — in-app PR view (smallest high-value slice)

Show the fix PR's diff, live CI status, and re-scan result *inside* GateTest — closes gap #1 and #3 in one slice (add `pr_url` + fix status to the scan record the dashboard already renders). No chat, no iteration yet — just "don't make the developer leave the site to see what happened." Uses existing session-auth (`customer-session.ts`) and dashboard infrastructure; the new surface area is a PR-detail page + a data field, not new auth/infra.

## Phase 2 — iterate on the *same* PR

The mechanical prerequisite for "resubmit": push an additional commit to the existing PR branch instead of always creating a new one, and accept prior-attempt context (CI failure log, developer free-text feedback) as fix-loop input. Depends on Phase 0's unified PR layer to do this safely/idempotently.

## Phase 3 — the Fix Review Room itself

A persistent, per-finding chat UI scoped to one PR's one finding — not a GitHub comment thread. Each iteration should surface:
- **The regression test's actual pass/fail output**, not prose. Competitor research flags fabricated-sounding AI explanations ("this is safe") as the #1 trust-killer in AI code review generally — GateTest already generates a regression test per fix; today that evidence only shows up in CI logs. Surfacing it inline in the chat, as evidence rather than assertion, is a small build with outsized trust payoff.
- **A visible confidence-score delta** between attempts (2/5 → 4/5, with the reasoning delta) — Greptile already shows a static per-finding confidence score; showing it *move* across a chat-driven iteration is the differentiated presentation, not a novel concept.
- **A capped retry count** and **explicit human-accept required before merge** — never auto-merge. Competitor research's clearest failure-mode warning: fixes that compile but are logically wrong, or that resolve one issue while silently breaking another, are what kills trust in AI code review tools generally. Don't repeat that pattern here.

## Phase 4 (bigger bet, separately scoped — not a build-now item)

**Cross-customer pattern alerts** — "this exact bug pattern hit 3 other repos this month." GateTest is multi-tenant with an existing telemetry pipeline (`src/core/scan-telemetry.js`); single-install competitors (Sourcery, Copilot) structurally cannot build this — it's a moat only a multi-tenant SaaS with scan history can have. Needs real anonymization/privacy design (never surface another customer's code, only aggregate pattern-class signal) before any code — flagged as needing its own dedicated scoping pass given the sensitivity, not something to fold into Phase 1-3.

## Explicitly NOT the differentiator (worth doing eventually, don't market as novel)

**Repo-level "Learnings" memory** (remembering a repo's conventions/false-positive corrections across scans to reduce repeat nitpicks) — both CodeRabbit and Qodo Merge already ship this. Worth building for parity at some point (accept/reject signal from Phase 3's iteration loop → periodic summarization job → inject into future fix prompts — no new infra needed once Phase 3 exists), but should never be the headline pitch; it's catching up, not leading.

## Design principles carried through every phase (from competitor failure-mode research)

- Never show a "trust me, this is safe" explanation with no evidence backing it.
- Never silently let a fix resolve one issue while introducing another (the cross-fix scanner gate already does this check today — keep it in the loop for every iteration, not just the first attempt).
- Always show a real diff, not a summary of one.
- Cap retries — don't let a developer (or the AI) loop forever on a stuck fix.
- Human-accept required before merge, always. No auto-merge, ever, regardless of confidence score.
