# Newsletter pitch kit — dev-tool newsletters

> **Boss Rule #8:** drafts for Craig to send from his own email. Nothing
> here is sent automatically. Personalise the greeting before sending.
>
> **Why newsletters:** they are the highest-trust, lowest-effort channel
> we have not touched. One inclusion in a mid-size dev newsletter
> typically outperforms a flopped HN post by 10-50x on qualified clicks,
> and inclusions are persistent (archives rank on Google).
>
> **Verified facts (do not drift):** 110 modules · free no-signup scan at
> gatetest.ai · CLI via `npx github:crclabs-hq/GateTest` (npm NOT
> published) · pay-per-scan $29/$99/$199/$399 · $49/mo Continuous is
> COMING SOON (not purchasable yet — do not claim it) · GitHub
> Marketplace listing in review · never auto-merges.

---

## Where to submit (in priority order)

| Newsletter | Audience | How to submit | Fit |
|---|---|---|---|
| **Console.dev** | ~30k devs, *specifically* reviews new dev tools weekly | console.dev → "Submit a tool" form | Highest — this is literally their format |
| **TLDR Web Dev** | ~500k+ across TLDR network | tldr.tech → advertise/submit links | High |
| **Bytes** (ui.dev) | ~200k JS devs, irreverent tone | bytes.dev → reply/submit | High |
| **JavaScript Weekly / Node Weekly** (Cooperpress) | ~150k+ | cooperpress.com → suggest a link | High |
| **Changelog News** | ~100k, OSS-leaning | changelog.com/news → submit | Medium-high (lead with the MIT CLI) |
| **Pointer** | engineering leaders | pointer.io | Medium (lead with the CTO angle: exec summary, CISO report) |
| **DevOps'ish / SRE Weekly** | ops/SRE | per-site submit | Medium (lead with CI gate + watchdog) |

---

## Template A — tool-directory pitch (Console.dev, Changelog)

Subject: **GateTest — QA gate that opens the PR that fixes what it finds**

Hi [name],

GateTest is a CI quality gate that runs 110 checks (security, reliability,
a11y, AI-safety) and then — the part that's different — opens a pull
request that *fixes* what it found: each fix is re-validated against the
scanner, gets an auto-written regression test, and is pair-reviewed by a
second AI pass before the PR ships. Pay-per-scan, no subscription, no
seats.

Two things your readers can try in under a minute, free, no signup:
- Scan any public website in a real browser: https://gatetest.ai/web
- Run the MIT-licensed CLI on any repo: `npx github:crclabs-hq/GateTest`

Honest detail your readers will appreciate: we run GateTest on GateTest —
the homepage shows the live self-scan result, including the modules that
are currently red on our own repo.

Happy to provide a demo repo, screenshots, or anything else useful.

[Craig]

---

## Template B — link suggestion (TLDR, Bytes, JS Weekly — they want a LINK, not a pitch)

Suggested link: https://gatetest.ai
Suggested blurb (their voice, feel free to edit):

> **GateTest** — a QA gate with a party trick: it doesn't just fail your
> CI, it opens the PR that fixes the failure, with a regression test and
> a second-AI pair review attached. 110 checks, pay-per-scan pricing,
> free no-signup website scan to try it.

---

## Template C — the data-story pitch (send AFTER docs/launch/data-story.md ships)

Subject: **Data: we scanned [N] public sites with a real browser — [headline stat]**

Hi [name],

We ran [N] public websites through a headless-browser scan (runtime JS
errors, CSP, TLS, cookies, headers — not just static checks) and wrote up
what we found: [1-2 headline stats, e.g. "X% ship at least one uncaught
runtime error on their homepage"].

Full methodology + data: [link to gatetest.ai/blog post]

It's vendor-neutral enough to stand on its own — the scanner we used is
ours, which is disclosed in the writeup.

[Craig]

---

## Rules

1. One newsletter per day max — replies come in waves and you want to be
   able to answer them.
2. Never pay for inclusion before organic submission has been tried.
3. If they ask "what's new/different": the answer is the fix loop
   (fix → re-scan → regression test → pair-review) on per-scan pricing —
   not the module count.
4. Track in the table below.

| Newsletter | Sent | Reply | Included? | Traffic notes |
|---|---|---|---|---|
| | | | | |
