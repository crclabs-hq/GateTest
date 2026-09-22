/**
 * The questions a sceptical engineer asks first, answered with the mechanism.
 */
const QA = [
  {
    q: "Will it block my whole backlog on day one?",
    a: "No. `gatetest --baseline` snapshots every current finding into .gatetest/baseline.json, you commit it, and the gate fails only on findings not in it. Baselined findings stay visible in every report and are counted per file, so a new one cannot hide behind an old one.",
  },
  {
    q: "How do I know the rules are not over-firing?",
    a: "The corpus above. Every push scans 20 pinned commits of repositories we do not control; each has a ceiling that only ratchets down, and the numbers are published including the bad ones. A rule that starts over-firing on express or Django turns our CI red before yours.",
  },
  {
    q: "What does the model actually do?",
    a: "Nothing in the default scan; that is deterministic and reproducible. On the fix tiers a model writes a patch for a located finding, the gate re-runs on the patch, a regression test is added, and a second model reviews the diff. The CLI and local MCP server run on your own key.",
  },
  {
    q: "What is reported when something could not run?",
    a: "It says so, in the terminal, the PR comment and the JSON: 'not checked' with the reason. A pass from silence is treated as the worst bug in this codebase.",
  },
  {
    q: "Where does my code go?",
    a: "The CLI, the Action, the editor extension and the local MCP server run where you run them; nothing is uploaded. Hosted scans read the repository over HTTPS on our box and keep the report for the share window. The GitHub App uses scoped permissions and short-lived installation tokens; every webhook is HMAC-verified and fails closed.",
  },
];

export function Faq() {
  return (
    <dl className="grid gap-0 border-t border-[var(--v2-line-strong)]">
      {QA.map((x) => (
        <div key={x.q} className="grid gap-3 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] py-6 border-b border-[var(--v2-line)]">
          <dt className="font-medium">{x.q}</dt>
          <dd className="text-[15px] leading-relaxed text-[var(--v2-muted)]">{x.a}</dd>
        </div>
      ))}
    </dl>
  );
}
