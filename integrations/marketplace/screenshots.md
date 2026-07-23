# GitHub Marketplace Screenshots Guide

GitHub Marketplace allows up to 10 screenshots. Capture at least 5. All screenshots must be
1280×800 px (or 2560×1600 px for retina). PNG format preferred. No sensitive data visible.

---

## Screenshot 1 — PR commit status (pass)

**Caption:** "GateTest posts a pass/fail status on every pull request"

**What to capture:**
- Open a pull request on a test repository where GateTest is installed and the scan passes.
- Scroll to the **Checks** section at the bottom of the PR (below the timeline, above the merge button).
- The GateTest check should show a green checkmark with the text "GateTest — Quality Gate" and a subtitle like "All 120 modules passed · 0 errors · 0 warnings".
- The merge button should be green and unblocked.
- Frame the screenshot to show: the PR title at the top, the diff summary line, and the full checks section.
- Include the browser chrome (URL bar showing `github.com/...`) for authenticity.
- Use a real-looking repository name — e.g. `acme-corp/api-service` or `my-startup/web-app`.

**Why this screenshot matters:** First thing buyers want to know — "what does it look like in my PR?"

---

## Screenshot 2 — PR comment with scan results (issues found)

**Caption:** "Detailed findings posted directly in the PR — every issue, every line"

**What to capture:**
- Open a pull request where GateTest found real issues (or a staged repo with intentional bugs).
- Scroll to the GateTest bot comment on the PR timeline.
- The comment should show:
  - A header like "GateTest Scan Results — 3 errors, 12 warnings"
  - A table or list of failing modules with issue counts
  - At least 2–3 specific issue examples with file path, line number, and description. For example:
    - `src/api/proxy.js:47` — **SSRF** — User-controlled URL passed to `fetch()` without validation
    - `src/db/users.ts:112` — **N+1 Query** — `prisma.post.findMany()` called inside `.map()` loop
    - `.github/workflows/deploy.yml:23` — **CI Security** — Action pinned to tag, not SHA
  - A "View full report on GateTest" button or link
- The GateTest bot avatar should be visible to the left of the comment.
- Do NOT capture any real secrets or PII — use obviously fake data.

**Why this screenshot matters:** Shows the depth of analysis. Buyers see they get precise, actionable output, not vague scores.

---

## Screenshot 3 — Auto-fix PR diff

**Caption:** "GateTest opens a fix PR automatically — review the diff, merge, done"

**What to capture:**
- Open the auto-fix PR that GateTest created (on Scan + Fix or Nuclear tier).
- Show the **Files changed** tab of the fix PR.
- The diff should show a real, sensible fix — for example:
  - Before: `rejectUnauthorized: false` in an HTTPS agent options object
  - After: `rejectUnauthorized: true` (or the option removed entirely)
  - Or: A `catch` block that was empty (`catch (err) {}`) now re-throws (`catch (err) { throw err; }`)
- The PR title should be something like: "fix: GateTest auto-fix — 3 security issues"
- The PR description should show GateTest's explanation of what was changed and why.
- Show the green "1 file changed" badge at the top of the Files tab.
- The PR should be opened by the GateTest bot account, not a human account.

**Why this screenshot matters:** Auto-fix is GateTest's biggest differentiator. This screenshot closes the sale for buyers who are tired of reading reports and fixing issues manually.

---

## Screenshot 4 — gatetest.ai landing page

**Caption:** "Scan any repository in seconds from gatetest.ai"

**What to capture:**
- Navigate to `https://gatetest.ai` in a browser with the dark theme rendering correctly.
- Capture the **hero section** (top of the page, above the fold) showing:
  - The GateTest logo and headline
  - The animated background / terminal animation (capture mid-animation if possible)
  - The primary CTA button ("Start a Scan" or "Scan Your Repo")
  - The "120 modules" stat tiles (capture whatever stat tiles the live hero actually renders — never a number the site doesn't show)
- Use a 1280×800 viewport. If the page looks better at a larger size, crop to 1280×800 centred on the hero.
- Dark mode only — the site is designed dark-first.
- Ensure no localhost URLs or test content is visible in the screenshot.

**Why this screenshot matters:** Marketplace visitors check if the product looks professional. A stunning landing page builds confidence.

---

## Screenshot 5 — Live scan results dashboard

**Caption:** "Watch 120 modules scan your repo in real time"

**What to capture:**
- Navigate to the scan status page (`https://gatetest.ai/scan/status?session_id=...`) for a completed scan.
- The page should be in its **completed** state — showing the full results breakdown, not the loading state.
- Ideally shows:
  - The "Scan Complete" header with a green pass indicator
  - A list of modules with their status (pass ✅ / fail ❌) and issue counts
  - A summary score or grade
  - The "View Full Report" or "Download SARIF" button
- Capture the full page or the top half of the results — whichever shows more useful information at 1280×800.
- Use a scan result from a real or realistic test repository. Ensure no secrets, PII, or internal URLs are visible.

**Why this screenshot matters:** Shows buyers the complete experience — from install to results. Reduces purchase anxiety by making the end state visible before they commit.

---

## Optional screenshot 6 — Module list

**Caption:** "120 modules covering security, quality, infrastructure, and more"

**What to capture:**
- Run `node bin/gatetest.js --list` in a terminal and capture the output.
- A modern terminal (iTerm2, Warp, or similar) with a dark theme preferred.
- The output should show all 120 modules with their names and descriptions in a clean, readable format.
- Crop to show approximately 30–40 modules at once so the list density is visible.

---

## Tips for all screenshots

- Use a **real browser** (Chrome or Safari), not a headless screenshot tool — the rendering looks more authentic.
- **Dark mode** for the gatetest.ai screenshots (the site is designed for it).
- **No browser extensions visible** — hide extension icons from the toolbar.
- **No personal account names visible** — use a test GitHub account or blur your username.
- **Consistent resolution** — 1280×800 or 2560×1600 (retina) for all screenshots.
- Compress PNGs with `pngcrush` or `optipng` before uploading — GitHub has a 5 MB per-image limit.
