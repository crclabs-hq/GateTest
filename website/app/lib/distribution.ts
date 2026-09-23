// Where GateTest ships — the ONE definition (Doctrine §4).
//
// Every surface that says "get GateTest here" (homepage, nav, docs) imports
// this list. Nothing is listed until it is live and verified: a channel that
// 404s is a broken promise on the homepage, not a roadmap item.
//
// Verified 2026-09-16:
//   VS Code Marketplace   item page 200, gallery flags "validated, public"
//   Open VSX              open-vsx.org/api/GateTestHQ/gatetest 200 at 1.1.3 — the registry
//                         Cursor, Windsurf, VSCodium, Gitpod and Eclipse Theia read
//   npm @gatetest/cli     1.61.1 — bare `npx @gatetest/cli` resolves (the `cli` bin)
//   GitHub Action         github.com/marketplace/actions/gatetest-quality-gate 200
//   npm @gatetest/mcp-server 1.1.3 — linked via /mcp, which owns the install copy
//   gatetest.io/web, /wp  200
//
// NOT listed yet (each has a Craig-only step; see docs/marketplace/DISTRIBUTION-CHANNELS.md):
//   GitHub App Marketplace page              App still private
//   Docker image on ghcr.io                  publishes on the v1.61.1 tag
//   WordPress.org plugin directory           not submitted
//
// tests/distribution-surfaces.test.js pins every href to a route that exists
// or a host on the allow-list, and pins the VS Code identity to the
// extension's own manifest. tests/github-app-identity.test.js allows the
// Marketplace publisher name in THIS file only — it spells the same word as
// the stale GitHub App slug and is unrelated to it.

// The Marketplace identifier is `<publisher>.<name>` from vscode-extension/package.json.
// A literal here, not an import: the website builds standalone (Docker image,
// box deploy) where ../../../vscode-extension is outside the build context.
// tests/distribution-surfaces.test.js fails the suite if this drifts from the manifest.
const VSCODE_EXTENSION_ID = "GateTestHQ.gatetest";
export const VSCODE_MARKETPLACE_URL = `https://marketplace.visualstudio.com/items?itemName=${VSCODE_EXTENSION_ID}`;
// Open VSX addresses the same extension as `<publisher>/<name>` — derived from
// the one identity above, never typed a second time. publish-vscode.yml pushes
// the same .vsix to both registries on the same run.
const [VSCODE_PUBLISHER, VSCODE_EXTENSION_NAME] = VSCODE_EXTENSION_ID.split(".");
const OPEN_VSX_URL = `https://open-vsx.org/extension/${VSCODE_PUBLISHER}/${VSCODE_EXTENSION_NAME}`;

const GITHUB_ACTION_MARKETPLACE_URL = "https://github.com/marketplace/actions/gatetest-quality-gate";
const NPM_CLI_URL = "https://www.npmjs.com/package/@gatetest/cli";
const NPM_MCP_URL = "https://www.npmjs.com/package/@gatetest/mcp-server";

type Surface = {
  id: string;
  /** Where the visitor is when this is the right door. */
  where: string;
  title: string;
  /** One sentence that sells the outcome, not the mechanism. */
  pitch: string;
  /** Copy-paste install, or null when the CTA is the install. */
  snippet: string | null;
  cta: { label: string; href: string; external?: boolean };
  /** The barrier that is NOT there. Must be true. */
  free: string;
};

export const SURFACES: Surface[] = [
  {
    id: "vscode",
    where: "In your editor",
    title: "VS Code extension",
    pitch: "The whole engine in your Problems panel. Every finding lands on the line that caused it, before you commit.",
    snippet: null,
    cta: { label: "Install from the Marketplace", href: VSCODE_MARKETPLACE_URL, external: true },
    free: "Free. No account. Nothing leaves your machine.",
  },
  {
    id: "openvsx",
    where: "In Cursor, Windsurf or VSCodium",
    title: "Open VSX extension",
    pitch: "The same extension for every editor that reads the Open VSX registry. Search GateTest in Extensions, or install it from the listing.",
    snippet: null,
    cta: { label: "Install from Open VSX", href: OPEN_VSX_URL, external: true },
    free: "Free. No account. Nothing leaves your machine.",
  },
  {
    id: "cli",
    where: "In your terminal",
    title: "CLI on npm",
    pitch: "One command scans any folder and prints a verdict, the exact lines, and the fix for each. Open source, MIT.",
    snippet: "npx --yes @gatetest/cli --suite quick",
    cta: { label: "@gatetest/cli on npm", href: NPM_CLI_URL, external: true },
    free: "Free forever. Runs offline.",
  },
  {
    id: "action",
    where: "In your CI",
    title: "GitHub Action",
    pitch: "A gate on every pull request that blocks on what matters and stays quiet on what does not. Baselines, diff scope, SARIF built in.",
    snippet: "uses: crclabs-hq/GateTest@v1",
    cta: { label: "On the GitHub Marketplace", href: GITHUB_ACTION_MARKETPLACE_URL, external: true },
    free: "Free for public and private repos.",
  },
  {
    id: "mcp",
    where: "In your AI agent",
    title: "MCP server",
    pitch: "Give your coding agent the scanner, the test runner and the fix verifier as tools. It finds the bug, fixes it, and proves the fix.",
    snippet: null,
    cta: { label: "Connect an agent", href: "/mcp" },
    free: "Free on your own machine, on your own keys.",
  },
  {
    id: "web",
    where: "On any live site",
    title: "Website scan",
    pitch: "Paste a URL. A real browser loads the real page and reports what your visitors actually hit.",
    snippet: null,
    cta: { label: "Scan a website", href: "/web" },
    free: "Free preview. No repo, no signup.",
  },
  {
    id: "wordpress",
    where: "On your WordPress site",
    title: "WordPress health check",
    pitch: "The checks WordPress owners get burned by, in plain English, ranked by what to fix first.",
    snippet: null,
    cta: { label: "Check a WordPress site", href: "/wp" },
    free: "Free preview. No plugin to install.",
  },
];
