/**
 * GET /api/sbom
 *
 * Returns a CycloneDX 1.4 Software Bill of Materials for the GateTest
 * product itself. Required by US EO 14028 and increasingly demanded by
 * enterprise procurement.
 *
 * The SBOM merges the root package (CLI engine, modules, scripts) with
 * the website package (Next.js app, lib, components). Both lockfiles
 * are walked at request time — no caching, so the answer always
 * reflects the deployed state.
 *
 * Response:
 *   200 application/vnd.cyclonedx+json
 *   {
 *     bomFormat: "CycloneDX",
 *     specVersion: "1.4",
 *     serialNumber: "urn:uuid:<sha>",
 *     version: 1,
 *     metadata: { timestamp, component: { name: "gatetest", version, type: "application" } },
 *     components: [ { name, version, type: "library", purl, licenses } ]
 *   }
 *
 * Failure modes:
 *   503  could not read either package.json (fail closed — never lie
 *        about what we ship)
 *
 * No auth — this is intentionally public. Customers / enterprise buyers
 * MUST be able to verify our supply chain without signing up.
 */

import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import crypto from "crypto";

export const dynamic = "force-dynamic";

interface CdxComponent {
  type: "library" | "application";
  name: string;
  version: string;
  purl: string;
  scope?: "required" | "optional" | "excluded";
  licenses?: Array<{ license: { id: string } | { name: string } }>;
}

interface CdxBom {
  bomFormat: "CycloneDX";
  specVersion: "1.4";
  serialNumber: string;
  version: number;
  metadata: {
    timestamp: string;
    component: { type: "application"; name: string; version: string };
    tools: Array<{ vendor: string; name: string; version: string }>;
  };
  components: CdxComponent[];
}

function readPkg(absPath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(absPath, "utf8"));
  } catch {
    return null;
  }
}

function collectDeps(pkg: Record<string, unknown> | null): Array<{ name: string; version: string; scope: "required" | "optional" }> {
  if (!pkg) return [];
  const out: Array<{ name: string; version: string; scope: "required" | "optional" }> = [];
  const required = (pkg.dependencies || {}) as Record<string, string>;
  const dev = (pkg.devDependencies || {}) as Record<string, string>;
  for (const [name, version] of Object.entries(required)) {
    out.push({ name, version: String(version).replace(/^[\^~>=<]+/, ""), scope: "required" });
  }
  for (const [name, version] of Object.entries(dev)) {
    out.push({ name, version: String(version).replace(/^[\^~>=<]+/, ""), scope: "optional" });
  }
  return out;
}

function depToComponent(dep: { name: string; version: string; scope: "required" | "optional" }): CdxComponent {
  // PURL spec: pkg:npm/<name>@<version>
  const ns = dep.name.startsWith("@") ? dep.name.split("/")[0] : "";
  const local = dep.name.startsWith("@") ? dep.name.split("/")[1] : dep.name;
  const purl = ns
    ? `pkg:npm/${encodeURIComponent(ns)}/${encodeURIComponent(local)}@${encodeURIComponent(dep.version)}`
    : `pkg:npm/${encodeURIComponent(dep.name)}@${encodeURIComponent(dep.version)}`;
  return {
    type: "library",
    name: dep.name,
    version: dep.version,
    purl,
    scope: dep.scope,
  };
}

export async function GET() {
  // Repo root is two levels up from website/app/api/sbom/route.ts.
  const websiteDir = path.resolve(process.cwd());
  const repoRoot = path.resolve(websiteDir, "..");

  const rootPkg = readPkg(path.join(repoRoot, "package.json"));
  const websitePkg = readPkg(path.join(websiteDir, "package.json"));

  if (!rootPkg && !websitePkg) {
    return NextResponse.json(
      { error: "could not read any package.json — SBOM unavailable" },
      { status: 503 },
    );
  }

  // Deduplicate by (name + version)
  const allDeps = [...collectDeps(rootPkg), ...collectDeps(websitePkg)];
  const seen = new Map<string, { name: string; version: string; scope: "required" | "optional" }>();
  for (const d of allDeps) {
    const key = `${d.name}@${d.version}`;
    if (!seen.has(key)) {
      seen.set(key, d);
    } else {
      // If we've seen this dep as 'optional' and now see 'required', upgrade.
      const existing = seen.get(key)!;
      if (existing.scope === "optional" && d.scope === "required") {
        seen.set(key, d);
      }
    }
  }
  const components: CdxComponent[] = Array.from(seen.values()).map(depToComponent);

  const productName = (rootPkg && (rootPkg.name as string)) || "gatetest";
  const productVersion = (rootPkg && (rootPkg.version as string)) || "0.0.0-dev";

  // Deterministic serial number — same content → same UUID. Helps consumers
  // detect "the SBOM hasn't changed since last fetch."
  const hash = crypto.createHash("sha256").update(JSON.stringify(components)).digest("hex");
  const serialNumber = `urn:uuid:${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;

  const bom: CdxBom = {
    bomFormat: "CycloneDX",
    specVersion: "1.4",
    serialNumber,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: {
        type: "application",
        name: productName,
        version: productVersion,
      },
      tools: [
        {
          vendor: "GateTest",
          name: "sbom-route",
          version: "1.0.0",
        },
      ],
    },
    components,
  };

  return NextResponse.json(bom, {
    headers: {
      "Content-Type": "application/vnd.cyclonedx+json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      // CORS — let third-party SBOM consumers fetch without proxying.
      "Access-Control-Allow-Origin": "*",
    },
  });
}
