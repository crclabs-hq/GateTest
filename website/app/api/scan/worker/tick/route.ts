/**
 * Signal Bus E1 — cron-driven worker tick.
 *
 * Triggered by:
 *   1. Platform (Tallrig) scheduler (crontab / systemd timer, see docs/deploy/VAPRON-DEPLOY.md)
 *   2. Inline kick from /api/events/push and /api/webhook after enqueue
 *   3. Admin-auth'd manual trigger (for debugging)
 *
 * Responsibility:
 *   - Reclaim rows stuck in status='running' (> 5 minutes) via reclaimStuck
 *   - Claim the next ready row via claimNextJob (FOR UPDATE SKIP LOCKED)
 *   - Run the scan via scan-executor.runScan
 *   - On success: markDone + host-aware callback
 *       GitHub jobs → sendGithubCallback (commit status + PR comment)
 *       Gluecron jobs → sendGluecronCallback (existing Signal Bus hook)
 *   - On failure: markFailed(willRetry). If dead-lettered, also fire
 *     a callback so neither host waits forever.
 *   - NEVER throws to Vercel — all errors are caught and returned as JSON.
 *
 * See website/app/lib/scan-worker.js for pure helpers.
 * Tests: tests/scan-worker-tick.test.js
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/app/lib/db";
import { isAdminRequest } from "@/app/lib/admin-auth";
import { runScan } from "@/app/lib/scan-executor";
import { sendGluecronCallback } from "@/app/lib/gluecron-callback";
import { sendGithubCallback } from "@/app/lib/github-callback";
import { getAdminOrgs } from "@/app/lib/admin-platforms";
import { postStatus as postGluecronStatus } from "@/app/lib/gluecron-client";
import { computeGateVerdict } from "@/app/lib/gate-verdict";
import { siteUrl } from "@/app/lib/site-url";

// CommonJS interop.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const scanWorker = require("@/app/lib/scan-worker");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const queueStore = require("@/app/lib/scan-queue-store");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const continuousStore = require("@/app/lib/continuous-subscription-store");

interface CallbackArgs {
  repository: string;
  sha: string;
  ref?: string | null;
  pullRequestNumber?: number | null;
  host?: string;
  scanResult: unknown;

}

async function dispatchCallback(args: CallbackArgs): Promise<void> {
  if (args.host === "github") {
    // Pre-fetch admin orgs from the platform registry (fail-open).
    const dbAdminOrgs = await getAdminOrgs().catch(() => [] as string[]);
    // Mint a GitHub App INSTALLATION token for this specific repo. Without
    // this, sendGithubCallback only sees env PATs — so a customer who
    // installed the App (the entire free-tier flow) but configured no PAT
    // got zero commit statuses, and a Marketplace reviewer installing on
    // their own repo would see nothing post. resolveGithubToken returns the
    // env PAT if one is set (unchanged for the self-hosted path) or mints an
    // App token via the private key; null when neither is available, in
    // which case sendGithubCallback logs and skips. (KI #29.)
    let appToken: string | undefined;
    const slashParts = args.repository.split("/");
    if (slashParts.length === 2) {
      try {
        const { resolveGithubToken } = await import("@/app/lib/github-app");
        const resolved = await resolveGithubToken(slashParts[0], slashParts[1]);
        if (resolved.token) appToken = resolved.token;
      } catch (err) {
        console.error("[worker-tick] App token resolution failed", {
          repository: args.repository,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await sendGithubCallback({
      repository: args.repository,
      sha: args.sha,
      pullRequestNumber: args.pullRequestNumber ?? null,
      scanResult: args.scanResult as object,
      dbAdminOrgs,
      ...(appToken ? { token: appToken } : {}),
    });
  } else {
    // JSDoc types the .js helpers' scanResult as `object`; a null result is
    // handled inside (it becomes status 'error'), so hand it an empty object.
    const scanResult = (args.scanResult ?? {}) as object;
    await sendGluecronCallback({
      repository: args.repository,
      sha: args.sha,
      ref: args.ref ?? undefined,
      scanResult,
    });
    // Host parity (vapron-4f, 2026-09-02): GitHub jobs got a commit status
    // AND a PR comment; Gluecron jobs got only the gate_runs hook. Post the
    // same verdict as a commit status so the commit itself shows it. Best
    // effort — the hook is the gate; a 404 from an instance without the
    // statuses endpoint is logged, never fatal.
    const parts = args.repository.split("/");
    if (parts.length === 2) {
      try {
        const verdict = computeGateVerdict(scanResult, "strict");
        const res = await postGluecronStatus(
          parts[0], parts[1], args.sha, verdict.state, "gatetest / scan",
          String(verdict.reason || "").slice(0, 140), "", `${siteUrl()}/scan/status`,
        );
        if (res.status < 200 || res.status >= 300) {
          console.warn(`[worker-tick] Gluecron commit status for ${args.repository}@${args.sha.slice(0, 7)} → ${res.status}`);
        }
      } catch (err) { // error-ok — the gate_runs hook already carried the verdict
        console.warn("[worker-tick] Gluecron commit status failed:", err instanceof Error ? err.message : String(err));
      }
    }
  }
}

export async function POST(req: NextRequest) {
  try {
    // Vercel cron invocations authenticate with `Authorization: Bearer
    // <CRON_SECRET>` — the platform never sends a custom header. The
    // x-vercel-cron-secret header is our own convention, sent only by the
    // internal inline kicks (events-push.js, github-events.js). Accept both;
    // before this, setting CRON_SECRET (fail-closed, KI #57e) would have
    // 401'd every real Vercel cron tick and silently stopped the queue.
    const authHeader = req.headers.get("authorization") || "";
    const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const cronHeader = req.headers.get("x-vercel-cron-secret") || bearer || null;
    const isAdmin = isAdminRequest(req);

    const authed = scanWorker.isAuthorisedTick({
      cronHeader,
      isAdmin,
      env: process.env,
    });
    if (!authed) {
      return NextResponse.json({ error: "unauthorised" }, { status: 401 });
    }

    let sql;
    try {
      sql = getDb();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "db not configured";
      return NextResponse.json({ error: msg }, { status: 503 });
    }

    // Self-heal the queue schema before touching it. `ensureScanQueueTable` is
    // idempotent (CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS), but
    // until 2026-08-05 it was only called from /api/db/init and the GitHub
    // callback — never from the worker. Production's scan_queue predated the
    // dual-host `host` column, so every tick died with
    // `column q.host does not exist` and returned {"ok":false} with HTTP 200.
    // Nothing drained the queue, which made the Marketplace listing's core
    // promise — "scans run on every push" — false in production: a reviewer
    // would install, push, and see nothing happen. The enqueue path migrates
    // itself; the consume path must too, or a schema change silently breaks
    // exactly the half nobody watches.
    try {
      await queueStore.ensureScanQueueTable(sql);
    } catch (err) { // error-ok — a migration failure must not stop a tick that might still drain older rows
      console.error("[scan-worker/tick] schema ensure failed (continuing):", err);
    }

    const result = await scanWorker.runWorkerTick({
      sql,
      queueStore,
      runScan,
      sendCallback: (args: CallbackArgs) => dispatchCallback(args),
      continuousStore,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "worker tick crashed";
    console.error("[scan-worker/tick] crashed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 200 });
  }
}

/**
 * GET must DRAIN THE QUEUE, not describe it.
 *
 * This used to return a self-documenting JSON blob and do no work. That is
 * the same invisible failure as the 405 on /api/watches/tick, only quieter:
 * Vercel's built-in cron issues GET — and this endpoint's own response
 * listed a cron platform as its first trigger — so the scheduler received a
 * cheerful `{"ok":true}` on every tick while the queue drained nothing. A
 * 200 is the one status nobody investigates.
 *
 * `tests/cron-endpoint-methods.test.js` did not catch it because it asserted
 * both methods were EXPORTED, not that either did the work. Strengthened
 * alongside this fix. Found 2026-07-28 by the readiness probe.
 */
export async function GET(req: NextRequest) {
  return POST(req);
}
