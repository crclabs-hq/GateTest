/**
 * Playground Scan Stream API — SSE version of /api/playground/scan.
 *
 * POST /api/playground/scan/stream
 * Body: { repo_url: string }
 *
 * Same free, no-auth, quick-tier (4 modules) scan as the non-streaming
 * route — this does NOT run the paid 116-module catalog for free (that
 * would give away the $99+ product). What it adds:
 *
 *   - Real per-module completion events as the quick tier actually
 *     finishes each module (runTier's new onModuleComplete callback),
 *     not a fake setTimeout-staggered animation.
 *   - A `module:locked` event for every module in the full public
 *     catalog (modules-data.ts, 120 entries) that ISN'T in the free
 *     tier — same shadow-preview mechanic CLAUDE.md documents for the
 *     $29 tier's upsell mechanic (show the breadth of the product
 *     without doing the paid work for free). Lets the UI render an
 *     honest "4/120 complete, 116 locked" progress bar instead of
 *     either lying about running 120 modules or showing a misleading
 *     "4/4" bar that undersells the product.
 *
 * Event types:
 *   event: start          { totalModules, freeModules }
 *   event: module:end     { name, status, checks, issues, duration, severity }
 *   event: module:locked  { name, category }
 *   event: complete       <same payload shape as /api/playground/scan>
 *   event: error          { error }
 */

import { NextRequest } from "next/server";
import { runTier, type ModuleResultEnvelope } from "@/app/lib/scan-modules";
import { resolveRepoAuth, fetchTree, fetchBlob } from "@/app/lib/gluecron-client";
import { MODULE_CATEGORIES, totalModuleCount } from "@/app/components/howitworks/modules-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const QUICK_MODULES = ["syntax", "lint", "secrets", "codeQuality"];
const MAX_FILES_TO_READ = 50;

// Coarse severity-by-module heuristic — the module envelope doesn't carry
// per-finding severity at this layer (details are plain strings), so this
// assigns a defensible default per module rather than fabricating false
// precision per-line. secrets/syntax block real work (critical); lint/
// codeQuality are real but rarely release-blocking (warning).
const MODULE_SEVERITY: Record<string, "critical" | "warning" | "info"> = {
  secrets: "critical",
  syntax: "critical",
  lint: "warning",
  codeQuality: "warning",
};

function computeHealthScore(modules: Array<{ status: string; issues?: number }>): {
  score: number;
  grade: string;
  gradeColor: string;
} {
  if (!modules.length) return { score: 0, grade: "F", gradeColor: "#ef4444" };
  const passed = modules.filter((m) => m.status === "passed").length;
  const total = modules.length;
  const errors = modules.reduce((s, m) => s + (m.issues || 0), 0);
  const base = Math.round((passed / total) * 100);
  const penalty = Math.min(50, errors * 3);
  const score = Math.max(0, base - penalty);
  let grade: string;
  let gradeColor: string;
  if (score >= 90) { grade = "A"; gradeColor = "#22c55e"; }
  else if (score >= 75) { grade = "B"; gradeColor = "#0d9488"; }
  else if (score >= 60) { grade = "C"; gradeColor = "#eab308"; }
  else if (score >= 40) { grade = "D"; gradeColor = "#f97316"; }
  else { grade = "F"; gradeColor = "#ef4444"; }
  return { score, grade, gradeColor };
}

export async function POST(req: NextRequest) {
  let body: { repo_url?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
  }

  const repoUrl = (body.repo_url || "").trim().replace(/\.git$/, "");
  if (!repoUrl || !/^https?:\/\/github\.com\/[^/]+\/[^/?#\s]+/.test(repoUrl)) {
    return new Response(
      JSON.stringify({ error: "repo_url must be a public github.com URL — e.g. https://github.com/owner/repo" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const match = /github\.com\/([^/]+)\/([^/?#\s]+)/.exec(repoUrl);
  const owner = match?.[1] || "";
  const repo = match?.[2] || "";

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch { /* controller closed mid-write */ }
      };
      const keepAlive = setInterval(() => {
        if (!closed) { try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch { /* ignore */ } }
      }, 10000);

      const totalModules = totalModuleCount();
      send("start", { totalModules, freeModules: QUICK_MODULES.length, repoUrl });

      // Locked-catalog entries animate in immediately alongside the real
      // scan — they're not doing any work, just declaring "this exists in
      // the full product and isn't part of the free tier."
      for (const category of MODULE_CATEGORIES) {
        for (const mod of category.modules) {
          if (!QUICK_MODULES.includes(mod.name)) {
            send("module:locked", { name: mod.name, category: category.title });
          }
        }
      }

      try {
        const auth = await resolveRepoAuth(owner, repo);
        if (!auth.token) {
          send("error", { error: `Cannot access ${owner}/${repo}${auth.error ? ` (${auth.error})` : ""}` });
          clearInterval(keepAlive);
          closed = true;
          controller.close();
          return;
        }

        const files = await fetchTree(owner, repo, "HEAD", auth.token);
        if (files.length === 0) {
          send("error", { error: `Cannot access ${owner}/${repo} — empty tree` });
          clearInterval(keepAlive);
          closed = true;
          controller.close();
          return;
        }

        const sourceExts = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".java", ".rb", ".md", ".json"];
        const notExcluded = (f: string) => !f.includes("node_modules") && !f.includes(".next") && !f.includes("dist/");
        const filesToFetch = files.filter((f) => sourceExts.some((ext) => f.endsWith(ext)) && notExcluded(f)).slice(0, MAX_FILES_TO_READ);

        const fileContents = (
          await Promise.all(
            filesToFetch.map(async (p) => {
              try {
                const content = await fetchBlob(owner, repo, p, "HEAD", auth.token as string);
                return content ? { path: p, content } : null;
              } catch { return null; }
            })
          )
        ).filter((f): f is { path: string; content: string } => f !== null);

        const { modules, totalIssues } = await runTier(
          "quick",
          { owner, repo, files: filesToFetch, fileContents },
          (result: ModuleResultEnvelope) => {
            send("module:end", {
              name: result.name,
              status: result.status,
              checks: result.checks,
              issues: result.issues,
              duration: result.duration,
              severity: MODULE_SEVERITY[result.name] || "info",
            });
          }
        );

        const { score, grade, gradeColor } = computeHealthScore(modules);
        const topFindings: Array<{ module: string; message: string; severity: string }> = [];
        for (const mod of modules) {
          if (mod.status === "failed" && mod.details) {
            for (const detail of mod.details.slice(0, 3)) {
              if (topFindings.length >= 8) break;
              topFindings.push({ module: mod.name, message: detail, severity: MODULE_SEVERITY[mod.name] || "warning" });
            }
          }
        }

        send("complete", {
          status: "complete",
          repo_url: repoUrl,
          tier: "quick",
          modules,
          totalModules,
          freeModules: QUICK_MODULES.length,
          totalIssues,
          duration: modules.reduce((s, m) => s + m.duration, 0),
          healthScore: score,
          grade,
          gradeColor,
          topFindings,
          upgradeNote: `This is ${QUICK_MODULES.length} of ${totalModules} modules. A full scan would check ${totalModules - QUICK_MODULES.length} more.`,
        });
      } catch (err) {
        send("error", { error: err instanceof Error ? err.message : "Scan failed" });
      } finally {
        clearInterval(keepAlive);
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
