"use client";

import { useEffect, useRef, useState, useCallback } from "react";

/**
 * One push, replayed. The terminal types the real quick-suite output captured
 * on 2026-09-22 from reliability-corpus/known-bad/sqli-string-concat (GATE:
 * BLOCKED, exit 1). As it does, the GitHub panel on the right moves through
 * the four things a team actually sees: the check going red, the PR comment
 * with the finding and its ignore line, the fix PR with a diff and a test,
 * and the check going green. Twelve seconds, then it loops. Reduced-motion
 * users get the final frame, static.
 */

// Lines exactly as the CLI printed them, minus the module roll-call.
const TERMINAL: Array<{ t: string; cls?: string }> = [
  { t: "$ npx -p @gatetest/cli gatetest --suite quick", cls: "dim" },
  { t: "  [RUN] crossFileTaint  [FAIL]  (2 errors, 18ms)", cls: "bad" },
  { t: "  ----------------------------------------" },
  { t: "  GATE: BLOCKED", cls: "bad" },
  { t: "  Checks:   62/67 passed" },
  { t: "  Errors:   2" },
  { t: "  Warnings: 3" },
  { t: "  Time:     1608ms" },
  { t: "" },
  { t: "  What's blocking you" },
  { t: "  ✗ src/handler.js:12", cls: "bad" },
  { t: "      Taint: `q` (from request input) reaches" },
  { t: "      `sql-query` sink without sanitisation" },
  { t: "      wrong? add to .gatetestignore:", cls: "dim" },
  { t: "      crossFileTaint@src/handler.js", cls: "dim" },
  { t: "$ echo $?", cls: "dim" },
  { t: "1", cls: "bad" },
];

type Phase = 0 | 1 | 2 | 3 | 4;
// phase 0: typing · 1: check failing · 2: PR comment · 3: fix PR · 4: check green
const PHASE_AT_MS = [0, 3400, 5200, 7600, 10400];
const LOOP_MS = 13500;
const TYPE_MS = 190;

export function LiveRun() {
  const [lines, setLines] = useState(0);
  const [phase, setPhase] = useState<Phase>(0);
  const [reduced, setReduced] = useState(false);
  const startRef = useRef<number>(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const tick = useCallback(() => {
    const t = (performance.now() - startRef.current) % LOOP_MS;
    setLines(Math.min(TERMINAL.length, Math.floor(t / TYPE_MS)));
    let p: Phase = 0;
    for (let i = PHASE_AT_MS.length - 1; i >= 0; i--) {
      if (t >= PHASE_AT_MS[i]) { p = i as Phase; break; }
    }
    setPhase(p);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mq.matches) {
      setReduced(true);
      setLines(TERMINAL.length);
      setPhase(4);
      return;
    }
    // The resting state (this synchronous call) is correct with no observer
    // and no timer running at all — the interval below is a decorative
    // enhancement, not a correctness dependency (same rule as the /preview
    // Numbers fix, issue #678 defect 1).
    startRef.current = performance.now();
    tick();

    // One tick per typed line, not per animation frame: the page stays idle
    // between ticks, which matters for battery, for screenshot tooling that
    // waits for the page to settle, and for the 95+ performance budget.
    //
    // The interval only RUNS while this section is on screen. Measured on
    // an iPad Pro 11 (WebKit) with Playwright: scrolling past /preview with
    // this interval always running produced 44 dropped frames (>25ms) in a
    // 2.5s scroll versus 5 on a static control page in the same run; pausing
    // it off-screen dropped that to single digits, matching the control —
    // the fix is pausing background work during scroll, not the observer
    // controlling what content is shown, which stays correct regardless.
    let id: number | undefined;
    const start = () => { if (id === undefined) id = window.setInterval(tick, TYPE_MS); };
    const stop = () => { if (id !== undefined) { window.clearInterval(id); id = undefined; } };

    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      start();
      return () => stop();
    }
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) start(); else stop(); },
      { threshold: 0 },
    );
    io.observe(el);
    return () => { io.disconnect(); stop(); };
  }, [tick]);

  const replay = () => { startRef.current = performance.now(); };
  const checkState = phase === 0 ? "pending" : phase < 4 ? "failure" : "success";
  const checkText =
    phase === 0 ? "GateTest Quality Gate — queued"
    : phase < 4 ? "GateTest Quality Gate — 2 blocking findings in this diff"
    : "GateTest Quality Gate — 0 blocking · 3 warnings";

  return (
    <div ref={rootRef} className="grid gap-4 lg:grid-cols-[1.05fr_1fr] items-start">
      {/* Terminal. min-w-0: below `lg` this grid has one implicit column, so
          without an explicit min-width this item's automatic minimum size is
          its own content's rather than the track's — at 375px that pushed
          both this and the GitHub panel past the viewport (issue #678
          defect 3, same shape as the live homepage's Hero.tsx). */}
      <div className="term min-w-0" aria-label="Terminal output of a quick-suite scan">
        <div className="term-head">
          <span>gatetest --suite quick</span>
          <span className={lines >= TERMINAL.length ? "bad" : "dim"}>{lines >= TERMINAL.length ? "exit 1" : "running"}</span>
        </div>
        <div className="term-body">
          {TERMINAL.slice(0, lines).map((l, i) => (
            <div key={i} className={l.cls}>{l.t || " "}</div>
          ))}
          {lines < TERMINAL.length && <span className="caret" aria-hidden="true" />}
        </div>
      </div>

      {/* GitHub side */}
      <div className="flex flex-col gap-3 min-w-0">
        <div className="gh">
          <div className="gh-head">
            <span className="v2-mono">your-org/your-repo</span>
            <span>·</span>
            <span>pull request #248</span>
            <span className="ml-auto gh-label">Checks</span>
          </div>
          <div className="gh-row">
            <span className="gh-dot" data-s={checkState} />
            <span>{checkText}</span>
          </div>
          <div className="gh-row">
            <span className="gh-dot" data-s="success" />
            <span>build — 41s</span>
          </div>
        </div>

        {phase >= 2 && (
          <div className="gh v2-in" aria-live="polite">
            <div className="gh-head">
              <span className="font-semibold text-[var(--v2-fg)]">gatetest-hq</span>
              <span className="gh-label">bot</span>
              <span>commented</span>
            </div>
            <div className="gh-comment">
              <div className="font-semibold mb-1">2 blocking findings in this diff</div>
              <div><code>src/handler.js:12</code> — <code>q</code> from request input reaches a <code>sql-query</code> sink without sanitisation.</div>
              <div><code>src/handler.js:20</code> — <code>result</code> from request input reaches a <code>sql-query</code> sink without sanitisation.</div>
              <div className="mt-2 text-[var(--v2-muted)]">Not checked: 5 of 67 checks skipped (no ESLint config, no lockfile). Wrong? reply <code>@gatetest ignore crossFileTaint@src/handler.js</code>.</div>
            </div>
          </div>
        )}

        {phase >= 3 && (
          <div className="gh v2-in">
            <div className="gh-head">
              <span className="gh-dot" data-s={phase >= 4 ? "success" : "pending"} />
              <span className="font-semibold text-[var(--v2-fg)]">fix: parameterise the SQL in handler.js</span>
              <span className="ml-auto gh-label">PR #249</span>
            </div>
            <div className="gh-diff">
              <div className="del">{`- db.query("SELECT * FROM users WHERE name = '" + q + "'")`}</div>
              <div className="add">{`+ db.query("SELECT * FROM users WHERE name = $1", [q])`}</div>
              <div className="add">{`+ tests/handler.sql.test.js   1 regression test`}</div>
            </div>
            <div className="gh-row text-[var(--v2-muted)]">
              gate re-run on the patch: 0 blocking · reviewed by a second model · ready for your review
            </div>
          </div>
        )}
      </div>

      <div className="lg:col-span-2 flex flex-wrap items-center justify-between gap-3 v2-kicker">
        <span>
          Terminal output captured 2026-09-22 on reliability-corpus/known-bad/sqli-string-concat, exit code 1. The comment and fix PR are the same finding as the fix tiers render it.
        </span>
        {!reduced && (
          <button type="button" onClick={replay} className="v2-btn h-8 px-3 text-xs" aria-label="Replay the run">
            replay
          </button>
        )}
      </div>
    </div>
  );
}
