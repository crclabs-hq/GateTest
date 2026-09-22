/**
 * Where the same engine runs. A table, because the reader is comparing
 * identifiers, not admiring cards.
 */
const ROWS = [
  { where: "GitHub App", id: "github.com/apps/gatetest-hq", price: "free gate on every push", out: "commit status, PR comment", href: "https://github.com/apps/gatetest-hq" },
  { where: "GitHub Action", id: "uses: crclabs-hq/GateTest@v1", price: "free, public and private", out: "gate, SARIF, JUnit, baseline", href: "https://github.com/marketplace/actions/gatetest-quality-gate" },
  { where: "Terminal", id: "npx -p @gatetest/cli gatetest --suite quick", price: "free, offline, MIT", out: "verdict, exit code, JSON", href: "https://www.npmjs.com/package/@gatetest/cli" },
  { where: "VS Code / Open VSX", id: "GateTestHQ.gatetest", price: "free, nothing leaves the machine", out: "findings in the Problems panel", href: "https://marketplace.visualstudio.com/items?itemName=GateTestHQ.gatetest" },
  { where: "AI agent (MCP)", id: "npx @gatetest/mcp-server", price: "free on your own keys", out: "24 tools: scan, explain, fix, run tests, verify", href: "/mcp" },
  { where: "GitLab / CircleCI", id: "gatetest --ci-init gitlab | circleci", price: "free", out: "a complete pipeline file", href: "/quickstart" },
  { where: "Any live site", id: "gatetest --crawl https://example.com", price: "free preview, no repo", out: "headers, TLS, links, a11y, SEO per page", href: "/web" },
];

export function Runs() {
  return (
    <div className="overflow-x-auto">
      <table className="v2-table">
        <thead>
          <tr>
            <th>Where</th>
            <th>Identifier</th>
            <th>Cost</th>
            <th>Output</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((r) => (
            <tr key={r.where}>
              <td className="whitespace-nowrap"><a href={r.href} className="underline decoration-[var(--v2-line-strong)] underline-offset-4 hover:decoration-[var(--v2-fg)]">{r.where}</a></td>
              <td className="v2-mono text-[13px] whitespace-nowrap">{r.id}</td>
              <td className="text-[var(--v2-muted)]">{r.price}</td>
              <td className="text-[var(--v2-muted)]">{r.out}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
