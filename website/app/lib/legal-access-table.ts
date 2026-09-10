/**
 * Access-scope blocks shared by the DPA (Annex II) and the Security page.
 *
 * The GitHub App permission table is GENERATED from the one declaration in
 * `src/core/github-app-permissions.js` (via the `app/lib` shim), so a scope
 * the bridge gains can never be missing from the legal surfaces — the same
 * rule the Marketplace listing follows. Never hand-type a permission here.
 */
import type { LegalBlock } from "../components/legal/LegalDocument";
import { APP_PERMISSIONS, WEBHOOK_EVENTS, APP_SLUG, appInstallUrl } from "./github-app-permissions";

/** Scopes requested at sign-in. Ground truth: `app/api/auth/github/route.ts`. */
export const GITHUB_OAUTH_SCOPES = ["read:user", "user:email"];

/** The App's permission table, one row per declared scope, with the
 *  customer-facing reason GitHub shows next to it. */
export function githubAppPermissionTable(): LegalBlock {
  return {
    table: {
      headers: ["Permission", "Access", "Why we need it"],
      rows: APP_PERMISSIONS.map((p) => [`**${p.display}**`, p.label, p.why]),
    },
  };
}

/** The same table with the exact endpoints that force each scope — for the
 *  reader who wants to verify the claim against the GitHub API, not take it
 *  on trust. */
export function githubAppEndpointTable(): LegalBlock {
  return {
    table: {
      headers: ["Permission", "Endpoints that require it"],
      rows: APP_PERMISSIONS.map((p) => [`**${p.display}**`, p.endpoints.map((e) => `\`${e}\``).join(", ")]),
    },
  };
}

export function webhookEventsSentence(): string {
  return `The App subscribes to ${WEBHOOK_EVENTS.length} webhook events: ${WEBHOOK_EVENTS.map((e) => `\`${e}\``).join(", ")}. No other event reaches us.`;
}

export function oauthScopesSentence(): string {
  return `Signing in with GitHub uses the OAuth scopes ${GITHUB_OAUTH_SCOPES.map((s) => `\`${s}\``).join(" and ")} — your login and e-mail address only; sign-in never grants repository access.`;
}

/** Why each hosted-unsafe module is refused on our servers. Keyed by the
 *  module name in `_facts.HOSTED_UNSAFE_MODULES`; a module the facts add that
 *  is not described here gets the generic reason, never a silent omission. */
const UNSAFE_REASONS: Record<string, string> = {
  mutation: "runs your own test suite repeatedly against mutated copies of your code",
  chaos: "drives a headless browser against your application and fuzzes its inputs",
  unitTests: "executes your unit-test runner and whatever it loads",
  integrationTests: "executes your integration-test runner, which typically starts your services",
  e2e: "executes your end-to-end test runner and a browser",
  lint: "runs your project's linter, which loads plugins from your dependency tree",
};

export function hostedUnsafeModuleList(modules: readonly string[]): string[] {
  return modules.map((m) => `\`${m}\` — ${UNSAFE_REASONS[m] || "executes code from the repository being scanned"}.`);
}

export function githubAppIdentitySentence(): string {
  return `The App is published as [${APP_SLUG}](${appInstallUrl()}); the permission prompt GitHub shows at install time is the list above.`;
}
