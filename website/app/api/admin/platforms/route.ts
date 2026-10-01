/**
 * Admin Platform Registry API
 *
 *   GET    /api/admin/platforms            → list all registered admin platforms
 *   POST   /api/admin/platforms            → { url } → add a platform (parse org from URL)
 *   DELETE /api/admin/platforms?org=<org>  → remove a platform by org name
 *
 * Platforms registered here get 'admin' mode in the GitHub callback:
 * the gate runs strict (errors → failure) but without any advisory-mode
 * messaging. Craig pastes a GitHub URL or org name; GateTest handles the rest.
 *
 * Auth: requireAdminRoute (app/lib/admin-guard.ts), like every /api/admin/* route.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdminRoute } from "@/app/lib/admin-guard";
import {
  listAdminPlatforms,
  addAdminPlatform,
  deleteAdminPlatform,
  parseGitHubOrg,
} from "@/app/lib/admin-platforms";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const refused = requireAdminRoute(req);
  if (refused) return refused;
  try {
    const platforms = await listAdminPlatforms();
    return NextResponse.json({ platforms });
  } catch (err) {
    // listAdminPlatforms throws with the reason instead of returning [] —
    // pass it on so the tab says why, not "No admin platforms registered".
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `admin platforms could not be read: ${message}` }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  const refused = requireAdminRoute(req, { mutating: true });
  if (refused) return refused;

  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rawInput = String(body?.url || "").trim();
  if (!rawInput) {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }

  const githubOrg = parseGitHubOrg(rawInput);
  if (!githubOrg) {
    return NextResponse.json(
      { error: `Could not parse a GitHub org name from "${rawInput}". Provide a GitHub URL (https://github.com/my-org) or a bare org name.` },
      { status: 400 }
    );
  }

  const result = await addAdminPlatform(githubOrg, rawInput !== githubOrg ? rawInput : undefined);
  if (!result.ok) {
    return NextResponse.json({ error: result.error || "DB error" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, github_org: githubOrg }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const refused = requireAdminRoute(req, { mutating: true });
  if (refused) return refused;

  const org = new URL(req.url).searchParams.get("org");
  if (!org) {
    return NextResponse.json({ error: "?org= is required" }, { status: 400 });
  }

  const result = await deleteAdminPlatform(org);
  if (!result.ok) {
    return NextResponse.json({ error: result.error || "DB error" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
