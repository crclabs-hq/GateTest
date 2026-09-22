/**
 * Playground Scan Stream API — SSE version of /api/playground/scan.
 *
 * POST /api/playground/scan/stream
 * Body: { repo_url: string }
 *
 * Same free, no-auth, quick-tier (4 modules) scan as the non-streaming
 * route — this does NOT run the paid 121-module catalog for free (that
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
 *     either lying about running 121 modules or showing a misleading
 *     "4/4" bar that undersells the product.
 *
 * Event types:
 *   event: start          { totalModules, freeModules }
 *   event: module:end     { name, status, checks, issues, duration, severity }
 *   event: module:locked  { name, category }
 *   event: complete       <same payload shape as /api/playground/scan>
 *   event: error          { error }
 *
 * The `complete` payload is what the result view reads, and since 2026-09-22
 * it carries what a stranger needs to trust it (all shaped by
 * app/lib/scan-grade.js, the one definition):
 *   grade / healthScore   driven by BLOCKING findings, the gate's rule
 *   blockingCount, warningCount, countLabel   both numbers, always
 *   scanId, scannedAt, commitSha, branch, resultHeader   reproducibility
 *   coverage + scopeLabel  what was actually read, fetch time vs engine time
 *   viewer                 whether this visitor may be offered a fix
 */

import crypto from "crypto";
import { NextRequest } from "next/server";
import { runTier, type ModuleResultEnvelope } from "@/app/lib/scan-modules";
import { resolveRepoAuth, loadRepoFiles, resolveBaseBranchSha } from "@/app/lib/gluecron-client";
import { MODULE_CATEGORIES, totalModuleCount } from "@/app/components/howitworks/modules-data";
import { resolveFreeScanViewer, type FreeScanViewer } from "@/app/lib/free-scan-viewer";
import { CUSTOMER_COOKIE_NAME } from "@/app/lib/customer-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const QUICK_MODULES = ["syntax", "lint", "secrets", "codeQuality"];
const MAX_FILES_TO_READ = 50;

// One definition of the grade, the severity split and the honesty labels —
// shared with /api/playground/scan and proven by tests/free-scan-grade.test.js.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const scanGrade = require("@/app/lib/scan-grade") as {
  severityForModule: (name: string) => "error" | "warning" | "info";
  computeScanGrade: (modules: Array<{ name?: string; status?: string; issues?: number }>) => {
    score: number | null;
    grade: string;
    gradeColor: string;
    blocking: number;
    warnings: number;
    info: number;
    total: number;
    notChecked: boolean;
    countLabel: string;
    summary: string;
  };
  describeScanScope: (scope: Record<string, unknown>) => string;
  formatResultHeader: (meta: Record<string, unknown>) => string;
  computeCoverage: (scanned: number | null | undefined, total: number | null | undefined) => {
    scanned: number;
    total: number;
    partial: boolean;
  };
  coverageQualifier: (coverage: { scanned: number; total: number; partial: boolean } | null | undefined) => string;
};

export async function POST(req: NextRequest) {
  // N3 (issue #651) — wallMs is the headline duration, so the clock starts
  // at the very first line of the handler, before the body is even parsed.
  // Starting it once req.json() has resolved (as this did until 2026-09-22)
  // dropped the body-parse wait from the number and made it read low
  // against an independent stopwatch — small on a fast body, but the same
  // bug class as excluding fetch or engine time.
  const startedAt = Date.now();

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

  // F2 — every completed free scan gets an id at the moment it starts, so the
  // permalink, the share link and the report header all name the same run.
  const scanId = `scn_${crypto.randomBytes(9).toString("hex")}`;
  // F4 — resolved once per scan, off the request's own cookie. Signed-out
  // visitors and visitors without push access never see a fix CTA.
  // The catch matters: a scan that fails on the tree read never awaits this,
  // and an unhandled rejection is a thrown exception on Node 24.
  const viewerPromise: Promise<FreeScanViewer> = resolveFreeScanViewer(
    req.cookies.get(CUSTOMER_COOKIE_NAME)?.value,
    owner,
    repo
  ).catch(() => ({ signedIn: false, canSignIn: false, login: null, canFix: false, reason: "viewer not checked" }));

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch { /* error-ok — controller closed mid-write */ }
      };
      const keepAlive = setInterval(() => {
        if (!closed) { try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch { /* error-ok — client gone mid-keepalive; the stream is closed in finally */ } }
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
        // No token is fine for a public repo — fetchTree/fetchBlob fall back to
        // the anonymous public archive (repo-snapshot.js, KI #100/#101).
        const token = auth.token || "";

        const sourceExts = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".java", ".rb", ".md", ".json"];
        const isPlaygroundSource = (f: string) =>
          sourceExts.some((ext) => f.endsWith(ext)) && !f.includes("node_modules") && !f.includes(".next") && !f.includes("dist/");
        // F2 — the commit this scan actually read. resolveBaseBranchSha is the
        // one definition of "default branch + its head sha" and works
        // unauthenticated for public repos. It runs alongside the file read so
        // it costs no extra wall-clock; a failure leaves the sha null and the
        // header says "commit not resolved" rather than inventing one.
        const headPromise = resolveBaseBranchSha(owner, repo, "", token).catch(
          (err) => ({
            sha: null as string | null,
            defaultBranch: "",
            source: "none" as const,
            reason: err instanceof Error ? `sha resolution crashed (${err.message})` : "sha resolution crashed",
          })
        );

        // One archive read for tree + contents (credentialed → anonymous →
        // per-blob API) instead of `git/trees` + N blob calls.
        let files: string[];
        let fileContents: Array<{ path: string; content: string }>;
        let readSource = "";
        let readTruncated = false;
        let fetchMs = 0;
        try {
          const fetchStart = Date.now();
          const loaded = await loadRepoFiles(owner, repo, "HEAD", token, { maxFiles: MAX_FILES_TO_READ, filter: isPlaygroundSource });
          fetchMs = Date.now() - fetchStart;
          files = loaded.paths;
          fileContents = loaded.fileContents;
          readSource = loaded.source;
          readTruncated = loaded.truncated;
        } catch (err) {
          send("error", { error: `Cannot access ${owner}/${repo} (${err instanceof Error ? err.message : "tree read failed"})` });
          clearInterval(keepAlive);
          closed = true;
          controller.close();
          return;
        }
        if (files.length === 0) {
          send("error", { error: `Cannot access ${owner}/${repo} — empty tree` });
          clearInterval(keepAlive);
          closed = true;
          controller.close();
          return;
        }
        const filesToFetch = fileContents.map((f) => f.path);

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
              severity: scanGrade.severityForModule(result.name),
            });
          }
        );

        const verdict = scanGrade.computeScanGrade(modules);
        const topFindings: Array<{ module: string; message: string; severity: string }> = [];
        for (const mod of modules) {
          if (mod.status === "failed" && mod.details) {
            for (const detail of mod.details.slice(0, 3)) {
              if (topFindings.length >= 8) break;
              topFindings.push({ module: mod.name, message: detail, severity: scanGrade.severityForModule(mod.name) });
            }
          }
        }

        const head = await headPromise;
        const viewer = await viewerPromise;
        const engineMs = modules.reduce((s, m) => s + m.duration, 0);
        const scannedAt = new Date().toISOString();
        const repoSlug = `${owner}/${repo}`;
        // N2 — one definition of the coverage fraction (Doctrine #4), and the
        // grade line's own qualifier when the read was partial (file cap).
        const coverage = scanGrade.computeCoverage(fileContents.length, files.length);
        const gradeSummary = verdict.summary + scanGrade.coverageQualifier(coverage);

        send("complete", {
          status: "complete",
          repo_url: repoUrl,
          tier: "quick",
          modules,
          totalModules,
          freeModules: QUICK_MODULES.length,
          totalIssues,
          duration: engineMs,
          healthScore: verdict.score,
          grade: verdict.grade,
          gradeColor: verdict.gradeColor,
          // F1 — both numbers, always. The grade comes from `blocking`.
          blockingCount: verdict.blocking,
          warningCount: verdict.warnings,
          infoCount: verdict.info,
          countLabel: verdict.countLabel,
          gradeSummary,
          // F2 — what was scanned, when, and under which report id.
          scanId,
          scannedAt,
          commitSha: head.sha,
          // N1/F2 — why the sha is null, never a bare null the reader has to guess at.
          commitShaReason: head.sha ? null : (head.reason || "sha not resolved for an unknown reason"),
          branch: head.defaultBranch || null,
          resultHeader: scanGrade.formatResultHeader({
            repoSlug,
            commitSha: head.sha,
            shaReason: head.reason,
            branch: head.defaultBranch || null,
            scannedAt,
            scanId,
          }),
          // F3 — what the free scan actually did, in the reader's words.
          coverage: {
            filesAnalysed: fileContents.length,
            filesInRepo: files.length,
            source: readSource || null,
            truncated: readTruncated,
            engineMs,
            fetchMs,
            wallMs: Date.now() - startedAt,
            // N2 — one definition of the coverage fraction (Doctrine #4).
            scanned: coverage.scanned,
            total: coverage.total,
            partial: coverage.partial,
          },
          scopeLabel: scanGrade.describeScanScope({
            filesAnalysed: fileContents.length,
            filesInRepo: files.length,
            source: readSource,
            truncated: readTruncated,
            engineMs,
            fetchMs,
          }),
          // F4 — only a signed-in viewer with push access is offered a fix.
          viewer: { signedIn: viewer.signedIn, canSignIn: viewer.canSignIn, canFix: viewer.canFix },
          topFindings,
          upgradeNote: `This is ${QUICK_MODULES.length} of ${totalModules} modules. A full scan would check ${totalModules - QUICK_MODULES.length} more.`,
        });
      } catch (err) {
        send("error", { error: err instanceof Error ? err.message : "Scan failed" });
      } finally {
        clearInterval(keepAlive);
        closed = true;
        try { controller.close(); } catch { /* error-ok — already closed */ }
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
