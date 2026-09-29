/**
 * Which sign-in providers are actually usable right now.
 *
 * GET /api/auth/providers → { github: true, gitlab: false, google: false, gluecron: false }
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * AuthModal rendered all three provider buttons unconditionally while the
 * initiate routes return HTTP 503 when their credentials are unset. On
 * 2026-08-05 production was missing GOOGLE_CLIENT_SECRET, so "Continue with
 * Google" answered with a raw JSON error blob. A GitHub Marketplace reviewer
 * clicking a sign-in button and getting a 503 is a failed review, and the
 * listing was already rejected once.
 *
 * Booleans only — never the client IDs, never the missing-variable names. The
 * point is what a visitor can do, not what our environment looks like.
 * (`/api/status` deliberately reports missing vars, but that is an operator
 * endpoint; this one is called from the browser on every modal open.)
 */

import { NextResponse } from "next/server";
import {
  getOAuthConfig,
  getGitLabOAuthConfig,
  getGoogleOAuthConfig,
  getGluecronOAuthConfig,
} from "@/app/lib/customer-session";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    {
      github: getOAuthConfig().ok,
      gitlab: getGitLabOAuthConfig().ok,
      google: getGoogleOAuthConfig().ok,
      gluecron: getGluecronOAuthConfig().ok,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
