import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  CUSTOMER_COOKIE_NAME,
  getOAuthConfig,
  getGitLabOAuthConfig,
  getGoogleOAuthConfig,
  verifyCustomerSession,
} from "@/app/lib/customer-session";
import { safeNext } from "@/app/lib/session-gate";
import { signInProviders, ERROR_COPY, GENERIC_ERROR } from "@/app/lib/sign-in-providers";
import { PASSWORD_AUTH_ENABLED } from "@/app/lib/auth-features";

/**
 * /login — the sign-in entry (#810; providers per owner directive 2026-09-29).
 *
 * Anonymous: one button per provider this deployment can actually serve
 * (GitHub, Google, GitLab), decided server-side from the OAuth config getters,
 * plus honest "coming soon" lines for Gluecron and email + password until
 * those flows exist. Signed in: straight on to `next`, or /dashboard. There is
 * no separate sign-up — /register, /signup and /sign-up are permanent
 * redirects here (next.config.ts), because the first sign-in with any provider
 * is how an account starts. `website/proxy.ts` sends anonymous requests for
 * protected pages here with `?next=<path>`.
 */

export const metadata: Metadata = {
  title: "Sign in — GateTest",
  description: "Sign in to GateTest to see your scan history and usage.",
  robots: { index: false, follow: true },
};

export const dynamic = "force-dynamic";

// Codes the OAuth callbacks redirect with live in sign-in-providers.js (one
// definition, shared with the tests); this alias keeps the name the page has
// always used.
const ERRORS: Record<string, string> = ERROR_COPY;

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; error?: string | string[] }>;
}) {
  const params = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const next = safeNext(first(params.next) ?? null);

  const github = getOAuthConfig();
  const google = getGoogleOAuthConfig();
  const gitlab = getGitLabOAuthConfig();

  // Every provider signs the same cookie with SESSION_SECRET; any configured
  // one can vouch for an existing session.
  const sessionSecret =
    github.config?.sessionSecret ?? google.config?.sessionSecret ?? gitlab.config?.sessionSecret;
  const cookieStore = await cookies();
  if (sessionSecret) {
    const session = verifyCustomerSession(cookieStore.get(CUSTOMER_COOKIE_NAME)?.value, sessionSecret);
    if (session) redirect(next ?? "/dashboard");
  }

  const errorCode = first(params.error);
  const errorMessage = errorCode ? ERRORS[errorCode] ?? GENERIC_ERROR : null;

  const entries = signInProviders({
    available: { github: github.ok, google: google.ok, gitlab: gitlab.ok },
    next,
    passwordAuth: PASSWORD_AUTH_ENABLED,
  });
  const links = entries.filter((e) => e.href);
  const comingSoon = entries.filter((e) => !e.href);
  const anyProvider = links.length > 0;

  return (
    <div className="flex-1 flex items-center justify-center bg-background px-6 py-16 sm:py-24">
      <div className="max-w-sm w-full text-center">
        <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-foreground mb-2">
          Sign in to GateTest
        </h1>
        <p className="text-muted text-sm mb-2">
          Your scan history, results and usage are behind the sign-in.
        </p>
        <p className="text-muted text-sm mb-8">
          There is no separate sign-up: the first sign-in with any provider is how an account
          starts. GateTest asks the provider for your login and email address only.
        </p>
        {errorMessage && (
          <p role="alert" className="text-sm text-foreground border border-border rounded-lg px-4 py-3 mb-6">
            {errorMessage}
          </p>
        )}
        {anyProvider ? (
          <ul className="grid gap-3 list-none p-0 m-0">
            {links.map((e, i) => (
              <li key={e.id}>
                <a
                  href={e.href}
                  className={`${i === 0 ? "btn-cta" : "border border-border text-foreground hover:border-accent/50"} w-full py-3.5 text-sm block text-center rounded-xl font-semibold`}
                >
                  {e.label}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">
            Sign-in is not available on this deployment right now. The free scan on the
            playground needs no account.
          </p>
        )}
        {comingSoon.length > 0 && (
          <ul className="grid gap-2 list-none p-0 mt-6" aria-label="Sign-in methods coming soon">
            {comingSoon.map((e) => (
              <li key={e.id} className="text-sm text-muted">
                {e.label} — {e.note}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-6">
          <Link href="/" className="text-sm text-muted hover:text-foreground">
            &larr; Back to GateTest
          </Link>
        </div>
      </div>
    </div>
  );
}
