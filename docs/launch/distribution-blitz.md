# GateTest Distribution Blitz Pack

> Internal launch-ops doc. Public-facing copy drafts for Craig to post
> himself, channel by channel. **Goal: first paying customers.**
>
> **The two rules that make "go massive" actually work:**
> 1. **Tailor + space it out.** Never paste the identical post in 10 places
>    in one hour — platforms flag it as spam and shadow-ban you. The drafts
>    below are deliberately worded differently per channel. Spread them over
>    ~5 days (sequence at the bottom).
> 2. **Lead with the free, no-signup scan — never the price.** Give first.
>
> **Honest facts to keep straight (don't drift):** 110 modules · gatetest.ai ·
> free no-signup scan · MIT CLI via `npx github:crclabs-hq/GateTest` (npm not
> published yet) · pay-per-scan $29 / $99 / $199 / $399 + $49/mo Continuous ·
> never auto-merges · GitHub Marketplace listing in review.

---

## 0. Master assets (reuse these everywhere)

**One-liner (short):**
> GateTest — one scan, 110 checks, opens an AI-written PR that fixes what it finds. Free to try, no signup. https://gatetest.ai

**One-liner (directory / 160 chars):**
> One scan runs 110 modules (security, quality, perf, a11y, SEO, infra) and opens an AI PR that fixes findings. Free MIT CLI, pay-per-scan hosted.

**The honest hook:** "Most tools tell you what's broken. GateTest opens the PR that fixes it."

---

## 1. Indie Hackers  (indiehackers.com → Create Post)

**Title:** I built one scan that runs 110 code checks and opens a PR that fixes them

```
Hey IH 👋 I'm Craig.

I got tired of wiring SonarQube + Snyk + ESLint + Lighthouse + axe into
every project — each with its own config, dashboard and bill. So I built
GateTest: point it at a repo or a live URL, it runs 110 checks in one
pass, then on the paid tiers it uses Claude to open a PR that fixes what
it found. Never auto-merges — you review.

Free, no signup: https://gatetest.ai  (CLI is MIT and runs locally too.)

Honest status: soft-launched on HN overnight and it was quiet (1am NZ
time wasn't the move 😅). Regrouping, and I'd rather get real builder
feedback than chase a spike. Run it on something and tell me where it's
noisy, wrong, or useful. Brutal feedback welcome.
```

---

## 2. dev.to  (dev.to → Create Post)  — also ranks on Google

**Title:** I replaced 10 QA tools with one scan — here's what I learned building it
**Tags:** #showdev #webdev #devops #ai

```
Every project, I'd wire in the same stack: SonarQube, Snyk, ESLint,
Lighthouse, axe — each with its own config, dashboard and invoice, and
nothing gave me one answer. So I built GateTest: one engine, 110
modules, one scan.

## The hard part wasn't finding issues — it was fixing them
Most tools stop at a report. I wanted it to open the PR. An AI patch
that looks right but breaks the build is worse than no patch, so the fix
path is gated: deterministic AST/rule layers first, Claude only on what
they miss, and every fix must pass a syntax-compile gate AND a re-scan
gate (rolls back any fix that introduces a new finding) before the PR
opens.

## What I got wrong
Breadth cuts both ways — a security team wants the deepest SAST, not a
110-in-one. I don't beat CodeQL on deep taint analysis, and I say so.
The honest audience is solo devs and small teams who'll never wire up 10
enterprise tools.

## Try it / tell me I'm wrong
Free, no signup: https://gatetest.ai
CLI (MIT): npx github:crclabs-hq/GateTest --suite quick ./

What would you actually want a tool like this to do?
```

---

## 3. Reddit  (tailored per subreddit — DO NOT cross-post identical text)

**r/SideProject** — Title: `I built a tool that runs 110 code checks and opens a PR that fixes them`
```
Solo-built this over the last while. Paste a repo or URL → 110-module
scan (security, quality, perf, a11y, SEO, infra) → on paid tiers it
opens an AI PR that fixes findings. Free, no signup: https://gatetest.ai
Quiet HN launch overnight so I'm regrouping — would love honest feedback
on where it's noisy or useful.
```

**r/SaaS** — Title: `Pay-per-scan instead of seat licenses — does this pricing make sense to you?`
```
Built a code-QA tool (110 checks + AI auto-fix PR). Went pay-per-scan
($29/$99/$199/$399) instead of per-seat, plus one $49/mo "scan every
push" plan. Curious what this sub thinks of per-scan vs subscription for
a dev tool. Free demo, no signup: https://gatetest.ai
```

**r/webdev** — (strict; frame as useful, not an ad) Title: `Made a free no-signup scanner for security/perf/a11y/SEO issues`
```
Wired up too many separate tools too many times, so I built one scan
that covers security, performance, accessibility, SEO and more, and (on
paid tiers) opens a PR that fixes findings. Free preview, no signup:
https://gatetest.ai — keen to hear where it's wrong or noisy.
```

**r/selfhosted / r/opensource** — Title: `MIT-licensed CLI that runs 110 code-quality + security checks locally`
```
The engine is MIT — run the full 110-module scan on your machine, no
account, nothing leaves your box: npx github:crclabs-hq/GateTest --suite
quick ./  Repo: https://github.com/crclabs-hq/GateTest  The hosted
service adds the AI auto-fix PR, but the scanner itself is free + local.
```

> ⏸️ **PARKED — DO NOT POST YET.** The `/web` and `/wp` pages have no
> checkout button — WordPress/website visitors can scan free but currently
> have **no way to pay**. Posting this drives unmonetizable traffic. Unpark
> only after a URL-scan checkout is wired. (Decision 2026-06-04: dev audience
> first, WP later.)

**r/Wordpress** (the wedge — see §6) — Title: `Made a free no-signup WordPress security scanner — feedback wanted`
```
Free, no signup: paste your site URL and it checks for plugin CVEs,
version leaks, user enumeration, XML-RPC exposure, exposed backups and
missing security headers. https://gatetest.ai  Not a firewall — think of
it as a fast second-opinion health check, handy before handing a site to
a client. Tell me what it misses.
```

---

## 4. X / Twitter  (#buildinpublic thread)
```
1/ I built GateTest: one scan, 110 code checks, and on the paid tiers it
opens a PR that FIXES what it finds. Free, no signup → gatetest.ai

2/ Why: I was sick of wiring SonarQube + Snyk + ESLint + Lighthouse + axe
into every project. Different config, dashboard, bill for each.

3/ Hard part wasn't finding bugs — it was fixing them safely. Every AI
fix passes a syntax gate + a re-scan gate before the PR opens. It never
auto-merges.

4/ Honest: I don't beat CodeQL on deep taint. I'm betting on breadth +
speed + the auto-fix. Soft-launched on HN, it was quiet — so I'm building
in public and looking for real users. Run it on your repo and roast it 👇
```

---

## 5. Product Hunt  (schedule a proper launch — don't rush)
- **Tagline:** One scan, 110 checks, an AI PR that fixes what it finds
- **Assets to prep:** logo, 3–4 screenshots (the scan running, a real fix PR, the report), 60-sec demo gif
- **First comment:** the Indie Hackers body works well
- Pick a Tue–Thu, 12:01am PT launch. Lines up another backlink for SEO.

---

## 6. Directories & awesome-lists  (do these first — zero flame risk)
Paste the 160-char one-liner. Set-and-forget + backlinks:
- **AlternativeTo** — list as alternative to **Snyk**, **SonarQube**, **Semgrep**
- **SaaSHub**, **StackShare**, **LibHunt**
- **GitHub awesome-list PRs** (read each CONTRIBUTING first — they're picky on format/alphabetical):
  - `analysis-tools-dev/awesome-static-analysis`  ← the big one
  - an `awesome-devsecops`
  - `joho/awesome-code-review`
  - an `awesome-ci` / `awesome-developer-tools`

---

## 7. HN second chance  (you already launched; don't re-submit blindly)
Email **hn@ycombinator.com**, short + polite:
```
Hi — I posted a Show HN for GateTest (gatetest.ai) overnight my time
(NZ), which landed at a quiet hour for the US audience and didn't get
much visibility. It's a genuine project — would you consider it for the
second-chance pool so it gets a fairer run? Thanks either way.
Link: <your item URL>
```

---

## 8. The "does it actually convert?" checklist  (this is the money half)
Distribution sends people; the site has to turn them into customers. Before the blitz, confirm:
- [ ] Free scan completes fast in incognito (desktop + phone)
- [ ] The free result clearly shows value AND a clear next step to pay
- [ ] Pricing page loads, prices obvious, checkout works (test card 4242…)
- [ ] There's an obvious "what do I get for $99 vs $199 vs $399"
- [ ] A way to capture people not ready to buy (email / waitlist) so traffic isn't wasted

---

## Suggested 5-day sequence (avoids spam-flagging, sustainable)
- **Day 1:** Directories + awesome-list PRs (§6). Indie Hackers post (§1).
- **Day 2:** dev.to article (§2). Start the X build-in-public thread (§4).
- **Day 3:** r/SideProject + r/selfhosted (§3).
- **Day 4:** ⏸️ WordPress push PARKED (no checkout on /web + /wp yet). Use the
  day for a second dev-audience channel (r/opensource or a dev newsletter
  submission) instead.
- **Day 5:** r/SaaS + r/webdev (§3). Send HN second-chance email (§7).
- **Following week:** Product Hunt launch (§5), tuned from the feedback.

**Reality check on the money:** this is a weeks-to-months game, not a
same-day one. The win signal isn't a traffic spike — it's people who run
a scan, come back, and tell someone. Feed whatever channel produces that.
