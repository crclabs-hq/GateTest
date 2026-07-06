# Show HN Draft — GateTest

**Status:** DRAFT for Craig. Posting is Craig's action (public-facing = Boss Rule #8). This is a *fresh* post — the product is night-and-day from the 3-upvote post weeks ago (no MCP, no 22 tools, no eyes/ears/hands). Lead with the MCP angle; the MCP ecosystem is where the intent is now.

**Timing:** post the same day the remote endpoint is confirmed live, so web/mobile readers can try it with zero install. Weekday morning US time. Be at the keyboard for the first 2 hours to answer.

---

## Title options (pick one)
1. **Show HN: GateTest – Give Claude verified eyes, ears, and hands on your codebase**
2. Show HN: An MCP server that lets Claude screenshot your app, read prod errors, and prove its fix worked
3. Show HN: GateTest – 120-module code scanner as an MCP server (free to scan any URL or repo)

Recommend #1 — "eyes, ears, hands" is concrete and the phrase travels.

---

## Body

> I built GateTest because the thing that actually makes AI code review unreliable isn't the model's intelligence — it's that the model is blind, deaf, and can't check its own work. It can't see the rendered page, it doesn't know what errors real users are hitting, and when it says "fixed" that's a claim, not evidence.
>
> GateTest is an MCP server that closes those three gaps:
>
> - **Eyes** — screenshot any live page (or localhost), diff it against a baseline.
> - **Ears** — pull the top production errors from Sentry / Datadog / Rollbar with exact file:line.
> - **Hands** — after a fix, re-scan the exact finding and run your test suite, so "fixed" means verified, not asserted.
>
> Under it is a 120-module deterministic scan engine (security, reliability, race conditions, N+1 queries, PII-in-logs, TLS bypasses, cron typos, money-in-float, ~100 more classes) — fast, repeatable, zero tokens. The MCP tools are the delivery vehicle; the engine is the moat.
>
> **Free with no key, right now:** point it at any live URL or any public GitHub repo and it'll scan it. If you use Claude Desktop or claude.ai, you can add the remote endpoint (`https://gatetest.ai/api/mcp`) in ~30 seconds, no install. Claude Code / Cursor: `npx -y @gatetest/mcp-server`.
>
> It's early — I'm a solo founder, no customers yet, and I'd rather hear it's wrong from you now than find out later. Try `scan_url` on something you own and tell me what it gets wrong.

---

## First founder comment (post immediately after submitting — this matters more than the post)

> A few honest notes since "AI finds your bugs" is a crowded, over-promised space:
>
> **What's actually different:** most AI code tools are a prompt around a diff. GateTest is a real 120-module engine that runs the same checks every time and burns no tokens doing it — so it's deterministic (a gate can block a merge on it) and cheap to run exhaustively. The LLM only comes in for the parts that genuinely need judgment: explaining a finding, writing the fix, and reviewing it.
>
> **What it does NOT do:** it won't fix an architecture with no save path or a stubbed auth layer — those are design decisions, not bugs a scanner finds. It's a generation-quality and reliability tool, not an architect.
>
> **Why MCP:** as models get smarter, "AI reads code and spots bugs" gets commoditized. What doesn't: giving the model senses (see the page, hear prod) and proof (verify the fix). A smarter Claude makes those *more* useful, not less.
>
> **On the free tools:** `scan_url` and `scan_repo` need no key and no account — that's not a trial gimmick, it's the honest front door. The $29/mo is for the deep scan + auto-fix + the eyes/ears/hands tools.
>
> Stack, module list, and the "what it can't do" caveats are all in the repo. Genuinely want the harsh feedback.

---

## Prep before posting
- [ ] Remote endpoint live + `scan_url` works from a fresh claude.ai session
- [ ] README leads with eyes/ears/hands + the 4 install paths
- [ ] A couple of real before/after fix PRs linked in the repo (trust artifacts — convert better than any claim)
- [ ] Craig free for 2 hours after posting to reply fast
