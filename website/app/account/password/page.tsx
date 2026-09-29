import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { CUSTOMER_COOKIE_NAME, verifyCustomerSession } from "@/app/lib/customer-session";
import { PASSWORD_AUTH_ENABLED } from "@/app/lib/auth-features";
import { PASSWORD_MIN_LENGTH } from "@/app/lib/password-auth-core";
import { PasswordAuthShell, Field, SubmitButton, copyFor, first } from "@/app/components/PasswordAuthShell";

/**
 * /account/password — change the password of the signed-in customer.
 *
 * Behind the server-side sign-in gate (session-gate.js PROTECTED_PREFIXES),
 * so an anonymous request is 307'd to /login?next=/account/password before
 * this renders. Posts to /api/auth/password/change, which takes the identity
 * from the session cookie. An account that has no password yet (GitHub /
 * Google only) is told to use the reset link instead.
 */

export const metadata: Metadata = {
  title: "Change password — GateTest",
  description: "Change your GateTest password.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function AccountPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[]; notice?: string | string[] }>;
}) {
  if (!PASSWORD_AUTH_ENABLED) notFound();
  const secret = process.env.SESSION_SECRET || "";
  const cookieStore = await cookies();
  const session = secret ? verifyCustomerSession(cookieStore.get(CUSTOMER_COOKIE_NAME)?.value, secret) : null;
  if (!session) redirect("/login?next=%2Faccount%2Fpassword");

  const params = await searchParams;
  const { error, notice } = copyFor(first(params.error), first(params.notice));

  return (
    <PasswordAuthShell
      title="Change password"
      intro={session.e || undefined}
      error={error}
      notice={notice}
      footer={
        <>
          <p>
            No password yet?{" "}
            <Link href="/login/password/forgot" className="hover:text-foreground">Set one with an emailed link</Link>
          </p>
          <p>
            <Link href="/dashboard" className="hover:text-foreground">&larr; Back to the dashboard</Link>
          </p>
        </>
      }
    >
      <form method="post" action="/api/auth/password/change">
        <Field id="current_password" label="Current password" type="password" autoComplete="current-password" />
        <Field id="new_password" label="New password" type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} />
        <Field id="new_password_confirm" label="New password again" type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} />
        <SubmitButton>Change password</SubmitButton>
      </form>
    </PasswordAuthShell>
  );
}
