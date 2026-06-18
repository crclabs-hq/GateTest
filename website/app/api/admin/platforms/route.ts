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
 * Auth: same two-method check as all other /api/admin/* routes.
 */

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "crypto";
import {
  getAdminConfig,
  getAdminUser,
  SESSION_COOKIE_NAME,
} from "@/app/lib/admin-session";
import { ADMIN_COOKIE_NAME } from "@/app/lib/admin-auth";
import {
  listAdminPlatforms,
  addAdminPlatform,
  deleteAdminPlatform,
  parseGitHubOrg,
} from "@/app/lib/admin-platforms";

export const dynamic = "force-dynamic";

async function isAuthenticatedAdmin(): Promise<boolean> {
  const store = await cookies();
  const adminStatus = getAdminConfig();
  if (adminStatus.ok && adminStatus.config) {
    const sessionCookie = store.get(SESSION_COOKIE_NAME)?.value;
    if (getAdminUser(sessionCookie, adminStatus.config)) return true;
  }
  const adminPassword = process.env.GATETEST_ADMIN_PASSWORD || "";
  if (adminPassword) {
    const passwordCookie = store.get(ADMIN_COOKIE_NAME)?.value || "";
    const expected = crypto
      .createHmac("sha256", adminPassword)
      .update("gatetest-admin-v1")
      .digest("hex");
    if (
      passwordCookie &&
      passwordCookie.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(passwordCookie), Buffer.from(expected))
    )
      return true;
  }
  return false;
}

export async function GET() {
  if (!(await isAuthenticatedAdmin())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const platforms = await listAdminPlatforms();
  return NextResponse.json({ platforms });
}

export async function POST(req: NextRequest) {
  if (!(await isAuthenticatedAdmin())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
  if (!(await isAuthenticatedAdmin())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
