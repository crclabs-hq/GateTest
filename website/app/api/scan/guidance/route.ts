/**
 * Manual Fix Guidance Generator — for issues that can't be auto-fixed.
 *
 * POST /api/scan/guidance
 * Body: { issues: [{ module, detail }] }
 *
 * Returns step-by-step guidance for each issue: what it means, why it matters,
 * and exact commands/code to fix it. Uses Claude to generate human guidance
 * when the issue doesn't match a known pattern.
 */

import { NextRequest, NextResponse } from "next/server";
import { httpsJsonRequest } from "../../../lib/github-app";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

interface IssueInput {
  module: string;
  detail: string;
}

interface Guidance {
  module: string;
  detail: string;
  title: string;
  why: string;
  steps: string[];
  commands?: string[];
}

// Known patterns — instant guidance without calling Claude.
const PATTERNS: Array<{
  match: RegExp;
  gen: (m: RegExpMatchArray, issue: IssueInput) => Guidance;
}> = [
  {
    match: /missing\s+license/i,
    gen: (_, i) => ({
      module: i.module,
      detail: i.detail,
      title: "Add a LICENSE file",
      why: "Without a LICENSE, your code is legally 'all rights reserved' by default — nobody can legally use it.",
      steps: [
        "Decide on a license (MIT is most permissive, Apache 2.0 adds patent protection, GPL requires derivatives to be open source)",
        "Create a LICENSE file in the repo root",
        "Copy the license text from choosealicense.com",
        "Add the current year and your/company name",
      ],
      commands: [`curl -o LICENSE https://raw.githubusercontent.com/licenses/license-templates/master/templates/mit.txt`],
    }),
  },
  {
    match: /dependency.*(vulnerab|advisory|cve)/i,
    gen: (_, i) => ({
      module: i.module,
      detail: i.detail,
      title: "Patch vulnerable dependency",
      why: "A dependency you use has a known security vulnerability. Attackers can exploit this.",
      steps: [
        "Run `npm audit` to see the full list of vulnerabilities",
        "Run `npm audit fix` to auto-patch what can be fixed safely",
        "For breaking changes, run `npm audit fix --force` (test afterwards)",
        "If a transitive dep can't be updated, use npm overrides in package.json",
      ],
      commands: ["npm audit", "npm audit fix", "npm audit fix --force"],
    }),
  },
  {
    match: /typescript.*error/i,
    gen: (_, i) => ({
      module: i.module,
      detail: i.detail,
      title: "Fix TypeScript errors",
      why: "TypeScript errors mean the code doesn't compile. It will crash at runtime.",
      steps: [
        "Run `tsc --noEmit` to see every error at once",
        "Fix errors starting from 'Cannot find module' types first (usually missing @types packages)",
        "Then fix 'does not exist on type' errors (usually wrong property names)",
        "Finally fix 'is not assignable' errors (type mismatches)",
      ],
      commands: ["npx tsc --noEmit", "npm install --save-dev @types/node"],
    }),
  },
  {
    match: /(failing|broken)\s+tests?/i,
    gen: (_, i) => ({
      module: i.module,
      detail: i.detail,
      title: "Fix failing tests",
      why: "Failing tests indicate code that doesn't behave as expected. CI will block deploys.",
      steps: [
        "Run the test suite with full output: `npm test -- --verbose`",
        "Start with the first failing test — often fixing one fixes many",
        "Check if the test is actually testing current behaviour (tests can be stale)",
        "If behaviour intentionally changed, update the test; if not, fix the code",
      ],
      commands: ["npm test -- --verbose", "npx vitest --reporter=verbose"],
    }),
  },
  {
    match: /no.?\b(readme|changelog|contributing)/i,
    gen: (match, i) => ({
      module: i.module,
      detail: i.detail,
      title: `Create ${match[1].toUpperCase()}.md`,
      why: `A ${match[1]} file is expected in every serious project. GitHub/npm display it prominently.`,
      steps: [
        `Create ${match[1].toUpperCase()}.md in the repo root`,
        "Include project purpose, installation, usage examples",
        "Commit to main and push",
      ],
    }),
  },
  {
    match: /no.?tests/i,
    gen: (_, i) => ({
      module: i.module,
      detail: i.detail,
      title: "Add a test suite",
      why: "Without tests, every change risks breaking something. No CI signal.",
      steps: [
        "Install a test runner: `npm install --save-dev vitest` (fastest) or jest",
        "Create a `tests/` or `__tests__/` directory",
        "Write at least one smoke test per module",
        "Add a `test` script to package.json: `\"test\": \"vitest\"`",
      ],
      commands: ["npm install --save-dev vitest", "npx vitest init"],
    }),
  },
  {
    match: /no.?ci|missing\s+(github\s+actions|workflow)/i,
    gen: (_, i) => ({
      module: i.module,
      detail: i.detail,
      title: "Set up CI/CD",
      why: "Without CI, broken code can reach main. Regressions aren't caught.",
      steps: [
        "Create `.github/workflows/ci.yml`",
        "Run install, build, test, and lint on every push + PR",
        "Add `gatetest --suite full` as a step for comprehensive checks",
        "Enable required status checks on main in repo settings",
      ],
    }),
  },
  {
    match: /unpinn?ed|latest\s+tag/i,
    gen: (_, i) => ({
      module: i.module,
      detail: i.detail,
      title: "Pin dependency versions",
      why: "Unpinned dependencies mean your build can break spontaneously when a transitive dep releases.",
      steps: [
        "Replace `^1.2.3` with exact `1.2.3` in package.json for critical deps",
        "Commit the `package-lock.json` — this is your real pin",
        "For Docker images, use digests (`image@sha256:...`) not `:latest`",
      ],
      commands: ["npm install --save-exact <package>"],
    }),
  },
];

async function askClaudeGuidance(issue: IssueInput): Promise<Guidance> {
  if (!ANTHROPIC_API_KEY) {
    return {
      module: issue.module,
      detail: issue.detail,
      title: "Manual review required",
      why: "AI guidance not configured on this server.",
      steps: ["Review the issue detail and fix manually."],
    };
  }

  const prompt = `You are a senior engineer explaining a code quality issue to a junior developer who needs to fix it themselves.

MODULE: ${issue.module}
ISSUE: ${issue.detail}

Respond in JSON format only:
{
  "title": "Short action-oriented title (e.g. 'Fix X', 'Add Y')",
  "why": "One-sentence explanation of why this matters",
  "steps": ["Specific step 1", "Specific step 2", "..."],
  "commands": ["exact command 1", "exact command 2"]
}

Rules:
- Be direct and actionable. No fluff.
- Steps must be concrete — not "consider fixing X" but "change X to Y in file Z".
- Include commands only if they're well-known and safe to run.
- 3-5 steps max.`;

  const body = JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  try {
    const res = await httpsJsonRequest({
      hostname: "api.anthropic.com",
      port: 443,
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": ANTHROPIC_API_KEY,
        "Content-Length": String(Buffer.byteLength(body)),
      },
    }, body);

    if (res.status !== 200) throw new Error(`API ${res.status}`);

    const content = res.data.content as Array<{ type: string; text: string }>;
    const text = content?.[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in response");
    const parsed = JSON.parse(jsonMatch[0]);

    return {
      module: issue.module,
      detail: issue.detail,
      title: parsed.title || "Review this issue",
      why: parsed.why || issue.detail,
      steps: Array.isArray(parsed.steps) ? parsed.steps : [],
      commands: Array.isArray(parsed.commands) ? parsed.commands : undefined,
    };
  } catch {
    return {
      module: issue.module,
      detail: issue.detail,
      title: "Review this issue",
      why: issue.detail,
      steps: ["Investigate the issue manually.", "Check the module documentation for context."],
    };
  }
}

export async function POST(req: NextRequest) {
  let body: { issues?: IssueInput[] };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const issues = body.issues || [];
  if (issues.length === 0) return NextResponse.json({ guidance: [] });

  // First pass: match known patterns instantly (no API call)
  const guidance: Guidance[] = [];
  const unmatched: IssueInput[] = [];

  for (const issue of issues) {
    let matched = false;
    for (const pattern of PATTERNS) {
      const m = issue.detail.match(pattern.match);
      if (m) {
        guidance.push(pattern.gen(m, issue));
        matched = true;
        break;
      }
    }
    if (!matched) unmatched.push(issue);
  }

  // Second pass: Claude for the rest (parallel, capped)
  const claudeResults = await Promise.allSettled(
    unmatched.slice(0, 20).map(askClaudeGuidance) // cap at 20 to control cost
  );

  for (const r of claudeResults) {
    if (r.status === "fulfilled") guidance.push(r.value);
  }

  return NextResponse.json({
    total: issues.length,
    matchedPatterns: guidance.length - claudeResults.length,
    aiGenerated: claudeResults.filter((r) => r.status === "fulfilled").length,
    guidance,
  });
}
