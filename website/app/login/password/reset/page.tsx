import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PASSWORD_AUTH_ENABLED } from "@/app/lib/auth-features";
import { PASSWORD_MIN_LENGTH, isTokenShape } from "@/app/lib/password-auth-core";
import { PasswordAuthShell, Field, SubmitButton, copyFor, first } from "@/app/components/PasswordAuthShell";

/**
 * /login/password/reset?token=… — the page the reset e-mail links to.
 *
 * Posts token + new password to /api/auth/password/reset. A missing or
 * malformed token renders the "request a new one" message without a form;
 * whether the token is still valid is only decided when the form is posted,
 * so an opened link is never consumed by a mail scanner's prefetch.
 */

export const metadata: Metadata = {
  title: "Choose a new password — GateTest",
  description: "Choose a new GateTest password.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function PasswordResetPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[]; error?: string | string[] }>;
}) {
  if (!PASSWORD_AUTH_ENABLED) notFound();
  const params = await searchParams;
  const token = first(params.token) ?? "";
  const tokenOk = isTokenShape(token);
  const { error } = copyFor(tokenOk ? first(params.error) : "token_invalid");

  return (
    <PasswordAuthShell
      title="Choose a new password"
      intro={tokenOk ? `At least ${PASSWORD_MIN_LENGTH} characters. This also confirms your email address.` : undefined}
      error={error}
      footer={
        <>
          {!tokenOk && (
            <p>
              <Link href="/login/password/forgot" className="hover:text-foreground">Request a new reset link</Link>
            </p>
          )}
          <p>
            <Link href="/login/password" className="hover:text-foreground">&larr; Back to sign in</Link>
          </p>
        </>
      }
    >
      {tokenOk && (
        <form method="post" action="/api/auth/password/reset">
          <input type="hidden" name="token" value={token} />
          <Field id="password" label="New password" type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} />
          <Field id="password_confirm" label="New password again" type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} />
          <SubmitButton>Set new password</SubmitButton>
        </form>
      )}
    </PasswordAuthShell>
  );
}
