/**
 * GET /api/noise?days=90
 *
 * The Fifty, move 08: the worst-first per-rule table a demotion decision
 * needs — `sampleSize` (total findings, the trust floor), `silencedRate`,
 * and `candidate` (both floors cleared) — built over the same aggregator
 * `/api/telemetry/noise` (move 07) uses, so the two surfaces can never
 * disagree about a rate.
 *
 * Three states, never a fourth that looks like "no noisy rules" (Doctrine
 * #1): `status` is "ok" when at least one rule has enough findings to
 * trust its rate, "not-enough-data" when every rule is below the floor (or
 * there is no telemetry at all in the window), and the route answers 503
 * with "ledger-unavailable" when the store itself can't be read — an empty
 * `rules: []` array is never returned as if it meant "clean".
 *
 *   200 { status: "ok" | "not-enough-data", windowDays, scans, floor, rate, rules: [...] }
 *   503 { status: "ledger-unavailable", reason, windowDays }
 */

import { NextRequest, NextResponse } from "next/server";
import { readRuleNoiseRows } from "@/app/lib/scan-telemetry-store";
import {
  aggregateRuleNoise,
  noisePublication,
  MIN_FINDINGS_FLOOR,
  DEFAULT_MIN_SILENCED_RATE,
} from "@/app/lib/rule-noise";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 3600;

// auth-public — aggregate counts over anonymized telemetry; nothing per-user.
export async function GET(req: NextRequest) {
  const days = Number(req.nextUrl.searchParams.get("days") || 90);
  const windowDays = Number.isFinite(days) ? days : 90;
  const read = await readRuleNoiseRows({ days: windowDays });
  if (!read.ok) {
    return NextResponse.json(
      { status: "ledger-unavailable", reason: read.reason, windowDays: read.windowDays },
      { status: 503 },
    );
  }

  const agg = aggregateRuleNoise(read.rows);
  const rules: Array<{ id: string; module: string; sampleSize: number; silencedRate: number; candidate: boolean }> =
    noisePublication(agg);
  const status = rules.some((r) => r.sampleSize >= MIN_FINDINGS_FLOOR) ? "ok" : "not-enough-data";

  return NextResponse.json(
    {
      status,
      windowDays: read.windowDays,
      scans: agg.scans,
      floor: MIN_FINDINGS_FLOOR,
      rate: DEFAULT_MIN_SILENCED_RATE,
      rules,
      generated_at: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=7200" } },
  );
}
