/**
 * Admin GitHub Profiles — Neon-backed store for multiple GitHub PATs.
 *
 * Each profile maps a label + GitHub login + token to zero or more org/user
 * names. When the admin triggers a scan on a repo, `getBestGitHubToken(owner)`
 * picks the matching profile token before falling back to the env vars.
 *
 * Tokens are stored as-is — the table is admin-only, behind password auth,
 * and never returned in full to the client (GET redacts to last 4 chars).
 *
 * Schema (idempotent):
 *   admin_github_profiles(
 *     id           SERIAL PRIMARY KEY,
 *     label        TEXT NOT NULL,
 *     github_login TEXT,
 *     token        TEXT NOT NULL,
 *     orgs         TEXT[] NOT NULL DEFAULT '{}',
 *     added_at     TIMESTAMPTZ DEFAULT NOW()
 *   )
 */

import { getDb } from "./db";

let _initDone = false;

async function ensureSchema(): Promise<void> {
  if (_initDone) return;
  const sql = getDb();
  await sql`
    CREATE TABLE IF NOT EXISTS admin_github_profiles (
      id           SERIAL PRIMARY KEY,
      label        TEXT NOT NULL,
      github_login TEXT,
      token        TEXT NOT NULL,
      orgs         TEXT[] NOT NULL DEFAULT '{}',
      added_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  _initDone = true;
}

export interface GitHubProfile {
  id: number;
  label: string;
  github_login: string | null;
  token_hint: string; // last 4 chars only — never the full token
  orgs: string[];
  added_at: string;
}

interface GitHubProfileRow {
  id: number;
  label: string;
  github_login: string | null;
  token: string;
  orgs: string[];
  added_at: string;
}

function redact(token: string): string {
  return token.length > 4 ? `***${token.slice(-4)}` : "****";
}

export async function listGitHubProfiles(): Promise<GitHubProfile[]> {
  try {
    const sql = getDb();
    await ensureSchema();
    const rows = (await sql`
      SELECT id, label, github_login, token, orgs, added_at::text
      FROM admin_github_profiles
      ORDER BY added_at DESC
    `) as unknown as GitHubProfileRow[];
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      github_login: r.github_login,
      token_hint: redact(r.token),
      orgs: r.orgs ?? [],
      added_at: r.added_at,
    }));
  } catch {
    return [];
  }
}

export async function addGitHubProfile(
  label: string,
  token: string,
  githubLogin: string | null,
  orgs: string[]
): Promise<{ ok: boolean; id?: number; error?: string }> {
  if (!label.trim()) return { ok: false, error: "Label is required" };
  if (!token.trim()) return { ok: false, error: "Token is required" };
  try {
    const sql = getDb();
    await ensureSchema();
    const rows = (await sql`
      INSERT INTO admin_github_profiles (label, github_login, token, orgs)
      VALUES (${label.trim()}, ${githubLogin || null}, ${token.trim()}, ${orgs})
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    return { ok: true, id: rows[0]?.id };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function removeGitHubProfile(id: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const sql = getDb();
    await ensureSchema();
    await sql`DELETE FROM admin_github_profiles WHERE id = ${id}`;
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Returns the best matching GitHub token for a given repo owner, trying:
 *   1. A stored profile whose `orgs` array includes `owner` (case-insensitive)
 *   2. A stored profile whose `github_login` matches `owner`
 *   3. The first stored profile (if any exist)
 *   4. GATETEST_GITHUB_TOKEN env var
 *   5. GITHUB_TOKEN env var
 *   6. Empty string (caller must handle missing token)
 */
export async function getBestGitHubToken(owner?: string): Promise<string> {
  const envToken =
    process.env.GATETEST_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "";
  try {
    const sql = getDb();
    await ensureSchema();
    const rows = (await sql`
      SELECT label, github_login, token, orgs
      FROM admin_github_profiles
      ORDER BY added_at ASC
    `) as unknown as GitHubProfileRow[];
    if (rows.length === 0) return envToken;

    if (owner) {
      const lower = owner.toLowerCase();
      // exact org match
      const byOrg = rows.find((r) =>
        r.orgs.some((o) => o.toLowerCase() === lower)
      );
      if (byOrg) return byOrg.token;
      // login match
      const byLogin = rows.find(
        (r) => r.github_login && r.github_login.toLowerCase() === lower
      );
      if (byLogin) return byLogin.token;
    }
    // fallback: first profile
    return rows[0].token;
  } catch {
    return envToken;
  }
}
