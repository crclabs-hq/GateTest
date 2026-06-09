import { NextResponse } from "next/server";

const PRODUCT = "gatetest" as const;
const VERSION = process.env.APP_VERSION ?? "dev";
const COMMIT = process.env.GIT_COMMIT ?? "unknown";

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
