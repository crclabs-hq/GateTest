# Show HN — FINAL (single source of truth for the launch)

> **Boss Rule #8 — public-facing communication.** This is a DRAFT for Craig
> to review, edit, and post himself at the chosen hour. Nothing here is
> posted automatically.
>
> This file supersedes the earlier `docs/show-hn-draft.md` and
> `docs/launch/hn-post.md`, which had drifted and contradicted each other
> and the live product (wrong module count, an invented per-fix pricing
> model, "live on Marketplace" before approval, an `npm install` command
> for a package that isn't published). Those two files were removed so a
> reader who clones the repo can't find a claim we don't honour.
>
> **Honesty rule for this launch:** we do not promise anything we cannot
> deliver right now. Every number and command below was verified against
> the live product on 2026-06-04.

---

## Verified facts (re-check the starred ones at launch hour)

| Fact | Value | Notes |
|---|---|---|
| Module count | **110** | Matches the live gatetest.ai copy and `node bin/gatetest.js --list`. |
| AI model | **Claude Sonnet 4.7** | Per CLAUDE.md v1.46. |
| Pricing | **$29 / $99 / $199 / $399 one-time + $49/mo Continuous** | No per-fix billing. No "Starter" tier. No monthly fix credit. |
| $399 tier name | **Forensic** | Renamed from "Nuclear" in v1.45. |
| npm package | **NOT published** ⭐ | `npm view gatetest` → 404. Post must use `npx github:...` or the Action, never `npm install -g gatetest`, until it's published. |
| GitHub Marketplace | **In review** ⭐ | Do not claim "live on the Marketplace." Install the Action by ref for now. |
| gatetest.ai live + scan works ⭐ | verify in incognito before posting | |
| Stripe test checkout works ⭐ | verify with 4242 4242 4242 4242 before posting | |

---

## Title (lead with #1)

1. `Show HN: GateTest – 110 QA modules in one scan, opens an auto-fix PR for what it finds`
2. `Show HN: GateTest – one CI gate instead of SonarQube + Snyk + ESLint + Lighthouse + axe`
3. `Show HN: GateTest – pay-per-scan code QA that opens the PR that fixes what it finds`

Specific + action-oriented + no "kills X" trash-talk in the title (HN reacts
badly to that even when the Bible loves it).

## URL to submit

`https://gatetest.ai` — the website is the demo. The repo link goes in the body.

## Body (copy-paste ready)

```
Hi HN — I'm Craig. I built GateTest because I was tired of duct-taping
SonarQube + Snyk + ESLint + Lighthouse + axe + half a dozen others into
every project, each with its own config, dashboard and bill.

GateTest runs 110 analysis modules in one scan — security, supply chain,
code quality, performance, accessibility, SEO, infra (Docker/Terraform/
K8s/CI), and an AI-app safety set — then, on the paid tiers, uses Claude
to open a pull request that fixes what it found. You review and merge; it
never auto-merges. Every fix passes a syntax gate and a re-scan gate
before the PR opens.

Try it free, no signup, no install: https://gatetest.ai (paste a repo or
a live URL).

Run the CLI locally (MIT-licensed, free):
  npx github:crclabs-hq/GateTest --suite quick ./

Pricing is per-scan, one-time, not a subscription:
  $29  Quick    — 4 fast modules, scan-only
  $99  Full     — all 110 modules, scan-only
  $199 Scan+Fix — auto-fix PR + a second Claude pair-reviews each fix
  $399 Forensic — per-finding diagnosis + cross-finding attack-chain
                  correlation + a CTO-readable executive summary
($49/mo "Continuous" scan-every-push is the one subscription, for teams
who want every push gated.)

What's honestly NOT there yet:
  - The npm package isn't published — use npx or the GitHub Action.
  - The GitHub Marketplace listing is still in review, so for now you
    install the Action by ref, not from the Marketplace.
  - Mutation testing + chaos/fuzz run via the GitHub Action only — they
    need a CI runner and a real browser, so the website Forensic scan
    can't do them (Chromium won't launch in a serverless function).
  - We don't beat CodeQL on deep multi-hop taint analysis. We win on
    breadth, speed, and the auto-fix — not on out-depthing a specialist
    in its one lane.

We dogfood it: every push to the repo runs through GateTest's own gate,
and there are real-repo proof runs (with Anthropic spend numbers) in
/docs/proofs. The whole project's source of truth, including the full
Known-Issues table, is the CLAUDE.md in the repo.

Source: https://github.com/crclabs-hq/GateTest

Skeptical comments very welcome — I'd rather hear what's broken now than
after someone files a refund.
```

## First comment — post within ~5 minutes of submitting

```
Author here. The objections I expect, with honest answers:

1. "Isn't this just 110 linters and a report?" The report isn't the
product — the fix PR is. Most tools stop at findings. We spend the
engineering effort on making the patch actually mergeable: AST/rule
layers first, Claude only on patterns nothing deterministic caught,
then a syntax + re-scan gate before the PR opens.

2. "How does the Anthropic bill not bankrupt you?" Deterministic layers
handle most findings for free; Claude only fires on the novel ones. The
$29 and $99 tiers don't call Claude on the fix path at all. There's a
hard per-scan spend cap in code (budget-tracker.js) — $12 on Scan+Fix,
$30 on Forensic — so one runaway scan can't drain the balance.

3. "vs Snyk Autofix / Copilot Autofix / DeepSource?" Each deepens one
lane (Snyk: dep CVEs; Copilot: CodeQL findings). The bet here is
unification + an iterative self-validating fix loop + cross-finding
correlation + a regression test per fix + pair-review. If a specialist
beats us in its lane (CodeQL on taint does), I'll say so.

4. "Show me a real PR." /docs/proofs has real runs against external
codebases with before/after reports. Fork the repo and run it on us.

Two things that aren't live yet and I'd rather say plainly: the npm
package isn't published (use npx / the Action), and the Marketplace
listing is still in review.
```

## More prepared replies (keep them factual, concede where true)

**"Why per-scan instead of a subscription?"**
> Subscription pricing penalises the careful team that scans twice a month
> and subsidises the team that scans every commit. Per-scan aligns price
> with work done. Continuous ($49/mo) is the one subscription, for teams
> that want every push gated.

**"What if my scan crashes after I've paid?"**
> Email hello@gatetest.ai within 7 days — we re-run at no cost or credit
> you. Cash refunds are discretionary, not automatic. We moved off
> hold-then-capture because it invited "pay, read the report, dispute"
> chargeback abuse; per-scan upfront with support exceptions is what most
> digital-services SaaS do.

**"Why trust an AI to write fixes?"**
> It never auto-merges — it opens a PR you review. The fix loop is layered
> (AST → rule recipe → cached pattern → Claude), and each fix passes a
> syntax gate and a scanner re-validation gate before the PR opens. On
> $199+ a second Claude pair-reviews every fix on a 4-axis rubric.

**"Is it open source?"**
> The CLI/engine is MIT in the repo — run the full 110-module scan locally
> for free. The hosted auto-fix layer (the Claude calls, the PR
> composition) is the paid product.

## Launch-hour checklist

1. ⭐ `https://gatetest.ai` loads and a Quick scan completes, in incognito,
   on desktop **and** phone.
2. ⭐ One real Stripe checkout end-to-end with `4242 4242 4242 4242` reaches
   a result.
3. ⭐ Run `npx github:crclabs-hq/GateTest --suite quick` yourself once —
   confirm the exact command in the post works cold.
4. Have Vercel logs tailing so you see 500s live.
5. Post the body, then the first comment within ~5 minutes.

## What NOT to do on HN

- No "world-class / 10x / industry-leading" superlatives.
- No revenue or customer numbers we don't have.
- Don't ask for upvotes anywhere (instant death).
- Don't change the URL after posting (treated as URL swapping).
- Don't reply "thanks" to everything — substantive replies only.
- Don't fight trolls; answer the real question underneath, concede what's
  fair, move on.
- Don't delete negative comments — engage honestly.

## Best window

Tue/Wed/Thu, ~8–10am Pacific. Avoid Mondays, weekends, and the day after a
big tech announcement (WWDC, a major model launch, etc.).
