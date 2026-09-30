/**
 * Shared error plumbing for the secrets panel and its dialogs.
 */

import { SecretsApiError } from "./api";
import { errorCopy } from "./logic";

/** Runs a call, asking for step-up and retrying once on step_up_required. */
export type Guarded = <T>(fn: () => Promise<T>) => Promise<T>;

/** Plain-language copy for any error a panel call can throw. */
export function messageFor(err: unknown): string {
  if (err instanceof SecretsApiError) return errorCopy(err.code, err.status);
  return errorCopy("network");
}
