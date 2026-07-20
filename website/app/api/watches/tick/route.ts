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
import { deriveAdminToken } from "../../../lib/admin-auth";

// Watchdog intelligence — anomaly detection + Claude diagnosis (pure JS, DI).
const { detectAnomalies, diagnoseWatchEvent } = require("@/app/lib/watchdog-intelligence") as {
  detectAnomalies: (opts: {
    history: Array<{ status: string; totalIssues: number; durationMs: number }>;
    current: { status: string; totalIssues: number; durationMs: number };
    previousStatus: string | null;
  }) => Array<{ kind: string; severity: string; detail: string }>;
  diagnoseWatchEvent: (opts: {
    watch: { target: string; target_type: string };
    scanResult: { status: string; totalIssues: number; modules?: Array<{ name: string; status: string; details?: string[] }> };
    anomalies: Array<{ kind: string; severity: string; detail: string }>;
    recentHistory: Array<{ status: string; totalIssues: number; durationMs: number }>;
    askClaude: (prompt: string) => Promise<string>;
  }) => Promise<{ ok: boolean; diagnosis: Record<string, string | null> | null; reason: string | null }>;
};

// Hard ceiling on Claude diagnoses per tick. The tick has a 60s budget
// and each diagnosis is bounded at 15s, so 2 keeps worst-case Claude
// time at 30s while the scans themselves use the rest.
const MAX_DIAGNOSES_PER_TICK = 2;

// Single-attempt, 15s-bounded Claude call. The watchdog must never let a
// slow Anthropic response starve the scan loop — a missed diagnosis is
// recoverable on the next tick, a blown function budget is not.
async function askClaudeBounded(prompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY || "";
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
    const data = await res.json() as { content?: Array<{ type: string; text: string }> };
    return data.content?.[0]?.text || "";
  } finally {
    clearTimeout(timer);
  }
}

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
    const adminToken = deriveAdminToken();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (adminToken) headers["x-admin-token"] = adminToken;
    const res = await fetch(`${baseUrl}/api/scan/server`, {
      method: "POST",
      headers,
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
    const adminToken = deriveAdminToken();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (adminToken) headers["x-admin-token"] = adminToken;
    const res = await fetch(`${baseUrl}/api/scan/run`, {
      method: "POST",
      headers,
      // Use quick tier for scheduled health checks — fast (<15s), fits within
      // the 60s maxDuration, and avoids rate-limiting on automated scans.
      // Full-tier scans are available via the admin Watchdog "Scan & Fix" button.
      body: JSON.stringify({ repoUrl, tier: "quick" }),
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

// Freshness gate for the auto-fix path. Even though every scan is fresh,
// auto-fixing a repo that hasn't been pushed in months is almost always
// wrong — the operator forgot it was in the watch table, the files in the
// findings may have moved, and the patch lands as noise on a dead branch.
// Tick still RECORDS the scan, it just won't auto-fix.
const INACTIVE_PUSH_DAYS = 60;
async function repoIsActiveOnGitHub(fullName: string): Promise<boolean | null> {
  const token = process.env.GATETEST_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) return null; // Unknown — fall back to the existing behaviour.
  try {
    const res = await fetch(`https://api.github.com/repos/${fullName}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "GateTest-Watchdog/1.0",
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const meta = await res.json() as { pushed_at?: string };
    if (!meta?.pushed_at) return null;
    const ageDays = (Date.now() - new Date(meta.pushed_at).getTime()) / 86_400_000;
    return ageDays <= INACTIVE_PUSH_DAYS;
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

  const results: Array<{ id: number; target: string; outcome: string; anomalies?: number; diagnosed?: boolean }> = [];
  let diagnosesUsed = 0;

  for (const watch of due) {
    const scanFn = watch.target_type === "server" ? scanServer : scanRepo;

    // Pull the watch's own scan history BEFORE recording the current scan,
    // so the anomaly baselines never include the data point being judged.
    let recentHistory: Array<{ status: string; totalIssues: number; durationMs: number }> = [];
    try {
      const rows = (await sql`
        SELECT after_issue_count, details FROM heal_history
        WHERE watch_id = ${watch.id} AND action = 'scan' AND status = 'success'
        ORDER BY completed_at DESC
        LIMIT 10
      `) as unknown as Array<{ after_issue_count: number | null; details: Record<string, unknown> | string | null }>;
      recentHistory = rows.map((r) => {
        const det = typeof r.details === "string" ? JSON.parse(r.details || "{}") : (r.details || {});
        return {
          status: String(det.status || "healthy"),
          totalIssues: Number(r.after_issue_count ?? 0),
          durationMs: Number(det.durationMs ?? 0),
        };
      });
    } catch {
      // History is an enhancement, never a blocker — anomaly rules that
      // need a baseline simply won't fire on this tick.
      recentHistory = [];
    }

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

    const durationMs = Date.now() - scanStart;
    await sql`
      INSERT INTO heal_history (watch_id, action, status, before_issue_count, after_issue_count, details, completed_at)
      VALUES (${watch.id}, 'scan', 'success', ${watch.last_issue_count || 0}, ${result.totalIssues},
              ${JSON.stringify({ durationMs, status: result.status })}, NOW())
    `;

    // ── Intelligence layer ────────────────────────────────────────────
    // Trend-aware anomaly detection against this watch's own history,
    // then a budget-capped Claude diagnosis when the status worsened.
    // Both are strictly additive: any failure here is recorded and the
    // tick continues (Forbidden #15/#16 — recover, but never silently).
    let anomalies: Array<{ kind: string; severity: string; detail: string }> = [];
    let diagnosed = false;
    try {
      anomalies = detectAnomalies({
        history: recentHistory,
        current: { status: result.status, totalIssues: result.totalIssues, durationMs },
        previousStatus: watch.last_status,
      });
      for (const a of anomalies) {
        await sql`
          INSERT INTO heal_history (watch_id, action, status, details, completed_at)
          VALUES (${watch.id}, 'anomaly', 'recorded',
                  ${JSON.stringify({ kind: a.kind, severity: a.severity, detail: a.detail, target: watch.target })}, NOW())
        `;
      }

      const critical = anomalies.some((a) => a.severity === "critical");
      if (critical && diagnosesUsed < MAX_DIAGNOSES_PER_TICK && process.env.ANTHROPIC_API_KEY) {
        diagnosesUsed++;
        const diag = await diagnoseWatchEvent({
          watch: { target: watch.target, target_type: watch.target_type },
          scanResult: result,
          anomalies,
          recentHistory,
          askClaude: askClaudeBounded,
        });
        await sql`
          INSERT INTO heal_history (watch_id, action, status, details, completed_at)
          VALUES (${watch.id}, 'diagnosis', ${diag.ok ? "success" : "failed"},
                  ${JSON.stringify({ target: watch.target, diagnosis: diag.diagnosis, reason: diag.reason })}, NOW())
        `;
        diagnosed = diag.ok;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        await sql`
          INSERT INTO heal_history (watch_id, action, status, details, completed_at)
          VALUES (${watch.id}, 'anomaly', 'failed',
                  ${JSON.stringify({ reason: "intelligence layer error", error: message })}, NOW())
        `;
      } catch { /* DB write of the error itself failed — nothing left to do */ }
    }

    // Trigger auto-fix for repos if issues found and auto-fix is enabled.
    // Every branch of this block now writes a heal_history row so the admin
    // panel always shows WHY auto-fix did or didn't open a PR — no more
    // silent skips. The old empty `catch {}` was the reason watchdog
    // appeared to do nothing on failing repos.
    if (watch.auto_fix_enabled && watch.target_type === "repo" && result.totalIssues > 0 && result.modules) {
      // Freshness gate (added 2026-06-01): skip auto-fix on repos whose
      // GitHub `pushed_at` is older than INACTIVE_PUSH_DAYS. Operator can
      // re-enable by removing the watch and re-adding it (forces them to
      // confirm the repo is current).
      const isActive = await repoIsActiveOnGitHub(watch.target);
      if (isActive === false) {
        await sql`
          INSERT INTO heal_history (watch_id, action, status, details, completed_at)
          VALUES (${watch.id}, 'auto_fix_pr', 'skipped',
                  ${JSON.stringify({ reason: "repo inactive — last push older than freshness window", inactivePushDays: INACTIVE_PUSH_DAYS })}, NOW())
        `;
        await sql`
          UPDATE watches
          SET last_checked_at = NOW(),
              last_status = ${result.status},
              last_issue_count = ${result.totalIssues},
              updated_at = NOW()
          WHERE id = ${watch.id}
        `;
        results.push({ id: watch.id, target: watch.target, outcome: "skipped-stale" });
        continue;
      }
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
          const fixAdminToken = deriveAdminToken();
          const fixHeaders: Record<string, string> = { "Content-Type": "application/json" };
          if (fixAdminToken) fixHeaders["x-admin-token"] = fixAdminToken;
          const fixRes = await fetch(`${baseUrl}/api/scan/fix`, {
            method: "POST",
            headers: fixHeaders,
            body: JSON.stringify({
              repoUrl: `https://github.com/${watch.target}`,
              issues: fixableIssues,
              tier: "full",
            }),
          });
          let fixData: { prUrl?: string; issuesFixed?: number; error?: string } = {};
          try {
            fixData = await fixRes.json();
          } catch (parseErr) {
            // Non-fatal — record the parse failure so we see it, but keep
            // going with empty data so we still write a heal_history row.
            fixData = { error: `response parse: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}` };
          }
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

    results.push({ id: watch.id, target: watch.target, outcome: result.status, anomalies: anomalies.length, diagnosed });
  }

  return NextResponse.json({
    checked: due.length,
    results,
    timestamp: new Date().toISOString(),
  });
}
