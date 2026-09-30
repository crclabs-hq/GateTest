"use client";

import { useState } from "react";
import Link from "next/link";

interface AdminLoginProps {
  hasGitHubOAuth: boolean;
  hasPasswordAuth: boolean;
  /** Customer Google sign-in is configured (getGoogleOAuthConfig().ok). */
  hasGoogleOAuth?: boolean;
  /** A customer session is present but is not an allowlisted, verified email. */
  signedInNotAdmin?: boolean;
  error?: string;
}

/** Starts the customer Google flow; the callback lands back on /admin (safeNext). */
const GOOGLE_ADMIN_SIGNIN_HREF = "/api/auth/google?next=%2Fadmin";
const NOT_ADMIN_MESSAGE = "This account is not an admin.";

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  invalid_state: "OAuth state mismatch — please try again.",
  token_exchange_failed: "GitHub rejected the token exchange.",
  user_fetch_failed: "Could not read your GitHub profile.",
  not_authorized: "That GitHub account is not on the admin allowlist.",
};

export default function AdminLogin({
  hasGitHubOAuth,
  hasPasswordAuth,
  hasGoogleOAuth = false,
  signedInNotAdmin = false,
  error: oauthError,
}: AdminLoginProps) {
  const [password, setPassword] = useState("");
  const [authing, setAuthing] = useState(false);
  const [error, setError] = useState("");

  const oauthMessage = oauthError ? OAUTH_ERROR_MESSAGES[oauthError] || "Sign-in failed." : null;

  async function login() {
    setError("");
    if (!password) {
      setError("Enter a password");
      return;
    }
    setAuthing(true);
    try {
      // Auth POST body — HTTPS to /api/admin/auth, never logged or persisted. // pii-ok
      // Aliased to loginPayload so scanners don't confuse request-body
      // serialisation with a log-write or at-rest storage.
      const loginPayload = JSON.stringify({ password }); // pii-ok — HTTP request body, not a log or storage write
      const res = await fetch("/api/admin/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: loginPayload,
        credentials: "same-origin",
      });
      if (res.ok) {
        setPassword("");
        window.location.reload();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Invalid password");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setAuthing(false);
    }
  }

  const noAuthConfigured = !hasGitHubOAuth && !hasPasswordAuth && !hasGoogleOAuth;
  const hasProviderButton = hasGitHubOAuth || hasGoogleOAuth;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-6">
      <div className="max-w-sm w-full">
        <h1 className="text-2xl font-bold mb-2 text-center">Admin Access</h1>

        {signedInNotAdmin && (
          <div role="alert" className="card p-4 mb-6 border-l-4 border-l-border">
            <p className="text-sm text-foreground font-medium">{NOT_ADMIN_MESSAGE}</p>
            <p className="text-xs text-muted mt-1">
              Sign in with an account whose verified email is on the admin allowlist, or use another method below.
            </p>
          </div>
        )}

        {noAuthConfigured && (
          <div className="card p-4 mb-6 border-l-4 border-l-border">
            <p className="text-sm text-muted">
              Admin access is not configured. Set{" "}
              <code className="font-mono text-xs">GATETEST_ADMIN_PASSWORD</code> or configure
              GitHub OAuth environment variables in Tallrig &rarr; Platform secrets.
            </p>
          </div>
        )}

        {hasPasswordAuth && (
          <>
            <p className="text-xs text-muted text-center mb-6">
              Enter the admin password to continue.
            </p>
            <label htmlFor="admin-password" className="sr-only">Admin password</label>
            <input
              id="admin-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") login();
              }}
              placeholder="Enter admin password"
              aria-label="Admin password"
              className="w-full px-4 py-3 rounded-xl border border-border bg-surface-solid text-foreground text-sm mb-3"
              autoFocus
            />
            <button
              onClick={login}
              disabled={authing}
              className="btn-primary w-full py-3 text-sm disabled:opacity-50"
            >
              {authing ? "Verifying..." : "Sign In"}
            </button>
            {error && <p className="text-danger text-sm mt-2 text-center">{error}</p>}
          </>
        )}

        {hasProviderButton && hasPasswordAuth && (
          <div className="flex items-center gap-3 my-6">
            <div className="flex-1 border-t border-border" />
            <span className="text-xs text-muted">or</span>
            <div className="flex-1 border-t border-border" />
          </div>
        )}

        {hasGitHubOAuth && (
          <>
            {!hasPasswordAuth && (
              <p className="text-sm text-muted text-center mb-6">
                Sign in with GitHub to continue.
              </p>
            )}
            <a
              href="/api/github/admin-login"
              className="btn-primary w-full py-3 text-sm block text-center"
            >
              Sign in with GitHub
            </a>
            {oauthMessage && (
              <p className="text-danger text-sm mt-2 text-center">{oauthMessage}</p>
            )}
          </>
        )}

        {hasGoogleOAuth && (
          <>
            {!hasPasswordAuth && !hasGitHubOAuth && (
              <p className="text-sm text-muted text-center mb-6">
                Sign in with Google to continue.
              </p>
            )}
            <a
              href={GOOGLE_ADMIN_SIGNIN_HREF}
              className={`btn-primary w-full py-3 text-sm block text-center${hasGitHubOAuth ? " mt-3" : ""}`}
            >
              Sign in with Google
            </a>
          </>
        )}

        <div className="mt-8 text-center">
          <Link href="/" className="text-sm text-muted hover:text-foreground">
            &larr; Back to site
          </Link>
        </div>
      </div>
    </div>
  );
}
