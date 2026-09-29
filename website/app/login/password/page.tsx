import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { CUSTOMER_COOKIE_NAME, verifyCustomerSession } from "@/app/lib/customer-session";
import { PASSWORD_AUTH_ENABLED } from "@/app/lib/auth-features";
import { safeNext } from "@/app/lib/session-gate";
import { PASSWORD_MIN_LENGTH } from "@/app/lib/password-auth-core";
import { PasswordAuthShell, Field, SubmitButton, copyFor, first } from "@/app/components/PasswordAuthShell";

/**
 * /login/password — sign in with an email address and a password.
 *
 * A plain form posting to /api/auth/password/login; the route answers 303
 * to `next` (or /dashboard) with the session cookie, or back here with
 * ?error=<code>. `next` is threaded through the hidden field the way
 * /login threads it to the OAuth initiate route (#819).
 */

export const metadata: Metadata = {
  title: "Sign in with email — GateTest",
  description: "Sign in to GateTest with your email address and password.",
  robots: { index: false, follow: true },
};

export const dynamic = "force-dynamic";

export default async function PasswordLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; error?: string | string[]; notice?: string | string[] }>;
}) {
  if (!PASSWORD_AUTH_ENABLED) notFound();
  const params = await searchParams;
  const next = safeNext(first(params.next) ?? null);

  const secret = process.env.SESSION_SECRET || "";
  if (secret) {
    const cookieStore = await cookies();
    if (verifyCustomerSession(cookieStore.get(CUSTOMER_COOKIE_NAME)?.value, secret)) redirect(next ?? "/dashboard");
  }

  const { error, notice } = copyFor(first(params.error), first(params.notice));
  const q = next ? `?next=${encodeURIComponent(next)}` : "";

  return (
    <PasswordAuthShell
      title="Sign in with email"
      intro="Use the email address and password you registered with GateTest."
      error={error}
      notice={notice}
      footer={
        <>
          <p>
            <Link href={`/login/password/forgot${q}`} className="hover:text-foreground">Forgot your password?</Link>
          </p>
          <p>
            New here?{" "}
            <Link href={`/login/password/register${q}`} className="hover:text-foreground">Create an account</Link>
          </p>
          <p>
            <Link href={`/login${q}`} className="hover:text-foreground">&larr; Other ways to sign in</Link>
          </p>
        </>
      }
    >
      <form method="post" action="/api/auth/password/login">
        {next && <input type="hidden" name="next" value={next} />}
        <Field id="email" label="Email address" type="email" autoComplete="email" placeholder="you@example.com" />
        <Field id="password" label="Password" type="password" autoComplete="current-password" minLength={PASSWORD_MIN_LENGTH} />
        <SubmitButton>Sign in</SubmitButton>
      </form>
    </PasswordAuthShell>
  );
}
