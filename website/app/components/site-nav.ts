/**
 * The site's navigation — ONE definition, consumed by the header, the mobile
 * drawer and the footer. Copy here is customer-facing; keep it short and
 * concrete. Module counts come from the generated stats, never typed.
 */
import siteStats from "../data/site-stats.json";

export type NavItem = { label: string; href: string; desc?: string; external?: boolean };
export type NavGroup = { label: string; items: NavItem[] };

const modules = siteStats.modules.total;

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Product",
    items: [
      { label: "Scan a repo free", href: "/playground", desc: "Any public repository. No signup." },
      { label: "Modules", href: "/modules", desc: `All ${modules}, generated from the engine.` },
      { label: "Precision", href: "/precision", desc: "Measured on real repositories. Bad numbers included." },
      { label: "How it works", href: "/how-it-works", desc: "Scan, fix, verify, open the PR." },
      { label: "Compare", href: "/compare", desc: "SonarQube, Snyk, CodeQL, Semgrep and more." },
      { label: "Hall of scans", href: "/scans", desc: "Real scans of real open-source repos." },
    ],
  },
  {
    label: "Solutions",
    items: [
      { label: "GitHub", href: "/github/setup", desc: "Install the App. Every push and PR gets a gate." },
      { label: "Gluecron", href: "https://gluecron.com", desc: "Our git host, with the gate built in.", external: true },
      { label: "WordPress", href: "/wp", desc: "Scan a WordPress site. No code, no plugin." },
      { label: "Websites", href: "/web", desc: "Scan any URL for security, a11y and performance." },
      { label: "MCP & AI editors", href: "/mcp", desc: "Claude, Cursor and VS Code run the gate for you." },
      { label: "CLI & GitHub Action", href: "/developers", desc: "Open source. Runs in your own CI." },
    ],
  },
  {
    label: "Ecosystem",
    items: [
      { label: "Gluecron", href: "https://gluecron.com", desc: "Git hosting where every push is gated.", external: true },
      { label: "Vapron", href: "https://vapron.ai", desc: "The platform that runs what you ship.", external: true },
      { label: "How the stack fits", href: "/stack", desc: "GateTest gates it. Gluecron hosts it. Vapron runs it." },
    ],
  },
];

export const NAV_LINKS: NavItem[] = [
  { label: "Docs", href: "/developers" },
  { label: "Pricing", href: "/pricing" },
];

export const NAV_ACTIONS = {
  signIn: { label: "Sign in", href: "/dashboard" },
  install: { label: "Install GitHub App", href: "/github/setup" },
  primary: { label: "Scan free", href: "/playground" },
} as const;
