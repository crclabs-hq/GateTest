/**
 * Admin Platform Registry — Neon-backed store for Craig-owned platforms.
 *
 * Any GitHub org added here gets 'admin' mode automatically in the GitHub
 * callback: the gate runs strict (errors → failure) but with no advisory
 * messaging or "why is this not red?" upgrade prompts.
 *
 * Failure is reported, never disguised as an empty registry: if
 * DATABASE_URL is unset or the read throws, listAdminPlatforms /
 * getAdminOrgs throw with the reason, and add/delete return
 * { ok: false, error }. The scan worker catches getAdminOrgs and falls back
 * to the env-var GATETEST_ADMIN_ORGS list; the admin tab shows the error.
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

interface AdminPlatform {
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
    // error-ok — not a URL — treat as bare org name if it looks valid
  }
  // Bare org name: letters, digits, hyphens
  if (/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(s)) return s;
  return null;
}

/**
 * List the registry. THROWS when the store cannot be read — an unreadable
 * registry is "not checked", not "no platforms registered" (doctrine 1).
 * It used to return [] here, so a DB outage rendered as an empty registry
 * in the admin Platforms tab. Callers that must keep running (the scan
 * worker's getAdminOrgs().catch(...)) handle the throw themselves.
 */
export async function listAdminPlatforms(): Promise<AdminPlatform[]> {
  try {
    const sql = getDb();
    await ensureSchema();
    const rows = await sql`
      SELECT id, github_org, display_url, added_at::text
      FROM admin_platforms
      ORDER BY added_at DESC
    `;
    return rows as AdminPlatform[];
  } catch (err) {
    throw new Error(`admin platform registry not readable: ${err instanceof Error ? err.message : String(err)}`);
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
