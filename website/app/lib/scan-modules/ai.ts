/**
 * AI code review module — flagship, calls Claude API for real bug discovery.
 *
 * Honest skip when ANTHROPIC_API_KEY is absent. Never fake-passes.
 */

import https from "https";
import type { ModuleRunner, ModuleContext, ModuleOutput, RepoFile } from "./types";

const MODEL = "claude-sonnet-4-6";
const MAX_FILES = 8;
const MAX_FILE_CHARS = 30000;
const MAX_TOKENS = 4096;
const TIMEOUT_MS = 60000;
const SOURCE_EXT = /\.(ts|tsx|js|jsx)$/i;
const EXCLUDE = /(test|spec|\.d\.ts|node_modules|dist\/|build\/)/i;
const PRIORITY = /(api\/|lib\/|route|handler|service|auth|payment)/i;

interface Finding {
  file: string;
  severity: "critical" | "high" | "medium" | "low";
  issue: string;
  line?: number;
}

function selectFiles(fc: RepoFile[]): RepoFile[] {
  const candidates = fc.filter(
    (f) => SOURCE_EXT.test(f.path) && !EXCLUDE.test(f.path) && f.content.length <= MAX_FILE_CHARS,
  );
  const priority = candidates.filter((f) => PRIORITY.test(f.path));
  const rest = candidates
    .filter((f) => !PRIORITY.test(f.path))
    .sort((a, b) => b.content.length - a.content.length);
  const picked: RepoFile[] = [];
  const seen = new Set<string>();
  for (const f of [...priority, ...rest]) {
    if (picked.length >= MAX_FILES) break;
    if (seen.has(f.path)) continue;
    seen.add(f.path);
    picked.push(f);
  }
  return picked;
}

function buildPrompt(files: RepoFile[]): string {
  const blocks = files.map((f) => `====== FILE: ${f.path} ======\n${f.content}`).join("\n\n");
  return `${blocks}\n\nReturn findings as a JSON array. Each finding: { file: string, severity: 'critical'|'high'|'medium'|'low', issue: string, line?: number }. Return [] if no real bugs. Output ONLY the JSON array, nothing else.`;
}

interface ApiResult {
  status: number;
  body: string;
}

function callClaude(apiKey: string, prompt: string): Promise<ApiResult> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system:
        "You are an expert code reviewer for production software. Find REAL bugs: logic errors, race conditions, missing null checks, incorrect async handling, security holes, data corruption risks, unbounded operations. Ignore style.",
      messages: [{ role: "user", content: prompt }],
    });
    const req = https.request(
      {
        host: "api.anthropic.com",
        port: 443,
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": apiKey,
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function callWithRetry(apiKey: string, prompt: string): Promise<ApiResult> {
  const delays = [1000, 2000];
  let last: ApiResult | null = null;
  for (let attempt = 0; attempt <= 2; attempt++) {
    last = await callClaude(apiKey, prompt);
    if (last.status === 200) return last;
    const retryable = last.status === 429 || (last.status >= 500 && last.status < 600);
    if (!retryable || attempt === 2) return last;
    await new Promise((r) => setTimeout(r, delays[attempt]));
  }
  return last as ApiResult;
}

function extractJsonArray(text: string): Finding[] | null {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  }
  try {
    const parsed = JSON.parse(t);
    if (!Array.isArray(parsed)) return null;
    return parsed as Finding[];
  } catch {
    return null;
  }
}

export const aiReview: ModuleRunner = async (ctx: ModuleContext): Promise<ModuleOutput> => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      checks: 0,
      issues: 0,
      details: [],
      skipped: "ANTHROPIC_API_KEY not set — AI review skipped",
    };
  }

  const files = selectFiles(ctx.fileContents);
  if (files.length === 0) {
    return { checks: 0, issues: 0, details: [], skipped: "No eligible source files for AI review" };
  }

  const prompt = buildPrompt(files);

  let result: ApiResult;
  try {
    result = await callWithRetry(apiKey, prompt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { checks: 1, issues: 1, details: [`AI review network error: ${msg}`] };
  }

  if (result.status !== 200) {
    return { checks: 1, issues: 1, details: [`AI review failed: status ${result.status}`] };
  }

  let textOut: string;
  try {
    const parsed = JSON.parse(result.body);
    const content = parsed?.content;
    if (!Array.isArray(content) || content.length === 0 || typeof content[0]?.text !== "string") {
      return { checks: 1, issues: 1, details: ["AI review response parse failed"] };
    }
    textOut = content[0].text;
  } catch {
    return { checks: 1, issues: 1, details: ["AI review response parse failed"] };
  }

  const findings = extractJsonArray(textOut);
  if (!findings) {
    return { checks: 1, issues: 1, details: ["AI review response parse failed"] };
  }

  const details = findings.map(
    (f) => `${f.file}: [${f.severity}] ${f.issue}${typeof f.line === "number" ? ` (line ${f.line})` : ""}`,
  );
  return { checks: files.length, issues: findings.length, details };
};
