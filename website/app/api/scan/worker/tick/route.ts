/**
 * Signal Bus E1 — cron-driven worker tick.
 *
 * Wire contract (GateTest's OWN copy — see also /api/events/push).
 * Triggered by:
 *   1. Vercel cron: `* * * * *` from vercel.json (X-Vercel-Cron-Secret
 *      header forwarded)
 *   2. Inline kick from /api/events/push after a new event is enqueued
 *      (same header; reduces queue latency from ~30s avg to ~0s for
 *      bursts)
 *   3. Admin-auth'd manual trigger (for debugging)
 *
 * Responsibility:
 *   - Reclaim rows stuck in status='running' (> 5 minutes) via
 *     reclaimStuck — defends against the Vercel-killed-mid-scan case
 *   - Claim the next ready row via claimNextJob (FOR UPDATE SKIP LOCKED)
 *   - Run the scan via scan-executor.runScan (shared path with
 *     /api/scan/run and the Stripe webhook async handler)
 *   - On success: markDone + callback to Gluecron
 *   - On failure: markFailed(willRetry). If dead-lettered, also fire
 *     a callback with status='error' so Gluecron doesn't wait forever
 *   - NEVER throws to Vercel — all errors are caught and returned
 *     as a clean JSON response
 *
 * Time budget: 60s Vercel function. runScan is designed to fit in
 * that envelope for quick tier; full tier jobs that approach the limit
 * should flag it in result_json for future sizing work.
 *
 * Design rationale (Signal Bus E1): one job per tick, so a 60-per-hour
 * cron steady-state is predictable. Bursts are absorbed by the inline
 * kick path.
 *
 * See website/app/lib/scan-worker.js for the pure helpers; tests live
 * at tests/scan-worker-tick.test.js.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/app/lib/db";
import { isAdminRequest } from "@/app/lib/admin-auth";
import { runScan } from "@/app/lib/scan-executor";
import { sendGluecronCallback } from "@/app/lib/gluecron-callback";

// Queue worker: reclaims stuck jobs + runs the next pending scan. A full
// scan can hit 60s; we cap there. The cron fires every minute so any
// scan that would exceed this gets retried on the next tick.
export const maxDuration = 60;

// CommonJS interop.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const scanWorker = require("@/app/lib/scan-worker");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const queueStore = require("@/app/lib/scan-queue-store");

interface CallbackArgs {
  repository: string;
  sha: string;
  ref?: string | null;
  pullRequestNumber?: number | null;
  scanResult: Parameters<typeof sendGluecronCallback>[0]["scanResult"];
}

export async function POST(req: NextRequest) {
  // Outer try/catch — we must never throw to Vercel. A broken worker
  // should log and move on; the next cron tick will try again.
  try {
    const cronHeader = req.headers.get("x-vercel-cron-secret");
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

    const result = await scanWorker.runWorkerTick({
      sql,
      queueStore,
      runScan,
      sendCallback: (args: CallbackArgs) =>
        sendGluecronCallback({
          repository: args.repository,
          sha: args.sha,
          ref: args.ref ?? undefined,
          scanResult: args.scanResult,
        }),
    });

    const status = result.ok || result.idle ? 200 : 200;
    // Note: even a job-failure response returns HTTP 200 — the tick itself
    // ran successfully; the failure is in-band state for the caller.
    return NextResponse.json(result, { status });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "worker tick crashed";
    console.error("[scan-worker/tick] crashed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 200 });
  }
}

// Health check — returns the same auth-shape but does nothing.
export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: "/api/scan/worker/tick",
    method: "POST",
    triggers: ["vercel-cron", "inline-kick-from-events-push", "admin"],
  });
}
