/**
 * POST /api/scan/ci-fix
 *
 * Internal endpoint — called fire-and-forget from the GitHub webhook handler
 * when a `workflow_run` failure event arrives from any repo that has the
 * GateTest App installed.
 *
 * Flow:
 *   1. Validate the CRON_SECRET bearer token (same guard as the worker tick).
 *   2. Mint a GitHub App installation token for the target repo.
 *   3. Dispatch `workflow_dispatch` on the GateTest repo to trigger
 *      `.github/workflows/ai-ci-fixer-remote.yml` with the target repo
 *      and failed run-id as inputs.
 *   4. The remote workflow checks out the target repo, runs ai-ci-fixer.js,
 *      and opens a fix PR — all with repo-scoped App credentials.
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>` — same as /api/scan/worker/tick.
 *
 * Body (JSON):
 *   {
 *     repository:   "owner/repo",   // failing repo
 *     runId:        12345678,        // workflow run id
 *     headSha:      "abc123...",     // 40-hex sha of failing commit
 *     headBranch:   "main",          // branch name
 *     workflowName: "Build & Release",
 *     eventId:      "<uuid>",        // X-GitHub-Delivery (idempotency)
 *   }
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveGithubToken } from "@/app/lib/github-app";

export const runtime = "nodejs";
export const maxDuration = 30;

const GATETEST_REPO = "crclabs-hq/GateTest";
const REMOTE_WORKFLOW_FILE = "ai-ci-fixer-remote.yml";
const GH_API = "https://api.github.com";

function unauthorised(msg: string) {
  return NextResponse.json({ error: msg }, { status: 401 });
}

export async function POST(req: NextRequest) {
  // Auth — same bearer-token guard as /api/scan/worker/tick.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET not set" }, { status: 503 });
  }
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (bearer !== cronSecret) {
    return unauthorised("invalid token");
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const repository   = typeof body.repository   === "string" ? body.repository   : null;
  const runId        = typeof body.runId         === "number" ? body.runId        : null;
  const headSha      = typeof body.headSha       === "string" ? body.headSha      : null;
  const headBranch   = typeof body.headBranch    === "string" ? body.headBranch   : "main";
  const workflowName = typeof body.workflowName  === "string" ? body.workflowName : "";

  if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) {
    return NextResponse.json({ error: "repository is required (owner/repo)" }, { status: 400 });
  }
  if (!runId) {
    return NextResponse.json({ error: "runId is required" }, { status: 400 });
  }
  if (!headSha || !/^[0-9a-f]{40}$/i.test(headSha)) {
    return NextResponse.json({ error: "headSha must be a 40-hex sha" }, { status: 400 });
  }

  // Mint an installation token for the GateTest repo itself (where the
  // remote workflow lives). The target repo token is generated inside the
  // workflow using the App private key secret.
  const [gtOwner, gtRepo] = GATETEST_REPO.split("/");
  const { token, error: tokenError } = await resolveGithubToken(gtOwner, gtRepo);
  if (!token) {
    console.error("[ci-fix] could not resolve GitHub token for GateTest repo:", tokenError);
    return NextResponse.json({ error: "could not resolve GitHub App token" }, { status: 503 });
  }

  // Dispatch the remote workflow.
  const dispatchRes = await fetch(
    `${GH_API}/repos/${GATETEST_REPO}/actions/workflows/${REMOTE_WORKFLOW_FILE}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ref: "main",
        inputs: {
          target_repo:   repository,
          run_id:        String(runId),
          head_sha:      headSha,
          head_branch:   headBranch,
          workflow_name: workflowName,
        },
      }),
    }
  );

  if (dispatchRes.status !== 204) {
    const text = await dispatchRes.text().catch(() => "");
    console.error(`[ci-fix] workflow_dispatch failed (${dispatchRes.status}):`, text.slice(0, 300));
    return NextResponse.json(
      { error: `workflow_dispatch failed (status ${dispatchRes.status})` },
      { status: 502 }
    );
  }

  console.log(`[ci-fix] dispatched ai-ci-fixer-remote for ${repository} run ${runId}`);
  return NextResponse.json({ ok: true, repository, runId });
}
