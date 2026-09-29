import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PASSWORD_AUTH_ENABLED } from "@/app/lib/auth-features";
import { safeNext } from "@/app/lib/session-gate";
import { PasswordAuthShell, Field, SubmitButton, copyFor, first } from "@/app/components/PasswordAuthShell";

/**
 * /login/password/forgot — ask for a reset link.
 *
 * Posts to /api/auth/password/forgot, which answers the same way for every
 * well-formed address. An account that signs in with GitHub or Google and
 * has no password yet gets one through this same link.
 */

export const metadata: Metadata = {
  title: "Forgot password — GateTest",
  description: "Get a link to reset your GateTest password.",
  robots: { index: false, follow: true },
};

export const dynamic = "force-dynamic";

export default async function PasswordForgotPage({
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
      title="Forgot your password?"
      intro="Enter your email address and we will send a link to choose a new one. The link is valid for one hour."
      error={error}
      notice={notice}
      footer={
        <p>
          <Link href={`/login/password${q}`} className="hover:text-foreground">&larr; Back to sign in</Link>
        </p>
      }
    >
      {notice ? null : (
        <form method="post" action="/api/auth/password/forgot">
          {next && <input type="hidden" name="next" value={next} />}
          <Field id="email" label="Email address" type="email" autoComplete="email" placeholder="you@example.com" />
          <SubmitButton>Send reset link</SubmitButton>
        </form>
      )}
    </PasswordAuthShell>
  );
}
