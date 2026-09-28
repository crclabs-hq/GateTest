import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  CUSTOMER_COOKIE_NAME,
  getOAuthConfig,
  verifyCustomerSession,
} from "@/app/lib/customer-session";
import { safeNext } from "@/app/lib/session-gate";

/**
 * /login — the sign-in entry (#810).
 *
 * Anonymous: the GitHub OAuth button. Signed in: straight on to `next`, or
 * /dashboard. There is no separate sign-up — /register, /signup and /sign-up
 * are permanent redirects here (next.config.ts), because the first GitHub
 * sign-in is how an account starts. `website/proxy.ts` sends anonymous
 * requests for protected pages here with `?next=<path>`.
 */

export const metadata: Metadata = {
  title: "Sign in — GateTest",
  description: "Sign in to GateTest with GitHub to see your scan history and usage.",
  robots: { index: false, follow: true },
};

export const dynamic = "force-dynamic";

// Codes the GitHub callback (app/api/auth/callback/route.ts) redirects with.
const ERROR_COPY: Record<string, string> = {
  invalid_state: "The sign-in request expired or did not match this browser. Start again.",
  token_failed: "GitHub did not return an access token. Start again.",
  user_failed: "GitHub did not return your profile. Start again.",
  not_configured: "GitHub sign-in is not configured on this deployment.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; error?: string | string[] }>;
}) {
  const params = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const next = safeNext(first(params.next) ?? null);

  const oauth = getOAuthConfig();
  const cookieStore = await cookies();
  if (oauth.ok && oauth.config) {
    const session = verifyCustomerSession(
      cookieStore.get(CUSTOMER_COOKIE_NAME)?.value,
      oauth.config.sessionSecret
    );
    if (session) redirect(next ?? "/dashboard");
  }

  const errorCode = first(params.error);
  const errorMessage = errorCode ? ERROR_COPY[errorCode] ?? "Sign-in did not complete. Start again." : null;
  const signInHref = next ? `/api/auth/github?next=${encodeURIComponent(next)}` : "/api/auth/github";

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
          There is no separate sign-up: signing in with GitHub is how an account starts. GateTest
          asks GitHub for your login and email address only (read:user, user:email).
        </p>
        {errorMessage && (
          <p role="alert" className="text-sm text-foreground border border-border rounded-lg px-4 py-3 mb-6">
            {errorMessage}
          </p>
        )}
        {oauth.ok ? (
          <a
            href={signInHref}
            className="btn-cta w-full py-3.5 text-sm block text-center rounded-xl font-semibold"
          >
            Sign in with GitHub
          </a>
        ) : (
          <p className="text-sm text-muted">
            GitHub sign-in is not available on this deployment right now. The free scan on the
            playground needs no account.
          </p>
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
