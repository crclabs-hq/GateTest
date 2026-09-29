import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PASSWORD_AUTH_ENABLED } from "@/app/lib/auth-features";
import { safeNext } from "@/app/lib/session-gate";
import { PASSWORD_MIN_LENGTH } from "@/app/lib/password-auth-core";
import { PasswordAuthShell, Field, SubmitButton, copyFor, first } from "@/app/components/PasswordAuthShell";

/**
 * /login/password/register — create an email + password account.
 *
 * Posts to /api/auth/password/register. The account is not usable until
 * the confirmation link in the e-mail is clicked; the page says the same
 * thing whether or not the address was already known.
 */

export const metadata: Metadata = {
  title: "Create an account — GateTest",
  description: "Create a GateTest account with your email address and a password.",
  robots: { index: false, follow: true },
};

export const dynamic = "force-dynamic";

export default async function PasswordRegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; error?: string | string[]; notice?: string | string[] }>;
}) {
  if (!PASSWORD_AUTH_ENABLED) notFound();
  const params = await searchParams;
  const next = safeNext(first(params.next) ?? null);
  const { error, notice } = copyFor(first(params.error), first(params.notice));
  const q = next ? `?next=${encodeURIComponent(next)}` : "";

  return (
    <PasswordAuthShell
      title="Create an account"
      intro={`Choose a password of at least ${PASSWORD_MIN_LENGTH} characters. We will send a link to confirm your email address before the password works.`}
      error={error}
      notice={notice}
      footer={
        <>
          <p>
            Already have one?{" "}
            <Link href={`/login/password${q}`} className="hover:text-foreground">Sign in</Link>
          </p>
          <p>
            <Link href={`/login${q}`} className="hover:text-foreground">&larr; Sign in with GitHub or Google instead</Link>
          </p>
        </>
      }
    >
      {notice ? null : (
        <form method="post" action="/api/auth/password/register">
          {next && <input type="hidden" name="next" value={next} />}
          <Field id="email" label="Email address" type="email" autoComplete="email" placeholder="you@example.com" />
          <Field id="password" label="Password" type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} />
          <Field id="password_confirm" label="Password again" type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} />
          <SubmitButton>Create account</SubmitButton>
        </form>
      )}
    </PasswordAuthShell>
  );
}
