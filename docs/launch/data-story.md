# The Data Story — "We scanned N public sites" (strongest relaunch card)

> **Status: RUNBOOK + SKELETON.** The article cannot ship until the corpus
> scan has actually run — every stat below is a `[TODO]` until then.
> **Honesty rule (Bible Forbidden #1):** no stat ships unless it came out
> of a real scan run, and the dataset + date are stated in the article.
>
> **Why this is the strongest card:** product announcements are the
> weakest-performing genre on HN/Reddit; original data is the strongest.
> The scanner IS the data factory — no competitor can write this article
> without building our product first.

---

## 1. The corpus scan (runbook)

**What:** run the `/web` scanner (same engine as gatetest.ai/web — headers,
TLS, cookies, a11y, SEO, links, performance + headless-browser runtime
errors where the worker is available) across a corpus of public sites.

**Corpus options (pick one, state it in the article):**
- **Top-1k popular sites** (Tranco list, tranco-list.eu — research-grade,
  citable) — strongest credibility, hardest targets.
- **Random sample of ~500 SMB sites** (e.g. from a public business
  directory) — more relatable "sites like yours" framing, better stats
  (more findings per site).
- Both, contrasted ("the top 1k vs everyone else") — best article, 2x work.

**How to run it (any of):**
1. Against production: `POST https://gatetest.ai/api/web/scan` with
   `{ "url": "<target>" }`, ~1/second max, from a local machine or an
   API-keyed Claude session WITH network egress (this remote env's
   allowlist blocks arbitrary hosts — it cannot run the corpus).
2. Locally: `node bin/gatetest.js --suite web --url <target>` in a loop —
   full runtime-error capture since Playwright runs locally.
3. A GitHub Action matrix job (the browser-capable worker path from the
   superiority plan §2.1) — best for the 1k corpus, free compute.

**Collect per site:** health score + grade, per-module error/warning
counts, the specific high-signal rule hits (CSP missing/unsafe, TLS
config, cookie flags, runtime JS errors, mixed content, version leaks).

**Ethics line (include in article):** read-only checks against publicly
served pages; no auth probing, no active exploitation; per-site results
anonymised — only aggregates published.

---

## 2. Article skeleton (target: gatetest.ai/blog/state-of-web-quality-2026)

**Title options:**
- "We scanned [N] public websites with a real browser. [X]% ship JavaScript errors on their own homepage."
- "The State of Web Quality 2026: [N] sites, [M] findings, one uncomfortable pattern"

**Structure:**
1. **The headline stat** — one sentence, the single most shocking number. `[TODO]`
2. **Methodology** — corpus, date, what was checked, ethics line. (Write this section FIRST — it's what makes HN trust the rest.)
3. **The league table** — % of sites failing each check class: CSP `[TODO]`%, HSTS `[TODO]`%, cookie flags `[TODO]`%, runtime errors `[TODO]`%, mixed content `[TODO]`%, version leaks `[TODO]`%.
4. **Grade distribution** — the A-F curve. `[TODO]` (a bell curve centred on C/D is itself a story)
5. **Three anonymised horror stories** — concrete chains, e.g. "a checkout page with [X] + [Y] = session takeover surface." `[TODO]`
6. **What the best sites do differently** — the positive counter-pattern. `[TODO]`
7. **Footer disclosure:** "Scans were run with GateTest's public website scanner — the same free scan at gatetest.ai/web. Check your own site against this dataset."

**The CTA is the dataset, not the product:** "see how your site compares"
converts better than "buy a scan."

---

## 3. Distribution of the data story (once written)

| Channel | Angle |
|---|---|
| **HN relaunch** | Submit the ARTICLE (not Show HN — it's content now). Title = the headline stat. See `hn-relaunch.md`. |
| **Reddit r/webdev** | "We scanned [N] sites, here's the league table" + answer questions; product only in the methodology link. |
| **Newsletters** | Template C in `newsletters.md` — data pitches get accepted where product pitches get ignored. |
| **LinkedIn** | The CTO framing: "your competitors' grade distribution." |
| **X thread** | One stat per tweet, chart screenshots, article link last. |
| **GEO** | This page becomes the citable source for AI answer engines (superiority plan §4.2.1) — original data = citations. |

---

## 4. Effort estimate

- Corpus scan: a day of wall-clock (rate-limited), mostly unattended.
- Aggregation script: small — `scripts/aggregate-web-scans.js`, reads the
  per-site JSON, emits the league table + grade curve. (Pre-authorized
  build, do alongside the scan.)
- Article: half a day once numbers exist.
