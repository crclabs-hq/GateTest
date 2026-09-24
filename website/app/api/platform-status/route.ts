import { NextResponse } from "next/server";
import buildInfo from "@/app/data/build-info.json";
import { siblingUrlMap } from "@/app/lib/platform-siblings";

// Both helpers are CommonJS .js modules (shared with scripts/ outside the
// Next app); a namespace import gives the bundler interop without an inline
// lint disable.
import * as tallrigPushEventStore from "@/app/lib/tallrig-push-event-store";
import * as pullDeployStatus from "@/app/lib/pull-deploy-status";

// Build-time stamp (website `prebuild` runs scripts/generate-build-info.js).
// Env still wins if a deploy platform injects its own; otherwise the real git
// SHA baked at build time makes a STALE deploy obvious — the SHA here won't
// match main's tip. This is the tripwire the stale-site incident lacked.
const PRODUCT = "gatetest" as const;
const VERSION = process.env.APP_VERSION ?? buildInfo.version ?? "dev";
const COMMIT = process.env.GIT_COMMIT ?? buildInfo.commit ?? "unknown";
const BUILT_AT = buildInfo.builtAt ?? null;

// Sibling URLs come from ONE registry shared with the admin health
// aggregator (app/lib/platform-siblings.js). They used to be written out
// here as literals; the Vapron entry said `https://vapron.ai/api/platform-status`
// long after that path was measured at 404 and corrected in the admin copy —
// this map is how other products discover Vapron, so it was handing them a
// dead URL. Resolved per-request, not at module load, so a deployment can
// repoint a sibling with an env var without a rebuild.

export const dynamic = "force-dynamic";

export async function GET() {
  // No `deployedBy` field exists on this response for a Tallrig push event
  // to populate (issue #672) — this is the closest fit instead: the sha of
  // the most recent `deploy.finished` event Tallrig has sent us, or null
  // until one has been received. Read is best-effort; a store error here
  // must never turn a healthy platform-status response into a 500.
  let lastTallrigDeploy = null;
  try {
    lastTallrigDeploy = tallrigPushEventStore.lastTallrigDeploy();
  } catch {
    // not checked — the store had a problem; the rest of this response is
    // still accurate, so it ships without the field rather than failing.
  }

  // The box's own deploy status (issue #706) — scripts/deploy/pull-deploy.sh
  // writes this on every tick. readLastPullDeploy() is contracted never to
  // throw (a missing, unreadable or malformed file comes back as
  // `result: "unknown"` with the reason; tests/pull-deploy-status.test.js
  // proves each case), so no catch is needed here — a catch that could only
  // hold a comment would hide a broken contract instead of handling it.
  const lastPullDeploy = pullDeployStatus.readLastPullDeploy();

  return NextResponse.json(
    {
      product: PRODUCT,
      version: VERSION,
      commit: COMMIT,
      builtAt: BUILT_AT,
      healthy: true,
      timestamp: new Date().toISOString(),
      siblings: siblingUrlMap(),
      lastTallrigDeploy,
      lastPullDeploy,
    },
    {
      headers: {
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      },
    },
  );
}
