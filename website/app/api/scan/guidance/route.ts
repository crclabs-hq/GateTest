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
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createLimiter: _mkLimiter, PRESETS: _RL_PRESETS } = require("@lib/rate-limit") as {
  createLimiter: (opts: { windowMs: number; maxRequests: number }) => {
    guard: (req: NextRequest) => Promise<{ allowed: boolean; status?: number; body?: Record<string, unknown>; headers?: Record<string, string> }>;
  };
  PRESETS: Record<string, { windowMs: number; maxRequests: number }>;
};
const _guidanceLimiter = _mkLimiter(_RL_PRESETS.scanFix);
import { httpsJsonRequest } from "../../../lib/github-app";

// Resolved through engine-models so GATETEST_CHEAP_MODEL reaches this
// route — it was an inline literal, invisible to the override (KI #78).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { CHEAP_MODEL } = require("@/app/lib/engine-models") as { CHEAP_MODEL: string };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { endpoint: anthropicEndpoint, apiPath: anthropicApiPath, apiVersion: anthropicVersion } = require("@/app/lib/anthropic-config") as { endpoint: () => { hostname: string; port: number }; apiPath: (r?: string) => string; apiVersion: () => string };

// Usage Doctrine Meter 3 (CLAUDE.md, Craig 2026-09-16) — guidance runs on OUR
// Anthropic key with no per-request payment. One daily ceiling shared by
// every automatic caller; see website/app/lib/server-spend-guard.js.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { checkServerSpend, recordServerSpend } = require("@/app/lib/server-spend-guard") as {
  checkServerSpend: (opts: { sql?: unknown; now?: Date }) => Promise<{ allowed: boolean; spentMicros: number; ceilingMicros: number | null; reason: string }>;
  recordServerSpend: (opts: { sql?: unknown; route: string; model: string; inputTokens: number; outputTokens: number; now?: Date; isCustomerKey?: boolean }) => Promise<{ recorded: boolean; reason?: string }>;
};

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

async function askClaudeGuidance(issue: IssueInput, onUsage?: (u: { inputTokens: number; outputTokens: number }) => void): Promise<Guidance> {
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
    model: CHEAP_MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  try {
    const res = await httpsJsonRequest({
      hostname: anthropicEndpoint().hostname,
      port: anthropicEndpoint().port,
      path: anthropicApiPath("/v1/messages"),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": anthropicVersion(),
        "x-api-key": ANTHROPIC_API_KEY,
        "Content-Length": String(Buffer.byteLength(body)),
      },
    }, body);

    if (res.status !== 200) throw new Error(`API ${res.status}`);

    const usage = res.data.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    if (onUsage) onUsage({ inputTokens: usage?.input_tokens || 0, outputTokens: usage?.output_tokens || 0 });

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

// auth-public — reached credential-free ON PURPOSE: the hosted MCP core
// (app/lib/mcp-remote-core.cjs) proxies explain_finding here server-to-server and
// forwards no caller key, and the admin panels call it from the browser. The
// deliberate control for the Claude spend is _guidanceLimiter above (chosen over
// auth in the 2026-08-18 audit, asserted by tests/api-hardening-2026-08-18.test.js).
// KNOWN GAP, escalated to Craig 2026-08-31: because the paid MCP gate sits in the
// MCP layer and not here, calling this route directly bypasses the $29/mo tier.
// Closing it means threading an internal service token through mcp-remote-core —
// a paid-tier change, so Boss Rule, not a unilateral fix.
export async function POST(req: NextRequest) {
  let body: { issues?: IssueInput[] };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const issues = body.issues || [];
  if (issues.length === 0) return NextResponse.json({ guidance: [] });

  // Up to 20 Claude calls per request on OUR key with no limiter was free
  // AI spend for anyone (2026-08-18 audit).
  const rl = await _guidanceLimiter.guard(req);
  if (!rl.allowed) {
    return NextResponse.json(rl.body || { error: "Too many requests — try again in a minute" }, { status: rl.status || 429, headers: rl.headers });
  }

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

  // Second pass: Claude for the rest (parallel, capped). Gated by the daily
  // server-key spend ceiling (Usage Doctrine Meter 3) — only when there's
  // actually an AI call to make; the pattern-matched issues above are free.
  let claudeResults: PromiseSettledResult<Guidance>[] = [];
  if (unmatched.length > 0) {
    const spendCheck = await checkServerSpend({});
    if (!spendCheck.allowed) {
      return NextResponse.json(
        { error: "AI assistance is paused for today: daily budget reached", reason: spendCheck.reason },
        { status: 503 }
      );
    }

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const onUsage = (u: { inputTokens: number; outputTokens: number }) => {
      totalInputTokens += u.inputTokens;
      totalOutputTokens += u.outputTokens;
    };

    claudeResults = await Promise.allSettled(
      unmatched.slice(0, 20).map((issue) => askClaudeGuidance(issue, onUsage)) // cap at 20 to control cost
    );

    if (totalInputTokens > 0 || totalOutputTokens > 0) {
      await recordServerSpend({
        route: "/api/scan/guidance",
        model: CHEAP_MODEL,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      });
    }
  }

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
