/**
 * How it works, shown as the three artifacts a team receives rather than as
 * three icons. Each panel is the raw payload or markdown the product writes,
 * so a reader can check it against what lands in their repo.
 */
const STATUS_PAYLOAD = `POST /repos/your-org/your-repo/statuses/9f2c1a7
{
  "state": "failure",
  "context": "GateTest Quality Gate",
  "description": "2 blocking findings in this diff · 5 checks not run",
  "target_url": "https://gatetest.io/scan/scn_4b1e…"
}`;

const COMMENT_MD = `## 2 blocking findings in this diff

| File | Finding | Reply to ignore |
| --- | --- | --- |
| src/handler.js:12 | \`q\` from request input reaches a \`sql-query\` sink | \`@gatetest ignore crossFileTaint@src/handler.js\` |
| src/handler.js:20 | \`result\` from request input reaches a \`sql-query\` sink | same |

**Not checked:** lint (no ESLint config), dependencies (no lockfile).
Baseline: .gatetest/baseline.json @ 3 findings — none of them counted here.`;

const FIX_MD = `## fix: parameterise the SQL in handler.js

- src/handler.js: two queries rewritten with placeholders
- tests/handler.sql.test.js: regression test for both sinks (added)
- Gate re-run on this patch: 0 blocking · 3 warnings
- Second-model review: approved, no scope creep

Cost of this fix: 38 s · ~$0.02 API`;

const STEPS = [
  {
    stage: "gate",
    n: "01",
    title: "Every push sets a commit status",
    body: "The App or the Action runs the deterministic checks on the diff, scores them against the committed baseline, and writes one status. A blocking finding means exit 1 and a red check. Nothing else in your pipeline changes.",
    code: STATUS_PAYLOAD,
    lang: "http",
  },
  {
    stage: "findings",
    n: "02",
    title: "One comment names the findings and what was not run",
    body: "Line-attributed, with the exact ignore reply beside each finding. Checks that could not run are listed, never silently counted as passed. Baselined findings stay visible and stay out of the verdict.",
    code: COMMENT_MD,
    lang: "markdown",
  },
  {
    stage: "fix",
    n: "03",
    title: "On the fix tiers, a pull request with the patch and its test",
    body: "A model writes the patch; the gate re-runs on it; a regression test is added; a second model reviews the diff. You review and merge, or reply to reject. Pricing is per run, not per seat.",
    code: FIX_MD,
    lang: "markdown",
  },
];

export function Artifacts() {
  return (
    <div className="grid gap-12">
      {STEPS.map((s) => (
        <div key={s.n} id={s.stage === "gate" ? undefined : s.stage} data-stage={s.stage === "gate" ? undefined : s.stage} className="grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] items-start">
          <div>
            <div className="v2-kicker mb-3">{s.n}</div>
            <h3 className="v2-h2">{s.title}</h3>
            <p className="mt-4 text-[15px] leading-relaxed text-[var(--v2-muted)] max-w-md">{s.body}</p>
          </div>
          <div className="gh">
            <div className="gh-head"><span className="v2-mono">{s.lang}</span></div>
            <pre className="gh-diff text-[var(--v2-fg)]">{s.code}</pre>
          </div>
        </div>
      ))}
    </div>
  );
}
