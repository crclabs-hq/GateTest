"use client";

/**
 * <NotifySignup> — "email me when it launches" form.
 * Posts to /api/notify with a topic tag. Handles every state:
 * idle → submitting → done | error (Bible Forbidden #4: no dead states).
 */

import { useState } from "react";

interface NotifySignupProps {
  readonly topic: string;
  readonly placeholder?: string;
  readonly buttonLabel?: string;
}

export default function NotifySignup({
  topic,
  placeholder = "you@company.com",
  buttonLabel = "Notify me",
}: NotifySignupProps) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "submitting" | "done" | "error">("idle");
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (state === "submitting") return;
    setState("submitting");
    setError("");
    try {
      const res = await fetch("/api/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, topic }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setState("done");
      } else {
        setState("error");
        setError(
          typeof data.error === "string" ? data.error : "Something went wrong — please try again."
        );
      }
    } catch {
      setState("error");
      setError("Network error — please try again.");
    }
  }

  if (state === "done") {
    return (
      <p className="text-emerald-400 text-sm font-semibold" role="status">
        ✓ You&rsquo;re on the list — we&rsquo;ll email you the moment it&rsquo;s live.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col sm:flex-row gap-3 w-full max-w-md">
      <label htmlFor={`notify-${topic}`} className="sr-only">
        Email address
      </label>
      <input
        id={`notify-${topic}`}
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder={placeholder}
        className="flex-1 rounded-lg bg-background border border-border px-4 py-2.5 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent"
      />
      <button
        type="submit"
        disabled={state === "submitting"}
        className="rounded-lg bg-accent text-background font-semibold text-sm px-5 py-2.5 hover:opacity-90 transition-opacity disabled:opacity-50"
      >
        {state === "submitting" ? "Saving…" : buttonLabel}
      </button>
      {state === "error" && (
        <p className="text-red-400 text-xs sm:basis-full" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
