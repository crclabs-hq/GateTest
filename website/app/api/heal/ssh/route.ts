/**
 * SSH Auto-Heal — runs diagnostic playbooks on OUR server over SSH.
 *
 * POST /api/heal/ssh — admin-only, same-origin (requireAdminRoute).
 * Body: {
 *   hostname: string,   // the scanned hostname; must be in GATETEST_SSH_HOSTNAMES
 *   dryRun?: boolean,   // true → only answer whether heal is available for it
 *   issues: Array<{ category: string, title: string, detail: string }>
 * }
 *
 * The SSH target and credentials come from env vars ONLY — never the request
 * body. A body-chosen host would let a caller redirect GATETEST_SSH_PASSWORD
 * to a server they control:
 *   GATETEST_SSH_HOST, GATETEST_SSH_PORT, GATETEST_SSH_USER,
 *   GATETEST_SSH_PASSWORD, GATETEST_SSH_KEY
 * and the scanned hostname must be one that server serves
 * (GATETEST_SSH_HOSTNAMES): unset → 409 target_not_configured, not listed →
 * 409 target_mismatch, and no SSH connection is opened in either case.
 *
 * Every decision — the allowlist, the playbooks (read-only diagnostics plus
 * the app's own unit restart; no proxy or certificate changes), the honest
 * "ran" vs "fixed" answer — lives in app/lib/ssh-heal.js, tested with an
 * injected SSH client in tests/heal-ssh-target.test.js. This file only wires
 * Next and ssh2 to it.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdminRoute } from "@/app/lib/admin-guard";
import { platformServicePrefix } from "@/app/lib/platform-config";
import { runHeal } from "@/app/lib/ssh-heal";

/* eslint-disable @typescript-eslint/no-explicit-any */

export const maxDuration = 60;
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;

interface SshSession {
  exec(cmd: string, timeoutMs?: number): Promise<string>;
  end(): void;
}

/**
 * Open an ssh2 connection. ssh2 has native crypto bindings Turbopack cannot
 * statically analyse, so it is required at call time — and only once a
 * request has passed every check that can refuse without connecting.
 */
async function connectSsh(config: Record<string, unknown>): Promise<SshSession> {
  let Client: new () => any;
  try {
    const modName = "ssh2";
    Client = require(modName).Client;
  } catch {
    throw new Error("the ssh2 module is not installed on the server (npm install ssh2)");
  }
  const conn = new Client();
  await new Promise<void>((resolve, reject) => {
    conn.on("ready", resolve);
    conn.on("error", reject);
    conn.connect(config as any);
  });
  return {
    exec(cmd: string, timeoutMs = 15000): Promise<string> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Command timeout")), timeoutMs);
        conn.exec(cmd, (err: Error | null, stream: any) => {
          if (err) { clearTimeout(timer); reject(err); return; }
          let output = "";
          stream.on("data", (data: Buffer) => { output += data.toString(); });
          stream.stderr.on("data", (data: Buffer) => { output += data.toString(); });
          stream.on("close", () => { clearTimeout(timer); resolve(output.trim()); });
        });
      });
    },
    end() {
      conn.end();
    },
  };
}

export async function POST(req: NextRequest) {
  const refused = requireAdminRoute(req, { mutating: true });
  if (refused) return refused;

  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }

  const result = await runHeal({ env: process.env, body, svc: platformServicePrefix(), connect: connectSsh });
  return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
}
