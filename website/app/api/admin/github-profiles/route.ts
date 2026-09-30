/**
 * /api/admin/github-profiles
 *
 * GET    — list all stored GitHub profiles (tokens redacted to last 4 chars);
 *          503 { error: "store_unavailable" } when the store cannot be read
 * POST   — { label, token, orgs?: string[] } → add a profile; auto-verifies
 *           the token against GitHub's /user endpoint to get the login name
 * DELETE — ?id=<id> → remove a profile by id
 *
 * All endpoints go through requireAdminRoute (app/lib/admin-guard.ts): the
 * gt_admin session cookie or the OAuth admin session, same-origin on POST /
 * DELETE. They used to demand the PLAINTEXT admin password in a request
 * header, which the Accounts tab tried to read from a cookie it cannot see
 * (gt_admin is HttpOnly, and it looked for the wrong name) — so every call
 * 401'd and the tab reported "no accounts".
 */

import { NextRequest, NextResponse } from "next/server";
import {
  addGitHubProfile,
  listGitHubProfiles,
  removeGitHubProfile,
} from "@/app/lib/admin-github-profiles";
import { requireAdminRoute } from "@/app/lib/admin-guard";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(req: NextRequest) {
  const refused = requireAdminRoute(req);
  if (refused) return refused;
  const listed = await listGitHubProfiles();
  if (!listed.ok) return NextResponse.json({ error: listed.reason }, { status: 503, headers: NO_STORE });
  return NextResponse.json({ profiles: listed.profiles }, { headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  const refused = requireAdminRoute(req, { mutating: true });
  if (refused) return refused;

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
    // error-ok — token verification failed — still allow saving, just no login
  }

  const result = await addGitHubProfile(label, token, githubLogin, orgs);
  if (!result.ok)
    return NextResponse.json({ error: result.error }, { status: 400 });

  return NextResponse.json({ ok: true, id: result.id, github_login: githubLogin });
}

export async function DELETE(req: NextRequest) {
  const refused = requireAdminRoute(req, { mutating: true });
  if (refused) return refused;

  const id = Number(new URL(req.url).searchParams.get("id") || "0");
  if (!id || !Number.isFinite(id))
    return NextResponse.json({ error: "id is required" }, { status: 400 });

  const result = await removeGitHubProfile(id);
  if (!result.ok)
    return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
