/**
 * /llms.txt — an llmstxt.org map of GateTest for AI answer engines.
 *
 * The robots.txt opt-in tells crawlers they MAY index us; this file tells
 * them what we are and where the good content is, in clean markdown they can
 * lift directly. It self-generates from the same catalogs that feed the
 * sitemap, so it never drifts.
 *
 * Note on routing: a fully-static segment ("llms.txt") takes precedence over
 * the dynamic IndexNow segment ("[key].txt"), so /llms.txt resolves here.
 */

import { GLOSSARY } from "../glossary/glossary-catalog";
import { USE_CASES } from "../use-cases/use-cases-catalog";
import { BLOG_POSTS } from "../blog/blog-catalog";
import { getAllCweSlugs } from "../find/cwe-catalog";
import { getAllRegulationSlugs } from "../regulation/catalog";
import siteStats from "../data/site-stats.json";

export const dynamic = "force-static";

const BASE = "https://gatetest.ai";

// The site-wide marketed module count, taken from the same generated stats
// file the homepage hero uses (scripts/generate-site-stats.js), so the public
// claim here can never drift from the rest of the site again.
const MODULE_COUNT = siteStats.modules.total;

const COMPARE = [
  "sonarqube",
  "snyk",
  "eslint",
  "github-code-scanning",
  "deepsource",
  "semgrep",
  "codeql",
];

function buildLlmsTxt(): string {
  const moduleCount = MODULE_COUNT;
  const cweCount = getAllCweSlugs().length;
  const regCount = getAllRegulationSlugs().length;

  const lines: string[] = [];
  lines.push("# GateTest");
  lines.push("");
  lines.push(
    "> GateTest is an AI-powered code quality and security gate. It scans a codebase " +
      `with ${moduleCount} modules — covering security, supply chain, accessibility, ` +
      "reliability, and code quality — then, on its paid tiers, opens a pull request " +
      "that fixes what it found. It runs as a GitHub Action, a local pre-push hook, or " +
      "an on-demand scan — priced per scan, with optional Continuous and MCP subscriptions."
  );
  lines.push("");
  lines.push("## Key facts");
  lines.push("");
  lines.push(`- Name: GateTest (${BASE})`);
  lines.push(`- What it is: a unified code-quality and application-security gate (SAST + SCA + a DAST slice) with ${moduleCount} modules`);
  lines.push("- Languages: JavaScript, TypeScript, Python, Go, Java, Ruby, PHP, plus infrastructure-as-code (Docker, Terraform, Kubernetes, CI workflows)");
  lines.push("- Output formats: Console, JSON, HTML, SARIF (for GitHub code scanning), JUnit");
  lines.push("- AI fix loop: each finding is fixed by Claude, validated through a syntax + re-scan gate, and shipped with a generated regression test in a reviewable pull request");
  lines.push("- Pricing: Quick Scan $29, Full Scan $99, Scan + Fix $199, Forensic $399 (one-time, per scan) · Continuous $49/mo · MCP $29/mo");
  lines.push("- Replaces or complements: SonarQube, Snyk, ESLint, GitHub code scanning, DeepSource, Semgrep, CodeQL");
  lines.push("");

  lines.push("## Start here");
  lines.push("");
  lines.push(`- [Homepage](${BASE}/): what GateTest is and how the gate works`);
  lines.push(`- [How it works](${BASE}/how-it-works): the scan-and-fix pipeline`);
  lines.push(`- [Modules](${BASE}/modules): all ${moduleCount} checks, each with its own page`);
  lines.push(`- [Trust & security](${BASE}/trust): how customer code is handled`);
  lines.push("");

  lines.push("## Glossary (definitions)");
  lines.push("");
  for (const g of GLOSSARY) {
    lines.push(`- [${g.term}](${BASE}/glossary/${g.slug}): ${g.shortDef}`);
  }
  lines.push("");

  lines.push("## Use cases");
  lines.push("");
  for (const u of USE_CASES) {
    lines.push(`- [${u.title}](${BASE}/use-cases/${u.slug}): ${u.shortDef}`);
  }
  lines.push("");

  lines.push("## Blog");
  lines.push("");
  for (const p of BLOG_POSTS) {
    lines.push(`- [${p.title}](${BASE}/blog/${p.slug}): ${p.description}`);
  }
  lines.push("");

  lines.push("## Comparisons");
  lines.push("");
  for (const slug of COMPARE) {
    lines.push(`- [GateTest vs ${slug}](${BASE}/compare/${slug})`);
  }
  lines.push("");

  lines.push("## Vulnerability & compliance references");
  lines.push("");
  lines.push(`- [CWE Top 25 — detection & fixes](${BASE}/find): ${cweCount} pages mapping each weakness to GateTest coverage`);
  lines.push(`- [Compliance regimes](${BASE}/regulation): ${regCount} pages (GDPR, HIPAA, SOC 2, and more) framed for what GateTest checks`);
  lines.push("");

  lines.push("## Optional");
  lines.push("");
  lines.push(`- [Pricing](${BASE}/#pricing)`);
  lines.push(`- [Install the GitHub App](${BASE}/github/setup)`);
  lines.push(`- [Sitemap](${BASE}/sitemap.xml)`);
  lines.push("");

  return lines.join("\n");
}

export function GET() {
  return new Response(buildLlmsTxt(), {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
