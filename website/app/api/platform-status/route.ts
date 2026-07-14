import { NextResponse } from "next/server";
import buildInfo from "@/app/data/build-info.json";

// Build-time stamp (website `prebuild` runs scripts/generate-build-info.js).
// Env still wins if a deploy platform injects its own; otherwise the real git
// SHA baked at build time makes a STALE deploy obvious — the SHA here won't
// match main's tip. This is the tripwire the stale-site incident lacked.
const PRODUCT = "gatetest" as const;
const VERSION = process.env.APP_VERSION ?? buildInfo.version ?? "dev";
const COMMIT = process.env.GIT_COMMIT ?? buildInfo.commit ?? "unknown";
const BUILT_AT = buildInfo.builtAt ?? null;

const SIBLINGS = {
  vapron: "https://vapron.ai/api/platform-status",
  gluecron: "https://gluecron.com/api/platform-status",
  gatetest: "https://gatetest.ai/api/platform-status",
} as const;

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    {
      product: PRODUCT,
      version: VERSION,
      commit: COMMIT,
      builtAt: BUILT_AT,
      healthy: true,
      timestamp: new Date().toISOString(),
      siblings: SIBLINGS,
    },
    {
      headers: {
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      },
    },
  );
}
