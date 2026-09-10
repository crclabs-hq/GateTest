/**
 * Facts shared by the Terms of Service content modules.
 *
 * Nothing in the Terms types a domain, e-mail, vendor, price, retention
 * window or module name — every one is imported from `app/legal/_facts.js`
 * (verified against the code, drift-tested) or `app/lib/checkout-tiers.ts`
 * (the tier table Stripe checkout actually charges from).
 */
import * as F from "../_facts";
import { TIERS } from "../../lib/checkout-tiers";

export { F };

export const HOST = F.siteHost();
export const SITE = F.siteUrl();
export const EMAIL = F.SUPPORT_EMAIL;

/** "US$29" / "US$19.50" from a Stripe cent amount. */
export function usd(cents: number): string {
  return `US$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`;
}

/** The tiers the Terms talk about, by their checkout definitions. */
export const T = {
  quick: TIERS.quick,
  full: TIERS.full,
  fix: TIERS.scan_fix,
  forensic: TIERS.nuclear,
  continuous: TIERS.continuous,
  mcp: TIERS.mcp,
};

/** Look a sub-processor up by name; fail the build if the fact is gone. */
export function vendor(name: string) {
  const v = F.SUB_PROCESSORS.find((s) => s.name === name);
  if (!v) throw new Error(`legal facts: sub-processor "${name}" is not declared in _facts.js`);
  return v;
}

export const AI = vendor("Anthropic");
export const AI_SECOND = vendor("OpenAI");
export const PAY = vendor("Stripe");
export const GH = vendor("GitHub");
export const GL = vendor("Gluecron");

/** The modules the hosted engine refuses to run, as inline code spans. */
export const UNSAFE = F.HOSTED_UNSAFE_MODULES.map((m) => `\`${m}\``).join(", ");

/** A mailto link to the support mailbox, optionally with a subject line. */
export function mailto(subject?: string): string {
  const q = subject ? `?subject=${encodeURIComponent(subject)}` : "";
  return `[${EMAIL}](mailto:${EMAIL}${q})`;
}
