# GateTest — Product Hunt launch draft

**Status:** Ready to copy-paste. Aim for a **Tuesday or Wednesday, 00:01 PT** launch — PH traffic peaks in the first 12 hours and US Pacific is the most active timezone bucket. Avoid Mondays (industry-launch noise) and Fridays (weekend dropoff).

**Pre-launch checklist (24-48h before):**
- [ ] Pick a hunter — someone with PH followers who'll click "I made this" or post on your behalf. If solo, post yourself.
- [ ] Gather email list (HN waitlist, GitHub stars, existing customers) to nudge for upvotes between 00:01 and 02:00 PT.
- [ ] Schedule a 4-hour comment-monitoring block. PH conversion lives in the comment thread.
- [ ] Twitter/X cross-post primed for the moment the listing goes live (link goes in bio).

---

## TAGLINE (60 chars max — PH will truncate)

**Primary (60 chars):**
> One CI gate that replaces SonarQube, Snyk, Lighthouse + 10 more

**Backups:**
- `102 quality modules. One gate. Pay-on-completion.` (50)
- `The CI gate that gets cheaper as you use it` (44)
- `Replace 12 QA tools with one composite gate` (43)

Recommendation: **#1.** "Replaces SonarQube + Snyk" is the searchable, comparison-shaped hook. People who know SonarQube's pricing will click.

---

## DESCRIPTION (260 chars max — appears under the tagline)

> 102 static-analysis modules in one gate — security, accessibility, IaC, SQL migrations, prompt safety, money-float. Claude repairs the findings it can and ships a PR. Pay per scan ($29 / $99 / $199 / $399) or run the CLI free.

(259 chars)

**Backup (slightly shorter):**
> One GitHub Action runs 102 quality modules. Claude fixes what it can, opens a PR, ships regression tests pinned to each fix. Free CLI, pay-per-scan hosted. Replaces SonarQube + Snyk + ESLint + Cypress + Lighthouse + 8 others.

(245 chars)

---

## TOPICS (PH discovery tags — pick 3-4)

- **Developer Tools** (primary)
- **GitHub**
- **DevOps**
- **Productivity**
- (alt: **Code Review**, **No-Code**, **Open Source** — pick whichever PH offers)

---

## PRICING TAG

**Freemium** — CLI is MIT-licensed and free, hosted scans paid per-use.

---

## MAKER COMMENT (first comment — pin this; people read it before they upvote)

```
Hey PH, Craig here.

I built GateTest because I was tired of duct-taping 12 different
quality tools into every CI pipeline — SonarQube for code smells,
Snyk for deps, ESLint for style, Cypress for E2E, Lighthouse for
perf, axe for a11y — each with its own config, its own dashboard,
and its own bill. The setup tax was killing momentum on every new
project.

GateTest is one composite GitHub Action that runs 120 modules in
parallel. The interesting bit is the cost curve: deterministic
AST + rule-based layers run first (free, milliseconds). Claude
only runs on patterns nothing else has seen (paid, one shot).
Every Claude win is distilled into a reusable recipe — so the
next time the same pattern appears (your repo or someone else's),
it's handled for free.

The hosted version at gatetest.ai is pay-per-scan: $29 Quick,
$99 Full, $199 Scan + Fix (auto-fix PR + pair-review), $399
Forensic (Claude diagnosis + attack-chain correlation + CISO
report). No subscription. No seats. Pay if you use it.

Free CLI runs locally:
  npx -p @gatetest/cli gatetest --suite quick

Honest limitations (HN's #1 / Bible Forbidden #1):
- We don't beat CodeQL on deep multi-hop taint analysis. We win
  on breadth, speed, and the auto-fix.
- Mutation testing + chaos pass ship via GitHub Action only,
  not the website Forensic scan (Vercel functions can't safely
  run a customer's test suite).
- We don't claim "most reliable scanner" yet. We've built the
  continuous reliability framework; the track record starts now.

Real-repo proofs are in /docs/proofs — including a Crontech.ai
scan that found 754 errors and two critical attack chains, and a
MarcoReid.com scan that caught a textbook parseFloat-on-trust-
account-money bug.

Happy to answer anything about the architecture, the cost curve,
the Claude pipeline, or how we handle false positives. Roast me.
```

(~290 words — fits PH's comment soft limit, scannable on mobile)

---

## GALLERY (5 images — order matters; PH shows the first as the hero)

| # | What it shows | Caption |
|---|---|---|
| 1 | **Hero shot** — gatetest.ai landing page with the hero text and the four pricing tiers visible. Dark theme. | "One gate. 120 modules. Pay per scan." |
| 2 | **Live scan in progress** — `/scan/status` page mid-run with the module ticker animating. | "Watch the scan in real time — every module, every finding." |
| 3 | **The auto-fix PR** — screenshot of a real GitHub PR opened by GateTest, with the fix diff and the regression-test diff side-by-side. | "Findings come back as a PR — fix + regression test, ready to merge." |
| 4 | **Forensic report** — the executive summary section of a Forensic-tier PR comment (headline, posture, top-3 actions). | "CTO-readable executive summary. Board-ready CISO report on $399 tier." |
| 5 | **CLI in a terminal** — `npx -p @gatetest/cli gatetest --suite quick` running locally, finding errors. | "Run it free locally — same engine, no signup, MIT-licensed." |

Avoid: marketing collage, logo wall, "before/after" stock imagery. PH gallery converts on *product reality*, not brochure design.

---

## FOLLOW-UP COMMENTS (queue these for hour 1-4 to keep the thread alive)

### 1. The "how does pricing actually work?" reply

> Per-scan, paid upfront via Stripe, charged at checkout. No subscription, no seats. If a scan fails to deliver we refund or re-run (operator's call). The CLI is free forever — that's how we keep CI cheap; the hosted tiers are for "I want the Claude pipeline on a real repo with a fix PR opened for me."

### 2. The "what about false positives?" reply

> Every finding has a confidence score and module attribution. Customer dismissals feed back into a confidence-calibrator that recommends per-rule severity downgrades when dismissal rates indicate noise. The pipeline is built around the assumption that false positives will exist and need to be managed, not denied.

### 3. The "Claude isn't deterministic" reply

> Yes, and that's why deterministic modules run first and Claude runs second. The fix loop has: (a) Claude proposes a patch, (b) cross-fix syntax gate validates it compiles, (c) cross-fix scanner re-runs the affected modules in isolation against a synthetic post-fix workspace and rolls back if new findings appear, (d) a regression test is generated to lock the fix in. Non-deterministic input, deterministic gate.

### 4. The competitor question

> CodeQL beats us on deep multi-hop taint. Snyk beats us on supply-chain breadth (their CVE feed is years of work). SonarQube beats us on the IDE plugin maturity. Where we beat them: breadth × speed × auto-fix, and per-scan pricing instead of per-seat-per-year. We're aimed at the team that doesn't have $20k/year for SonarQube + Snyk + Cypress Cloud combined.

### 5. The open-source question

> CLI is MIT (github.com/crclabs-hq/gatetest). The hosted pipeline (Claude orchestration, fix-loop, pair-review, executive summary) is closed — that's where the per-scan revenue funds the recipe-flywheel and the trainer pipeline. Self-host the CLI for free; pay if you want Claude to fix things for you.

---

## CROSS-POST AT LAUNCH

**Twitter/X (post when PH listing goes live, link in bio):**
> Live on Product Hunt today.
>
> GateTest: one CI gate that replaces SonarQube + Snyk + Lighthouse + 9 others. 120 modules. Claude opens the fix PR. Pay per scan, no subscription.
>
> Free CLI: `npx -p @gatetest/cli gatetest --suite quick`
>
> [PH link]

**Reddit r/SaaS (post 2-3h after PH goes live, when there's already social proof on the listing):**
> Title: I launched a code-quality scanner with pay-per-scan pricing (no subscription, no seats) — on PH today
> Body: short build-in-public framing, cost-curve story, link to PH listing at the bottom (not the top — Reddit hates link-first posts).

**Indie Hackers (parallel to Reddit):**
> Title: Replacing 12 QA tools with one $99 scan — live on PH today
> Body: revenue-transparent founder note. IH rewards numbers more than HN does — share Stripe MRR, scan counts, what's working / what's not.

---

## WHAT *NOT* TO DO

1. Don't tag every PH-known-account in the launch comment. PH staff penalises orchestrated upvote campaigns.
2. Don't put pricing in the tagline. PH discovery prioritises the "what" over the "how much."
3. Don't reply to every comment with marketing copy. Founders who answer technically (and concede points) convert PH viewers into customers; founders who shill don't.
4. Don't post on Monday (industry-launch noise floor is too high). Don't post on Friday (Saturday traffic drop hurts the 24-hour leaderboard).
5. Don't claim things the product doesn't do today. PH commenters check claims; HN-style fact-checking carries over.
