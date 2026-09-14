/**
 * Bare liveness ping — GET /api/health
 *
 * docker-compose.yml's `app` healthcheck and scripts/sandbox-worker.js's
 * readiness loop both polled this path, and it did not exist: production
 * answered 404 on 2026-09-14, so `docker compose up` could never mark the
 * app healthy and the worker never started. This answers the one question
 * an orchestrator asks — is the process serving requests — and nothing else.
 * Configuration readiness lives at /api/status; the deployed commit at
 * /api/platform-status. Do not grow this route: a healthcheck that touches
 * the database restarts a healthy web process when the database blips.
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// auth-public — a liveness ping for the container orchestrator. It returns a
// constant body: no configuration, no counts, no secrets.
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { ok: true },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
