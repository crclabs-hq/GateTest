# GateTest Superiority Plan — June 2026

**Audience:** Craig
**Author:** Claude session 2026-06-09 (branch `claude/testing-tool-website-strategy-n3sm0c`)
**Status:** Strategy document — execution items flagged as pre-authorized vs Boss Rule

This document answers four questions Craig asked on 2026-06-09:

1. Is the website actually a joke, and what would make it superior?
2. Is the tool up to the task — can a headless browser even work on a server,
   and how does GateTest serve the **public** (non-developers), not just devs?
3. How do we fix the structural problem that every Claude session builds blind —
   one shot, no way to see what it built, no way to find its own problems?
4. What does the biggest SEO campaign ever launched look like, **including AI
   search** (ChatGPT / Claude / Perplexity answers)?

---

## 0. The honest audit first (as of 2026-06-09, main branch)

Before strategy, ground truth. A full repo audit was run this session. Summary:

| Dimension | Reality |
| --- | --- |
| Landing page | **No longer basic.** Two hero-redesign passes + a premium homepage prototype merged in the last week (PRs #205, #211, #212). Editorial typography, live URL-scan demo embedded in the hero, honest stats band, 422-line pricing component with 4 tiers + enterprise + coming-soon cards. This is a professional marketing surface now. |
| Site breadth | 36 routes: blog (6 posts), 7 competitor compare pages, glossary, use-cases, `/for/<stack>` pages, module detail pages, `/web` + `/wp` public scanners, legal. |
| SEO plumbing | Dynamic sitemap, robots.ts that explicitly **welcomes** GPTBot / ClaudeBot / PerplexityBot / Google-Extended, SoftwareApplication + Organization + Website structured data, OG/Twitter cards. The foundation is already built. |
| Tool | 118 modules registered and loading. Postgres-backed scan queue with retry/backoff, Vercel-cron worker tick every 2 minutes, Playwright process sandbox (hard wallclock kill, memory cap). |
| Public flows | `/web` (any website) and `/wp` (WordPress) are real: 468/407-line scan endpoints, streaming, health-score + cluster output, free-preview-then-paywall. Not stubs. |
| Tests | 292 backend test files (~4,600 tests). Website E2E: **23 test cases** (load/nav/footer only). |
| **The gap** | **Verification of the user-visible product.** No screenshot regression, no deployed-site smoke tests, no payment-flow E2E, no post-deploy health gate. The engine is tested 200x harder than the storefront. If a deploy breaks the homepage or checkout, a customer finds it before CI does. |

**Conclusion:** Craig's instinct that something is wrong is correct, but the
diagnosis is different from "the website looks basic." The website got fixed
last week. The real disease is **blindness** — and it's the same disease that
makes Craig unsure whether the tool is up to the task: nobody (human or Claude)
can currently *see* the product working. That's item #2 below, and it's the
highest-leverage fix in this entire document.

---

## 1. Fix the blindness first — the Verification Flywheel

> Craig: *"previous models were not able to see what they've done once they've
> built it... they've only had one shot at building and once it's built they
> don't know how to find the problems or enhance it."*

This is solvable, and everything else compounds on top of it. A QA company
whose own storefront has no QA is also the world's best marketing story when
inverted: **GateTest gates itself, visibly, in public.**

### 1.1 Self-screenshot loop (pre-authorized — testing infra, no new deps)

Playwright is already an approved internal dependency. Add:

- `website/e2e/visual.spec.ts` — Playwright screenshot capture of every key
  surface (home, pricing, /web, /wp, /compare hub, scan status states) at
  three viewports (375 / 768 / 1440).
- Screenshots are **artifacts every Claude session can open**. The Read tool
  renders images. A session changes the hero → runs the spec → *looks at the
  screenshot* → iterates. The one-shot problem dies here. This works today in
  the remote environment (`npx playwright test` against `next dev`).
- Visual regression: commit baseline PNGs; `toHaveScreenshot()` diffs on every
  PR. A CSS regression becomes a red check with a visual diff attached, not a
  customer complaint.

**Session protocol addition (Bible amendment proposed):** any session that
touches `website/app/` must run the visual spec and *look at* the changed
screenshots before committing. "I rendered it and looked at it" replaces
"it compiles."

### 1.2 Deployed-site smoke tests (pre-authorized once gatetest.ai URL is confirmed live)

Nightly workflow `prod-smoke.yml`:

- `GET https://gatetest.ai/` → 200, OG tags present, hero H1 matches expected.
- `POST /api/web/scan` against a known stable target → returns health score.
- Lighthouse CI run → fails under Performance 90 / SEO 95 / A11y 95.
- On failure: opens a GitHub Issue automatically (same pattern as the existing
  `dogfood-nightly.yml` marketing-claim check — reuse it).

### 1.3 Payment-flow E2E (pre-authorized — Stripe test keys only, Forbidden #5 respected)

One Playwright spec: pricing card → checkout session created → Stripe test-mode
redirect URL returned → scan/status page renders every state (pending /
scanning / complete / failed / expired). Mock the Stripe redirect; assert the
session payload. This is the single most revenue-critical untested path in the
product.

### 1.4 Dogfood-the-storefront

The `/web` scanner already exists. Point it at `https://gatetest.ai` nightly
and publish the result as a **live self-scan badge** on the homepage (the
`HomeSelfScan` component already exists for the repo scan — add the URL scan).
If GateTest's own site scores below A, the nightly opens an issue. This is
simultaneously QA and the most credible marketing asset we can own.

---

## 2. The tool — answers and roadmap

### 2.1 Headless browser on a server: settled, yes — with the right topology

Craig asked: *"I don't know if a headless browser would work with a server."*
The answer is already half-built in this repo:

- **Vercel serverless functions: no.** Chromium can't reliably launch in the
  function sandbox; the modules already degrade gracefully (info-level skip).
- **The worker path: yes.** The scan queue + worker-tick architecture exists
  precisely for this. Today the tick runs *inside* Vercel (60s budget, no
  browser). The missing piece is a **browser-capable worker** that drains the
  same Postgres queue:
  - **Option A (no new vendors, pre-authorized shape):** GitHub Actions as the
    browser runner — a repository-dispatch-triggered workflow that claims
    queued browser jobs, runs Playwright (already works in Actions for the
    GitHub Action product), posts results back via the existing callback path.
    Cost ≈ free at current volume. Ship this first.
  - **Option B (Boss Rule #7 — Craig decision):** a $5–20/mo always-on worker
    (Railway / Fly.io / Hetzner) running Chromium hot. Sub-30-second public
    URL scans instead of "queued, ~2 minutes." Needed only when `/web` and
    `/wp` traffic justifies it. **Recommendation: approve Option B when the
    first 50 organic URL scans/week arrive; until then Option A.**

### 2.2 "Test for all DevOps problems"

The module surface (118) already spans code, deps, Docker, K8s, Terraform,
CI security, SQL migrations, cron, TLS, cookies, secrets. The genuinely
missing DevOps-pain modules, in priority order (all pre-authorized inline
builds, zero new deps):

1. **deploy-pipeline auditor** — detects missing rollback path, no health
   check after deploy, no canary/stage gate in workflows (partially exists:
   `deploy-readiness.js`, `rollback-honesty.js` — extend, don't rebuild).
2. **observability gap detector** — services with no error tracking init, no
   log correlation IDs, catch blocks that lose stack traces (extends
   `error-swallow`).
3. **backup/restore honesty** — DB config present but no backup job/workflow
   anywhere; the classic "we had backups, never tested restore."
4. **incident-readiness** — no on-call doc, no SLO definitions, no runbook
   links in alerts (informational tier).

### 2.3 The public (non-developer) product

`/web` and `/wp` already serve this audience. What makes it *mind-blowing*
for a non-developer is not more modules — it's the **report language and the
fix path**:

- **Plain-English verdict first.** The health score + letter grade exists.
  Lead every public report with three sentences a café owner understands:
  what's broken, what it costs them (trust/Google ranking/security), what to
  do. The `translateFinding()` layer exists — extend it to a "explain it to
  me like I'm not technical" mode (one extra Claude pass, pennies per scan).
- **"Email this to my developer" button** — generates a technical handoff
  from the same scan. The non-dev buys; their dev executes. Two audiences,
  one scan, one price.
- **Monitored sites** ($49/mo Continuous tier already designed): weekly
  re-scan + "your score changed" email. This is the public-audience recurring
  revenue engine. (Stripe wiring for the subscription = Boss Rule #6, needs
  Craig.)

### 2.4 What makes the tool category-different (the honest moat)

Not module count. The moat, already half-built and worth finishing loudly:

1. **The fix loop** — scan → fix → re-scan-the-fix → regression test →
   pair-review. Nobody ships this on per-scan pricing (verified in the
   competitive sweep). Finish the production wiring (Phase 1.2b/1.5 leftovers
   in the Bible: scan-status page must pass `originalFileContents` +
   `originalFindings` into `/api/scan/fix` so the scanner gate goes live).
2. **The flywheel** — trainers + cross-repo corpus + confidence calibrator.
   Every scan makes the next scan smarter. Say this on the homepage in one
   sentence; no competitor can claim it.
3. **Self-application in public** — the live self-scan badge + nightly
   dogfood + published proof docs. "The QA tool that gates its own releases
   with itself" is a story SonarQube structurally cannot tell.

---

## 3. The website — from professional to unmistakable

The redesign passes landed. The remaining gap is not visual polish, it's
**proof density and interactivity**:

1. **The hero demo IS the product.** The live URL-scan input in the hero is
   the best asset on the page. Make its result shareable: scan completes →
   "your site scored C+ — see the 3 worst findings" → share/permalink →
   that permalink page is itself an SEO/GEO asset (see §4). Every free scan
   becomes a public, indexable proof-of-work page (with owner consent
   checkbox — Boss Rule #9 review on the consent copy before shipping).
2. **Before/after theater.** `BeforeAfterDemo.tsx` exists. Feed it a real
   PR from the proof docs (real diff, real attempt log, real pair-review
   comment) instead of synthetic data. Real artifacts read differently.
3. **Live status page** (`/status`): worker queue depth, scans run this week,
   median scan time, self-scan grade. Radical transparency as design.
4. **Speed as a feature:** the Bible's own bar — FCP < 1.0s, Lighthouse 95+ —
   now *enforced* by the §1.2 nightly, shown as a badge in the footer.
5. **Visual identity lock-in:** the new editorial/warm-light direction from
   PR #205/#212 is distinctive — codify it (`docs/design-language.md`) so
   future sessions extend it instead of re-inventing it. The one-shot problem
   applies to design taste too; write the taste down.

---

## 4. SEO + AI-search (GEO) — the campaign

Foundation already shipped: sitemap, AI-crawler-welcoming robots.ts,
structured data, 7 compare pages, blog, glossary, `/for/` pages. What follows
is the scale-up. **Content publication is Boss Rule #8 — this is the plan for
Craig to approve; drafting in-repo is pre-authorized, publishing is not.**

### 4.1 Programmatic SEO (the volume engine)

We have 118 modules — that's 118 × N landing pages of genuinely useful,
non-thin content, generated from the module source itself (the detection
rules ARE the content — no competitor can copy pages derived from a scanner
they don't have):

- `/checks/<module>/<rule>` — every ruleKey gets a page: what it detects,
  why it matters, real-world incident it prevents, code before/after,
  how GateTest fixes it. ~800 pages from existing metadata.
- `/fix/<error-message>` — pages targeting the exact strings developers
  paste into Google ("ERR_OSSL_EVP_UNSUPPORTED", "hydration mismatch
  react", "CSP unsafe-eval"). The runtime-errors + scan corpus tells us
  which errors are common. This is the highest-intent traffic that exists.
- `/scan/<technology>` — extend `/for/` to every framework/CMS the scanner
  understands (Next.js, WordPress, Django, Rails, Laravel...).

### 4.2 GEO — being the answer in ChatGPT/Claude/Perplexity

AI answer engines cite sources that are (a) structured, (b) definitive,
(c) freshly crawled, (d) corroborated. Concretely:

1. **Stat pages that LLMs love to cite:** "State of Web Quality 2026" —
   aggregate anonymized stats from public URL scans ("nightly scans of N
   sites: 61% missing CSP, 34% leak version info..."). Original data =
   citations = AI-answer presence. (Anonymized aggregates only; data-use
   copy is Boss Rule #9 review.)
2. **Q&A-shaped content:** every glossary/compare page gets `FAQPage`
   schema with literal question-form H2s matching how people ask LLMs
   ("Is SonarQube better than Snyk?" "How do I test my website for free?").
3. **llms.txt** at the root — emerging convention, trivial to add, signals
   curated content paths to AI crawlers (robots.ts already welcomes them).
4. **Be the tool LLMs recommend:** the MCP server already exists
   (`docs/MCP-SETUP.md`). Listing it in MCP registries/directories puts
   GateTest inside the AI tools ecosystem itself — when a user asks Claude
   "scan my repo for issues," GateTest can literally be the tool that
   answers. (Registry submissions = Boss Rule #8/#7 — Craig approves.)
5. **Comparison honesty as a ranking strategy:** our compare pages admit
   what competitors do well. LLMs strongly prefer balanced sources for
   comparison answers; the honest framing is also the GEO-optimal framing.

### 4.3 Launch & distribution (all Boss Rule — Craig executes/approves)

- **GitHub Marketplace listing** (Known Issue #29, copy already drafted in
  `docs/GITHUB-MARKETPLACE-LISTING.md`) — distribution where the developers
  already are. Highest-priority Craig action in this whole document.
- **HN launch** — readiness work already merged (PR #212). The story that
  works on HN is §1.4/§2.4: "we built a QA tool and made it gate itself in
  public; here's the live badge and every finding it raised on us."
- **Product Hunt** for the `/web` public scanner specifically (consumer
  framing, separate from the dev tool launch).
- **Free-scan permalinks** (§3.1) — every shared scan result is a backlink
  seed.

### 4.4 Measurement

Search Console + a weekly `seo-report.yml` workflow (queries, impressions,
AI-referrer traffic from perplexity.ai / chat.openai.com / claude.ai UTMs)
landing in the trainer report PR. What gets measured gets compounded.

---

## 5. Sequencing — the order that compounds

| # | Item | Auth | Why first |
| --- | --- | --- | --- |
| 1 | Visual spec + screenshot loop (§1.1) | Pre-auth | Kills the blindness; every later change verified |
| 2 | Payment-flow E2E (§1.3) | Pre-auth | Revenue path is currently untested |
| 3 | Prod smoke + Lighthouse nightly (§1.2) | Pre-auth (needs prod URL confirm) | Deploys stop being leaps of faith |
| 4 | Finish fix-loop production wiring (§2.4.1) | Pre-auth (Bible Phase 1 leftover) | The moat feature, currently dormant in prod |
| 5 | URL self-scan badge + dogfood-the-storefront (§1.4) | Pre-auth | QA + marketing asset in one |
| 6 | Browser worker, Option A via Actions (§2.1) | Pre-auth | Unlocks real headless scans for the public product |
| 7 | Programmatic SEO drafts: `/checks/` pages (§4.1) | Draft pre-auth, publish = Craig | Volume engine, content derived from our own scanner |
| 8 | llms.txt + FAQPage schema sweep (§4.2) | Borderline — minor, recommend Craig nods once | GEO quick wins |
| 9 | GitHub Marketplace listing | **Craig** | Distribution — biggest single unlock outstanding |
| 10 | Browser worker Option B, Continuous-tier Stripe, stat-page data use, registry listings, HN/PH launches | **Craig** | Money / vendors / public comms |

Items 1–7 are inside existing pre-authorization and can be executed by
subsequent sessions without re-asking. Items 9–10 are the Craig list.

---

## 6. What this plan refuses to do

- **No rebuild.** The audit shows the product and site are far better than
  the "one-shot blind builds" era suggested. The fix is verification +
  finishing half-wired moat features + distribution — not starting over.
- **No module-count inflation for marketing.** 118 is already the most
  in the category; depth and proof beat breadth from here.
- **No claims ahead of reality.** Every marketing surface in §4 is generated
  from, or verified by, the scanner itself. The honesty rule is also the
  best-converting and best-GEO strategy available to us.
