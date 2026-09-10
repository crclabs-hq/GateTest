import * as F from "../_facts";

type SubProcessor = (typeof F.SUB_PROCESSORS)[number];

/**
 * Prose in the Privacy Policy that mentions a provider by name resolves it
 * through the authoritative sub-processor list, so the policy can never name
 * a company that is no longer one. If the list drifts the build fails here,
 * loudly, instead of the page quietly going stale.
 */
export function vendor(name: string): SubProcessor {
  const v = F.SUB_PROCESSORS.find((s) => s.name === name);
  if (!v) throw new Error(`legal: "${name}" is not in SUB_PROCESSORS — update _facts.js or the document that cites it`);
  return v;
}

export const ANTHROPIC = vendor("Anthropic");
export const OPENAI = vendor("OpenAI");
export const STRIPE = vendor("Stripe");
export const SENTRY = vendor("Sentry");
export const GITHUB = vendor("GitHub");
export const GLUECRON = vendor("Gluecron");
export const RESEND = vendor("Resend");
