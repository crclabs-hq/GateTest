/**
 * Admin Platform Registry — Neon-backed store for Craig-owned platforms.
 *
 * Any GitHub org added here gets 'admin' mode automatically in the GitHub
 * callback: the gate runs strict (errors → failure) but with no advisory
 * messaging or "why is this not red?" upgrade prompts.
 *
 * Graceful degradation: if DATABASE_URL is unset or the DB query throws,
 * helpers return empty results — the env-var GATETEST_ADMIN_ORGS fallback
 * still applies, so misconfigured deployments don't silently break.
 *
 * Schema (idempotent):
 *   admin_platforms(
 *     id           SERIAL PRIMARY KEY,
 *     github_org   TEXT NOT NULL UNIQUE,
 *     display_url  TEXT,
 *     added_at     TIMESTAMPTZ DEFAULT NOW()
 *   )
 */

import { getDb } from "./db";

let _initDone = false;

async function ensureSchema(): Promise<void> {
  if (_initDone) return;
  const sql = getDb();
  await sql`
    CREATE TABLE IF NOT EXISTS admin_platforms (
      id           SERIAL PRIMARY KEY,
      github_org   TEXT NOT NULL UNIQUE,
      display_url  TEXT,
      added_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  _initDone = true;
}

export interface AdminPlatform {
  id: number;
  github_org: string;
  display_url: string | null;
  added_at: string;
}

/** Parse a GitHub org name from a URL or bare org string. */
export function parseGitHubOrg(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  try {
    const u = new URL(s.startsWith("http") ? s : `https://${s}`);
    if (u.hostname === "github.com") {
      const parts = u.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
      return parts[0] || null;
    }
  } catch {
    // not a URL — treat as bare org name if it looks valid
  }
  // Bare org name: letters, digits, hyphens
  if (/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(s)) return s;
  return null;
}

export async function listAdminPlatforms(): Promise<AdminPlatform[]> {
  try {
    const sql = getDb();
    await ensureSchema();
    const rows = await sql<AdminPlatform[]>`
      SELECT id, github_org, display_url, added_at::text
      FROM admin_platforms
      ORDER BY added_at DESC
    `;
    return rows;
  } catch {
    return [];
  }
}

export async function addAdminPlatform(githubOrg: string, displayUrl?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const sql = getDb();
    await ensureSchema();
    await sql`
      INSERT INTO admin_platforms (github_org, display_url)
      VALUES (${githubOrg}, ${displayUrl ?? null})
      ON CONFLICT (github_org) DO UPDATE SET display_url = EXCLUDED.display_url
    `;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function deleteAdminPlatform(githubOrg: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const sql = getDb();
    await ensureSchema();
    await sql`DELETE FROM admin_platforms WHERE github_org = ${githubOrg}`;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Returns the list of github org names stored in the DB. */
export async function getAdminOrgs(): Promise<string[]> {
  const platforms = await listAdminPlatforms();
  return platforms.map((p) => p.github_org);
}
