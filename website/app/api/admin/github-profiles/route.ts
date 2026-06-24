/**
 * /api/admin/github-profiles
 *
 * GET    — list all stored GitHub profiles (tokens redacted to last 4 chars)
 * POST   — { label, token, orgs?: string[] } → add a profile; auto-verifies
 *           the token against GitHub's /user endpoint to get the login name
 * DELETE — ?id=<id> → remove a profile by id
 *
 * All endpoints require the admin password header (X-Admin-Password).
 */

import { NextRequest, NextResponse } from "next/server";
import {
  addGitHubProfile,
  listGitHubProfiles,
  removeGitHubProfile,
} from "@/app/lib/admin-github-profiles";

const ADMIN_PASSWORD = process.env.GATETEST_ADMIN_PASSWORD || "";

function isAuthorized(req: NextRequest): boolean {
  const header = req.headers.get("x-admin-password") || "";
  if (!ADMIN_PASSWORD) return false;
  return header === ADMIN_PASSWORD;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const profiles = await listGitHubProfiles();
  return NextResponse.json({ profiles });
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { label?: string; token?: string; orgs?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { label = "", token = "", orgs = [] } = body;
  if (!label.trim())
    return NextResponse.json({ error: "label is required" }, { status: 400 });
  if (!token.trim())
    return NextResponse.json({ error: "token is required" }, { status: 400 });

  // Verify token against GitHub API to get the login name
  let githubLogin: string | null = null;
  try {
    const r = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        "User-Agent": "GateTest-Admin/1.0",
      },
    });
    if (r.ok) {
      const data = (await r.json()) as { login?: string };
      githubLogin = data.login || null;
    }
  } catch {
    // token verification failed — still allow saving, just no login
  }

  const result = await addGitHubProfile(label, token, githubLogin, orgs);
  if (!result.ok)
    return NextResponse.json({ error: result.error }, { status: 400 });

  return NextResponse.json({ ok: true, id: result.id, github_login: githubLogin });
}

export async function DELETE(req: NextRequest) {
  if (!isAuthorized(req))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const id = Number(new URL(req.url).searchParams.get("id") || "0");
  if (!id || !Number.isFinite(id))
    return NextResponse.json({ error: "id is required" }, { status: 400 });

  const result = await removeGitHubProfile(id);
  if (!result.ok)
    return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
