/**
 * Watchdog Tick — runs every N minutes via Vercel Cron.
 *
 * GET /api/watches/tick
 *
 * Finds watches due for their next check, runs a scan, logs the result,
 * and (if auto_fix_enabled) attempts a heal. This is the engine that
 * makes GateTest continuously self-healing for every registered target.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface WatchRow {
  id: number;
  owner_login: string;
  target_type: string;
  target: string;
  interval_minutes: number;
  enabled: boolean;
  last_checked_at: string | null;
  last_status: string | null;
  last_issue_count: number | null;
  auto_fix_enabled: boolean;
}

// Simple auth — Vercel Cron sets a specific header, or allow manual trigger with admin cookie
function authorizedTick(req: NextRequest): boolean {
  const vercelCronSecret = process.env.CRON_SECRET || "";
  const authHeader = req.headers.get("authorization") || "";
  // Vercel Cron sends "Bearer <CRON_SECRET>"
  if (vercelCronSecret && authHeader === `Bearer ${vercelCronSecret}`) return true;
  // Also allow the request if it comes from vercel cron signature
  if (req.headers.get("x-vercel-cron") === "1") return true;
  // Dev mode fallback
  if (process.env.NODE_ENV !== "production") return true;
  return false;
}

async function scanServer(target: string, baseUrl: string): Promise<ScanResult | null> {
  try {
    const res = await fetch(`${baseUrl}/api/scan/server`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: target }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const issueCount = Number(data.totalIssues || 0);
    return {
      totalIssues: issueCount,
      status: issueCount === 0 ? "healthy" : issueCount > 5 ? "down" : "degraded",
    };
  } catch {
    return null;
  }
}

interface ScanResult {
  totalIssues: number;
  status: string;
  modules?: Array<{ name: string; status: string; details?: string[] }>;
}

async function scanRepo(target: string, baseUrl: string): Promise<ScanResult | null> {
  try {
    const repoUrl = `https://github.com/${target}`;
    const res = await fetch(`${baseUrl}/api/scan/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // full tier so we get enough detail to generate meaningful fixes
      body: JSON.stringify({ repoUrl, tier: "full" }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      totalIssues: Number(data.totalIssues || 0),
      status: data.totalIssues === 0 ? "healthy" : "degraded",
      modules: data.modules || [],
    };
  } catch {
    return null;
  }
}

// Extract fixable {file, issue, module} triples from scan module details.
//
// Real-world detail strings come in many shapes — the legacy regex assumed
// the file path was at the START of the line, but our scanners emit:
//   "src/foo.ts:42: Missing return type"               ← file-first
//   "<sev>: src/foo.ts:42: Missing return type"        ← infra.ts
//   "hardcoded-url:localhost:src/foo.ts:62 ..."        ← module:rule prefix
//   "syntax:parens:apps/api/src/foo.ts"                ← module:rule, no msg
// The old regex matched ~0 of these in practice, so the watchdog auto-fix
// loop silently extracted nothing → never opened a fix PR.
//
// New approach: search ANYWHERE in the line for a path-shaped substring
// (one or more `/`-separated path segments ending in a 1-8 char file
// extension, optionally followed by `:line[:col]`). Take everything to
// the right of the match as the issue description.
function extractFixableIssues(modules: Array<{ name: string; status: string; details?: string[] }>): Array<{ file: string; issue: string; module: string }> {
  const issues: Array<{ file: string; issue: string; module: string }> = [];
  // Boundary requirement on the LEFT prevents matching "error:src/foo.ts"
  // as the whole thing (we want just `src/foo.ts`).
  const PATH_RE = /(?:^|[\s:(])((?:[\w@.+-]+\/)+[\w@.+-]+\.[A-Za-z0-9]{1,8}|[\w@.+-]+\.[A-Za-z0-9]{1,8})(?::(\d+))?(?::(\d+))?(?=[\s:)\],]|$)/;
  for (const mod of modules) {
    if (mod.status !== "failed") continue;
    for (const d of mod.details || []) {
      if (typeof d !== "string" || !d) continue;
      const m = d.match(PATH_RE);
      if (!m) continue;
      const file = m[1];
      // Skip obvious false-positives — bare filenames with no slash that
      // look like module-rule keys (e.g. "no-empty.eslint" would match).
      if (!file.includes("/") && file.split(".").length === 2 && file.length < 12) continue;
      // Take everything AFTER the matched path+line as the issue text.
      const start = (m.index ?? 0) + m[0].length;
      const issue = (d.slice(start).replace(/^[\s:—-]+/, "").trim() || d.trim()).slice(0, 500);
      issues.push({ file, issue, module: mod.name });
    }
  }
  return issues;
}

export async function GET(req: NextRequest) {
  if (!authorizedTick(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let sql;
  try { sql = getDb(); } catch {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://gatetest.ai";

  // Find watches that are due for a check
  const due = (await sql`
    SELECT id, owner_login, target_type, target, interval_minutes, enabled,
           last_checked_at, last_status, last_issue_count, auto_fix_enabled
    FROM watches
    WHERE enabled = TRUE
      AND (
        last_checked_at IS NULL
        OR last_checked_at < NOW() - (interval_minutes || ' minutes')::INTERVAL
      )
    ORDER BY last_checked_at ASC NULLS FIRST
    LIMIT 10
  `) as unknown as WatchRow[];

  const results: Array<{ id: number; target: string; outcome: string }> = [];

  for (const watch of due) {
    const scanFn = watch.target_type === "server" ? scanServer : scanRepo;
    const scanStart = Date.now();
    const result = await scanFn(watch.target, baseUrl);

    if (!result) {
      await sql`
        INSERT INTO heal_history (watch_id, action, status, details, completed_at)
        VALUES (${watch.id}, 'scan', 'failed', ${JSON.stringify({ reason: "scan API error" })}, NOW())
      `;
      await sql`
        UPDATE watches SET last_checked_at = NOW(), last_status = 'down', updated_at = NOW()
        WHERE id = ${watch.id}
      `;
      results.push({ id: watch.id, target: watch.target, outcome: "scan-failed" });
      continue;
    }

    await sql`
      INSERT INTO heal_history (watch_id, action, status, before_issue_count, after_issue_count, details, completed_at)
      VALUES (${watch.id}, 'scan', 'success', ${watch.last_issue_count || 0}, ${result.totalIssues},
              ${JSON.stringify({ durationMs: Date.now() - scanStart, status: result.status })}, NOW())
    `;

    // Trigger auto-fix for repos if issues found and auto-fix is enabled.
    // Every branch of this block now writes a heal_history row so the admin
    // panel always shows WHY auto-fix did or didn't open a PR — no more
    // silent skips. The old empty `catch {}` was the reason watchdog
    // appeared to do nothing on failing repos.
    if (watch.auto_fix_enabled && watch.target_type === "repo" && result.totalIssues > 0 && result.modules) {
      try {
        const fixableIssues = extractFixableIssues(result.modules);
        if (fixableIssues.length === 0) {
          // The scan found issues but the extractor couldn't turn any of
          // them into {file, issue} triples. Log so we can see WHICH
          // module's detail format we don't yet parse.
          const moduleSamples = result.modules
            .filter((m) => m.status === "failed")
            .slice(0, 3)
            .map((m) => ({ name: m.name, sampleDetail: (m.details || [])[0] || null }));
          await sql`
            INSERT INTO heal_history (watch_id, action, status, details, completed_at)
            VALUES (${watch.id}, 'auto_fix_pr', 'skipped',
                    ${JSON.stringify({ reason: "no fixable issues extracted from scan", issuesFound: result.totalIssues, moduleSamples })}, NOW())
          `;
        } else {
          const fixRes = await fetch(`${baseUrl}/api/scan/fix`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              repoUrl: `https://github.com/${watch.target}`,
              issues: fixableIssues,
              tier: "full",
            }),
          });
          let fixData: { prUrl?: string; issuesFixed?: number; error?: string } = {};
          try { fixData = await fixRes.json(); } catch { /* keep empty */ }
          const prUrl = fixData.prUrl || null;
          await sql`
            INSERT INTO heal_history (watch_id, action, status, pr_url, details, completed_at)
            VALUES (${watch.id}, 'auto_fix_pr', ${prUrl ? "success" : "failed"}, ${prUrl},
                    ${JSON.stringify({
                      issuesFixed: fixData.issuesFixed || 0,
                      issuesFound: fixableIssues.length,
                      httpStatus: fixRes.status,
                      error: fixData.error || null,
                    })}, NOW())
          `;
        }
      } catch (err) {
        // Record the real error so the admin panel shows what broke.
        const message = err instanceof Error ? err.message : String(err);
        await sql`
          INSERT INTO heal_history (watch_id, action, status, details, completed_at)
          VALUES (${watch.id}, 'auto_fix_pr', 'failed',
                  ${JSON.stringify({ reason: "exception during auto-fix", error: message })}, NOW())
        `;
      }
    }

    await sql`
      UPDATE watches
      SET last_checked_at = NOW(),
          last_status = ${result.status},
          last_issue_count = ${result.totalIssues},
          updated_at = NOW()
      WHERE id = ${watch.id}
    `;

    results.push({ id: watch.id, target: watch.target, outcome: result.status });
  }

  return NextResponse.json({
    checked: due.length,
    results,
    timestamp: new Date().toISOString(),
  });
}
