// What one /api/scan/run response means, and how a tier is described while
// the operator waits for it. Used by <LiveScanTerminal> (customer scan page
// and the admin Repo Scan tab) and the admin tier <select>.
//
// Zero imports on purpose: tests/admin-repo-scan-honest.test.js require()s
// this file through Node's type-stripping loader. Callers pass the tier
// table in (import it from ./checkout-tiers — the one definition), so no
// module count is ever typed here.
//
// Defect this exists to prevent (admin audit, 2026-09-29): the terminal
// never checked res.ok, so a 500 `{status:"failed"}` body — no modules, no
// issues — printed "GATE: PASSED" and the admin tab showed "All Clear".

export type ScanOutcomeKind = "passed" | "issues" | "failed";

export interface ScanOutcome {
  kind: ScanOutcomeKind;
  /** Why the scan failed — set only when kind is "failed". */
  reason?: string;
  totalIssues: number;
  moduleCount: number;
  /** Modules that neither passed nor failed (skipped) — shown, never counted as passes. */
  notChecked: number;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * A scan passes only when the request succeeded, the body says "complete",
 * and at least one module actually ran with zero issues. Everything else is
 * either "issues" or "failed" with the reason — never a pass.
 */
export function classifyScanResponse(httpOk: boolean, httpStatus: number, body: unknown): ScanOutcome {
  const fail = (reason: string, mods: unknown[] = []): ScanOutcome =>
    ({ kind: "failed", reason, totalIssues: 0, moduleCount: mods.length, notChecked: 0 });
  if (!isObject(body)) return fail(`HTTP ${httpStatus} — the scan service returned no readable result`);

  const mods = Array.isArray(body.modules) ? (body.modules as unknown[]) : [];
  const said = (typeof body.error === "string" && body.error) || (typeof body.message === "string" && body.message) || "";
  if (!httpOk) return fail(`HTTP ${httpStatus}${said ? ` — ${said}` : ""}`, mods);
  if (body.status === "failed" || body.status === "error") return fail(said || "the engine reported the scan as failed", mods);
  if (body.status !== "complete") {
    return fail(said || `the scan returned no final result (status: ${String(body.status ?? "none")})`, mods);
  }

  const totalIssues = typeof body.totalIssues === "number" ? body.totalIssues : 0;
  // A cached replay of an already-finished paid session carries counts but no
  // module list; anything else with zero modules checked nothing.
  if (mods.length === 0 && body.cached !== true) {
    return fail("the engine returned no module results — nothing was checked");
  }
  const notChecked = mods.filter((m) => isObject(m) && m.status !== "passed" && m.status !== "failed").length;
  return { kind: totalIssues > 0 ? "issues" : "passed", totalIssues, moduleCount: mods.length, notChecked };
}

/**
 * The object handed to the caller's onComplete. A failed outcome always
 * carries status "failed" (or the "expired" the scan page renders itself)
 * and the reason in `error`, so no caller can read a failure as a pass.
 */
export function scanResultForCaller(body: unknown, o: ScanOutcome): Record<string, unknown> {
  const base: Record<string, unknown> = isObject(body) ? { ...body } : {};
  if (o.kind !== "failed") return base;
  return { ...base, status: base.status === "expired" ? "expired" : "failed", error: o.reason };
}

/** The final terminal line for an outcome. */
export function gateLine(o: ScanOutcome, durationMs: unknown): string {
  const ms = typeof durationMs === "number" ? `, ${durationMs}ms` : "";
  const skipped = o.notChecked > 0 ? ` (${o.notChecked} not checked)` : "";
  if (o.kind === "failed") return `GATE: FAILED — ${o.reason}`;
  if (o.kind === "passed") return `GATE: PASSED — ${o.moduleCount} modules${skipped}${ms}`;
  return `GATE: ${o.totalIssues} ISSUE${o.totalIssues === 1 ? "" : "S"} — ${o.moduleCount} modules${skipped}${ms}`;
}

// ---------------------------------------------------------------- tiers --

/** The fields of a checkout-tiers entry this file reads. */
export interface TierLike {
  name: string;
  modules: string;
  target?: string;
  recurring?: boolean;
}

/** Named module list for a tier ("syntax, lint, …"), or null when the tier runs every applicable module. */
export function tierModuleNames(t: TierLike | undefined): string[] | null {
  if (!t || !/^\w+(\s*,\s*\w+)*$/.test(t.modules.trim())) return null;
  return t.modules.split(",").map((s) => s.trim()).filter(Boolean);
}

/** "every applicable module + pair-review + architecture" from "all-applicable+pair-review+architecture". */
function scopeWords(modules: string): string {
  return modules
    .split("+")
    .map((part) => (part === "all-applicable" ? "every applicable module" : part.replace(/-/g, " ")))
    .join(" + ");
}

/** e.g. "Quick Scan — 4 modules", "Full Scan — every applicable module". */
export function scanTierLabel(key: string, tiers: Record<string, TierLike>): string {
  const t = tiers[key];
  if (!t) return key;
  const names = tierModuleNames(t);
  return names ? `${t.name} — ${names.length} module${names.length === 1 ? "" : "s"}` : `${t.name} — ${scopeWords(t.modules)}`;
}

/** Tiers /api/scan/run runs against a repository: not URL-target, not subscriptions. */
export function repoScanTierKeys(tiers: Record<string, TierLike>): string[] {
  return Object.keys(tiers).filter((k) => !tiers[k].target && !tiers[k].recurring);
}

/** What the terminal says it is waiting for — never a per-module feed it does not have. */
export function tierScopeLine(key: string, tiers: Record<string, TierLike>): string {
  const t = tiers[key];
  if (!t) return `Tier "${key}"`;
  const names = tierModuleNames(t);
  return names
    ? `${t.name}: ${names.length} module${names.length === 1 ? "" : "s"} — ${names.join(", ")}`
    : `${t.name}: ${scopeWords(t.modules)}`;
}
