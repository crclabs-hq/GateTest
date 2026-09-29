import type { ReactNode } from "react";
import { ERROR_COPY, NOTICE_COPY } from "@/app/lib/password-auth-core";

/**
 * The frame every password sign-in page renders in — the same centred card
 * as /login (#819), with the error / notice sentence resolved from the
 * query code the route redirected with. Plain HTML forms: they post to the
 * /api/auth/password/* routes and work with JavaScript off.
 */

export const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

export function copyFor(errorCode?: string, noticeCode?: string): { error: string | null; notice: string | null } {
  const error = errorCode ? (ERROR_COPY as Record<string, string>)[errorCode] ?? "That did not work. Try again." : null;
  const notice = noticeCode ? (NOTICE_COPY as Record<string, string>)[noticeCode] ?? null : null;
  return { error, notice };
}

export function PasswordAuthShell({
  title,
  intro,
  error,
  notice,
  children,
  footer,
}: {
  title: string;
  intro?: ReactNode;
  error?: string | null;
  notice?: string | null;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex-1 flex items-center justify-center bg-background px-6 py-16 sm:py-24">
      <div className="max-w-sm w-full text-center">
        <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-foreground mb-2">{title}</h1>
        {intro && <p className="text-muted text-sm mb-8">{intro}</p>}
        {notice && (
          <p role="status" className="text-sm text-foreground border border-border rounded-lg px-4 py-3 mb-6">
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-foreground border border-border rounded-lg px-4 py-3 mb-6">
            {error}
          </p>
        )}
        {children}
        {footer && <div className="mt-6 text-sm text-muted space-y-2">{footer}</div>}
      </div>
    </div>
  );
}

export const INPUT_CLASS =
  "w-full rounded-lg bg-background border border-border px-4 py-2.5 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent";

export function Field({
  id,
  label,
  type,
  autoComplete,
  minLength,
  placeholder,
}: {
  id: string;
  label: string;
  type: "email" | "password";
  autoComplete: string;
  minLength?: number;
  placeholder?: string;
}) {
  return (
    <label htmlFor={id} className="block text-left mb-4">
      <span className="block text-xs font-semibold text-muted mb-1.5">{label}</span>
      <input
        id={id}
        name={id}
        type={type}
        required
        autoComplete={autoComplete}
        minLength={minLength}
        placeholder={placeholder}
        className={INPUT_CLASS}
      />
    </label>
  );
}

export function SubmitButton({ children }: { children: ReactNode }) {
  return (
    <button type="submit" className="btn-cta w-full py-3.5 text-sm block text-center rounded-xl font-semibold">
      {children}
    </button>
  );
}
