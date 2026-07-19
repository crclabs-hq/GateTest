# GateTest — LinkedIn launch draft

**Status:** Ready to copy-paste. Best time: **Tuesday or Wednesday, 7:30-9:00 AM in your target buyer's timezone** (NZT for ANZ buyers, ET for North American CTOs). LinkedIn's algo rewards first-hour engagement; line up 5-10 people you know to like + comment within the first 60 minutes.

**Pre-launch:**
- [ ] Confirm profile headline names you as founder of GateTest (the post conversion comes from clicking your name)
- [ ] Pin a previous post that has good engagement so visitors see momentum
- [ ] Connect requests queued from anyone who comments — LinkedIn punishes "post and run"

---

## POST 1 — The founder origin story (lead with this)

**Format:** Long-form, ~1800 chars. First two lines are the hook; LinkedIn truncates at ~210 chars on mobile.

```
For six years I duct-taped 12 different code-quality tools into
every project I built. SonarQube, Snyk, ESLint, Cypress,
Lighthouse, axe, pa11y, npm audit, hadolint, actionlint, gitleaks,
and a custom Python script that nobody else could read.

Each one had its own config file, its own dashboard, its own
GitHub Action, its own monthly bill. The setup tax alone was
2-3 days on every new repo. The dashboards stayed open in tabs
nobody checked. The bills stayed on someone else's credit card.

So I built GateTest.

One composite GitHub Action runs 102 quality modules in parallel.
Security, accessibility, IaC, SQL migration safety, prompt safety,
money-float detection, attack-chain correlation — all of it, one
config, one bill.

The interesting bit isn't the breadth. It's the cost curve.

Deterministic AST and rule-based layers run first — free, fix in
milliseconds. Claude only runs on patterns nothing else has seen
— paid, one-shot. Every Claude win is distilled into a reusable
recipe. The next time the same pattern appears in your repo (or
any of our other customers' repos), it's handled for free.

The gate gets cheaper as the network uses it. That's the unfair
advantage.

Pricing is per-scan, paid upfront via Stripe. $29 Quick, $99 Full,
$199 Scan + Fix (auto-fix PR + pair-review), $399 Forensic
(Claude diagnosis + attack-chain correlation + CTO-readable
executive summary). No subscription. No seats. No "contact sales."

CLI is MIT and free forever:
  npx -p @gatetest/cli gatetest --suite quick

The Forensic tier on a recent customer's repo found two attack
chains that no individual scanner would catch — hardcoded secret
plus undeclared env-var meant rotation was operationally
impossible. One of them, a parseFloat on a trust-account balance
in a legal-tech product, was a textbook fintech bug that would
have been a regulatory event.

Built it in three months. Live now at gatetest.ai. Trying it on
a real repo is the fastest way to judge it.

#DevTools #CodeQuality #DevSecOps #SaaS #StartUp
```

**Why this works:**
- First 200 chars (the visible-on-mobile hook) name the pain in concrete terms (12 tools by name).
- The "cost curve" framing is non-obvious — most readers will pause on "the gate gets cheaper as the network uses it."
- Concrete proof (parseFloat on trust-account money) wins more attention than abstract claims.
- CTA is the link in profile/comment, not in-post (LinkedIn down-ranks posts with external links).

---

## POST 2 — The "we scanned a real customer's repo" hook (use 3-7 days after Post 1)

```
A legal-tech company let us run our $399 Forensic Scan against
their codebase. Here's what we found in the trust-account
handling module:

    const balance = parseFloat(input.amount);

For a product that holds client trust money under regulatory
oversight, storing currency in IEEE-754 floating point is the
textbook bug that ends careers. $0.10 + $0.20 ≠ $0.30. A $0.01
fee over 10,000 transactions accrues a hundred-dollar drift the
auditor can't reconcile.

No single ESLint rule catches this. No SonarQube rule catches
this (they have one Java-only rule on java.util.Date for money;
nothing on parseFloat). Snyk Code catches a related subset
behind their SaaS. The only tool that catches this combination
— money-named variable plus parseFloat plus no decimal-library
safe-harbour — is GateTest's moneyFloat module.

We caught it. We told them. They fixed it. The audit they
hadn't started yet would have caught the same thing — minus
us they'd have been in their auditor's office instead of in
their codebase.

This is why we built a unified gate instead of another linter.
The bugs that end companies live in the seams between the
tools nobody runs together.

120 modules. One gate. Pay per scan.

CLI is free: npx -p @gatetest/cli gatetest --suite quick
Hosted scans: gatetest.ai

#DevSecOps #FinTech #SaaS #CodeQuality
```

---

## POST 3 — The competitor comparison (use 7-14 days after Post 2)

```
Comparing dev-tool prices for a 12-person engineering team:

  SonarQube Enterprise: $20k/year + setup
  Snyk Team: $12k/year + per-seat
  Cypress Cloud: $7.5k/year
  Lighthouse CI: free, requires infra
  CodeQL: free for open source, GitHub Advanced Security is $42/user/mo for private

Total before any seat upgrades: ~$45k/year for the audit /
security / E2E / perf surface.

GateTest:
  CLI is free. MIT-licensed. Forever.
  Hosted Quick scan: $29
  Hosted Full scan: $99 (every module)
  Hosted Scan + Fix: $199 (auto-fix PR + pair-review)
  Hosted Forensic: $399 (Claude diagnosis + attack-chain
  correlation + CTO executive summary)

No seats. No subscription. Pay if you use it.

Run the same Full Scan once a week for a year? $99 × 52 = $5,148.
That's 89% less than the equivalent SonarQube + Snyk combo, and
you get the auto-fix PR in the bargain.

The math is the pitch. Try it for the cost of a coffee:
  gatetest.ai → paste repo URL → $29

#DevTools #SaaS #CodeQuality #FinOps
```

---

## REPLY KIT — when comments land

### "How do you handle false positives?"

> Every finding has confidence + module attribution. Customer dismissals feed back into a calibrator that recommends per-rule severity downgrades when a rule shows high dismiss rates. The system assumes false positives will exist and need to be managed, not denied. Auto-fix PRs include the pair-review step on the $199 tier specifically to catch fixes that look right but aren't.

### "Why pay per scan instead of subscription?"

> Subscriptions punish low-velocity teams (the ones who don't push every day) and reward high-velocity teams (who push 100x/day and use the same API allowance). Pay-per-scan inverts that — usage = revenue, no usage = no cost. We didn't want to build a product where customers feel locked-in; we wanted one where they keep choosing us every scan.

### "Open source?"

> CLI is MIT. github.com/crclabs-hq/gatetest. The Claude orchestration layer (fix-loop, pair-review, executive summary) is closed — per-scan revenue funds the recipe-flywheel and the trainer pipeline. Self-host the CLI free; pay only if you want Claude to fix things for you.

### "Does it work on monorepos / Next.js / Python / Go / [framework]?"

> Yes. Universal-checker engine handles Python, Go, Rust, Java, Ruby, PHP, C#, Kotlin, Swift. JS/TS coverage is deepest. Monorepos: scanned at the repo root by default; module-by-module with a config override. Real proofs in /docs/proofs — Crontech (Next.js + Vercel), Gluecron (Node monorepo), MarcoReid (Next.js + Stripe + Postgres).

### "What about Claude pricing changes?"

> Per-scan upfront pricing absorbs the volatility — if Anthropic raises prices 2x, we take the hit on the scans we already sold, then adjust the per-scan price for new scans. Customer never sees a surprise bill mid-month. The CLI never calls Claude (it runs the deterministic modules only), so the free path is unaffected.

---

## CTA — what to put in your LinkedIn "About" section while the launch is live

```
Founder, GateTest (gatetest.ai)

One CI gate. 120 modules. Replaces SonarQube + Snyk + ESLint +
Cypress + Lighthouse + 7 others. Auto-fix PR ships on the $199
tier. Pay per scan — no subscription, no seats.

Free CLI: npx -p @gatetest/cli gatetest --suite quick
```

---

## WHAT NOT TO DO

1. Don't tag a bunch of LinkedIn-influencer accounts at the bottom of the post. The algo punishes "tag farms."
2. Don't post on weekends. Tuesday/Wednesday/Thursday between 7:30-9:00 AM in your target buyer's timezone is the only window worth using.
3. Don't use stock images. LinkedIn dev-tool posts convert on screenshots of *real product*, not generic "team collaboration" stock.
4. Don't ask for "likes if you agree" — LinkedIn now down-ranks engagement-bait phrasing automatically.
5. Don't link to PH/HN/external in the post body. Put it in the comments or your profile. LinkedIn down-ranks posts with external links by 30-40%.
