# HN relaunch — second attempt playbook

> **Boss Rule #8:** drafts for Craig to post himself. Nothing auto-posts.
>
> **Context — attempt #1 post-mortem (reviewed from screenshot 2026-06-10):**
> "Show HN: GateTest – 110 QA checks in one scan, auto-fix PR for what it
> finds" — 3 points, 1 comment, ~2026-06-05, account McCracken49 (1 karma).
> What actually killed it, in order:
> 1. **The pitch was a COMMENT and it got `[flagged]`** (auto spam-filter:
>    new account + multiple links + pricing list). Readers saw a bare
>    link with no story. The pitch text itself was good — honest
>    "what's not there yet" section, strong closer.
> 2. **1-karma account** — new accounts are heavily filtered on /newest.
> 3. **Posted overnight NZ** = dead hours for the US audience.
> Not a product verdict — the pitch was never visible.
>
> **Actions before attempt #2:**
> - Email hn@ycombinator.com: first-time poster, pitch comment was
>   auto-flagged (link item), ask for flag review + second-chance pool.
> - Build 20-50 karma during the cooldown via genuine comments.
> - Next time the pitch goes in the POST BODY (Show HN supports
>   text + URL), never a comment.

---

## The three rules for attempt #2

1. **Wait 2-3 weeks** after the original post date. Reposting same-week
   reads as spam; weeks later with a different angle is explicitly fine.
2. **Post Tue/Wed/Thu, 8:00-10:00am US Eastern** (= midnight-2am NZ —
   set an alarm or schedule the morning around it; the first hour of
   comment-answering is non-negotiable).
3. **Different post, not a retry.** Same title + same framing = same
   result. The two angles below are ranked.

---

## Angle A (preferred): the data story — submit the ARTICLE

**Precondition:** `docs/launch/data-story.md` corpus scan has run and the
blog post is live with real numbers.

**Title (use the headline stat, not the product):**
> [X]% of [N] public websites ship JavaScript errors on their own homepage — we scanned them with a real browser

- Plain link submission to the article (NOT Show HN — it's content now).
- Product appears only in the article's methodology + footer. HN
  tolerates — even rewards — that when the data carries the post.
- Prepare for the two guaranteed comment threads: "methodology?"
  (answer: it's the longest section of the article) and "is this an ad?"
  (answer: disclosed in the article; dataset stands on its own; here's
  the raw aggregate JSON).

## Angle B: the self-scan honesty story — Show HN

**Works without the corpus scan — can fire as soon as the cooldown ends.**

**Title:**
> Show HN: I make my QA tool gate its own releases — here's everything it flags about itself

**Body draft (verify starred facts at launch hour, per show-hn-FINAL.md):**

```
GateTest is a CI quality gate: 110 checks, and instead of just failing
your build it opens a PR that fixes what it found — each fix re-scanned
against the gate, with an auto-written regression test and a second-AI
pair review before anything ships. Pay per scan, no subscription.

The part I want feedback on is the honesty loop. GateTest's own repo is
gated by GateTest — the homepage badge shows the live result, including
the modules that are currently RED on our own code. Last week an audit
of our own marketing claims found numbers that had drifted from reality
(a stale module count, a speed claim our own repo couldn't meet) — the
scanner's findings forced the copy to change, and that's now a test in
our CI: marketing claims that drift from the product fail the build.

Try it free, no signup: https://gatetest.ai/web scans any public site in
a real browser. The CLI is MIT: npx github:crclabs-hq/GateTest

Happy to answer anything, including "why should I trust an AI to write
fixes" — short answer: you shouldn't, which is why every fix carries a
regression test and never auto-merges.
```

**First comment (post it yourself immediately — seeds the discussion):**
> Backstory: the marketing-claims-as-CI-tests thing exists because we
> kept catching our own copy drifting from the product (module counts,
> speed claims). Now `tests/marketing-claim-verification.test.js` fails
> the build if the website promises something the registry can't back.
> Happy to share how that works if useful.

---

## First-hour protocol (both angles)

- Answer every comment within minutes, technically and without
  defensiveness. Upvotes follow active threads.
- Concede valid criticism instantly ("you're right, that's on the
  roadmap / that's a real limitation") — HN rewards it.
- Do NOT ask anyone to upvote, and don't share the item link asking for
  votes (HN detects voting rings; it kills posts).
- If it doesn't catch by hour 3, let it go — the channel calendar
  continues regardless. Each attempt is a lottery ticket, not a verdict.

## Post-mortem fields (fill after)

| Field | Value |
|---|---|
| Angle used | |
| Posted (UTC + ET) | |
| Peak rank / points / comments | |
| gatetest.ai visits in 24h | |
| Free scans run | |
| Paid conversions | |
| What we'd change | |
