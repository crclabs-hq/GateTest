/**
 * /admin/secrets — typed fetch helpers for the infra-secrets API.
 *
 * Coded against the backend contract (feat/admin-secrets-store). Every call
 * is same-origin with `credentials: "same-origin"` and `cache: "no-store"`.
 * Secret values only ever travel in a JSON request body (PUT) or a JSON
 * response body (reveal) — never in a URL, a header, or a log line. The
 * only thing interpolated into a path is the secret's NAME.
 */

type Tier = "required" | "important" | "optional" | "custom";
type SecretState = "set" | "missing" | "placeholder";
type SecretSource = "store" | "env" | "both" | "none";
type Liveness = "alive" | "dead" | "cannot-tell" | "unchecked";

export interface SecretItem {
  name: string;
  tier: Tier;
  why: string;
  state: SecretState;
  source: SecretSource;
  shadowed: boolean;
  shadowWinner?: string;
  fingerprint?: string;
  updatedAt?: string;
  updatedBy?: string;
  liveness: Liveness;
  lastVerifiedAt?: string;
  reserved: boolean;
}

interface ApplyState {
  lastAppliedAt: string | null;
  applied: boolean;
  reason?: string;
}

export interface SecretsList {
  storeReady: boolean;
  storeError?: string;
  keyVersion: number | string | null;
  unitEnvPath: string;
  applyState: ApplyState;
  items: SecretItem[];
}

interface ApplyOutcome {
  applied: boolean;
  reason?: string;
  /** With reason "would_drop_keys": the names the env file holds that the store no longer has. */
  dropped?: string[];
}

export interface SetResult {
  ok: boolean;
  fingerprint: string;
  apply: ApplyOutcome;
  warnings?: string[];
}

export interface DeleteResult {
  ok: boolean;
  apply: ApplyOutcome;
}

interface VerifyResult {
  liveness: Liveness;
  checkedAt: string;
}

export interface ApplyResult {
  applied: boolean;
  reason?: string;
  path: string;
  count: number;
  /** With reason "would_drop_keys": the names a retry must list in `allowRemoving`. */
  dropped?: string[];
}

export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  name: string | null;
  ip: string | null;
  outcome: string;
}

/** Whether the hash chain over the WHOLE trail still verifies; brokenAt is 0-based, oldest first. */
export type AuditChain = { ok: true; count: number } | { ok: false; brokenAt?: number; reason?: string };

interface StepUpResult {
  ok: boolean;
  freshUntil: string;
}

/** A non-2xx answer. `code` is the contract's error code when the body had one. */
export class SecretsApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.name = "SecretsApiError";
    this.status = status;
    this.code = code;
  }
}

const BASE = "/api/admin/secrets";
const STEP_UP = "/api/admin/step-up";

function secretPath(name: string): string {
  return `${BASE}/${encodeURIComponent(name)}`;
}

async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init?.method ?? "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new SecretsApiError(0, "network");
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) {
    const body = (json ?? {}) as { error?: unknown; code?: unknown };
    const code =
      typeof body.error === "string" ? body.error : typeof body.code === "string" ? body.code : `http_${res.status}`;
    throw new SecretsApiError(res.status, code);
  }
  return json as T;
}

export function listSecrets(): Promise<SecretsList> {
  return call<SecretsList>(BASE);
}

export function setSecret(name: string, value: string): Promise<SetResult> {
  return call<SetResult>(secretPath(name), { method: "PUT", body: { value } });
}

export function deleteSecret(name: string): Promise<DeleteResult> {
  return call<DeleteResult>(secretPath(name), { method: "DELETE" });
}

export function revealSecret(name: string): Promise<{ value: string }> {
  return call<{ value: string }>(`${secretPath(name)}/reveal`, { method: "POST" });
}

export function verifySecret(name: string): Promise<VerifyResult> {
  return call<VerifyResult>(`${secretPath(name)}/verify`, { method: "POST" });
}

/**
 * Re-render the env file. `allowRemoving` names the keys the owner confirmed
 * may leave the file (the answer to a `would_drop_keys` refusal); a plain
 * apply sends no body.
 */
export function applySecrets(allowRemoving?: readonly string[]): Promise<ApplyResult> {
  const body = allowRemoving && allowRemoving.length > 0 ? { allowRemoving: [...allowRemoving] } : undefined;
  return call<ApplyResult>(`${BASE}/apply`, { method: "POST", body });
}

export function listAudit(limit = 50): Promise<{ entries: AuditEntry[]; chain?: AuditChain }> {
  return call<{ entries: AuditEntry[]; chain?: AuditChain }>(`${BASE}/audit?limit=${Math.max(1, Math.min(50, Math.floor(limit)))}`);
}

export function stepUp(password: string): Promise<StepUpResult> {
  return call<StepUpResult>(STEP_UP, { method: "POST", body: { password } });
}
