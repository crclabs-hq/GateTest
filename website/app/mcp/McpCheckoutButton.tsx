'use client';

/**
 * MCP $29/mo checkout button.
 *
 * The deliverable for this tier is an API key SENT BY EMAIL after Stripe
 * confirms payment. If the deployment cannot send email (RESEND_API_KEY
 * unset — true in production on 2026-08-18) the customer pays and the key
 * never arrives, and the webhook 500s. Selling something we cannot deliver
 * is worse than a paused button, so the button asks /api/status whether
 * email delivery is configured and, if not, shows an honest "paused" state
 * with a way to be notified. Fail OPEN only when the status endpoint itself
 * is unreachable — that is a monitoring problem, not proof email is down.
 */

import { useEffect, useState } from 'react';

const SUPPORT_EMAIL = 'support@gatetest.io';

export default function McpCheckoutButton({ label }: { label: string }) {
  const [emailReady, setEmailReady] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/status')
      .then((r) => r.json())
      .then((s: { missing_important?: Array<{ name: string }> }) => {
        if (cancelled) return;
        const missing = (s.missing_important || []).some((m) => m.name === 'RESEND_API_KEY');
        setEmailReady(!missing);
      })
      .catch(() => { if (!cancelled) setEmailReady(true); });
    return () => { cancelled = true; };
  }, []);

  function handleClick() {
    fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'mcp' }),
    })
      .then((r) => r.json())
      .then((d: { checkoutUrl?: string }) => {
        if (d.checkoutUrl) window.location.href = d.checkoutUrl;
      })
      .catch(() => { window.location.href = '/mcp'; });
  }

  if (emailReady === false) {
    return (
      <div className="inline-flex flex-col items-start gap-2">
        <button
          type="button"
          disabled
          className="btn-cta inline-flex items-center gap-2 px-6 py-3 text-sm font-semibold rounded-xl cursor-not-allowed opacity-60"
          title="Sign-ups paused while key delivery is being set up"
        >
          {label} — paused
        </button>
        <p className="text-sm text-muted max-w-md">
          Hosted MCP sign-ups are paused for a moment while API-key email delivery is finished — we will not take a payment
          we cannot deliver on. Email <a className="underline text-accent" href={`mailto:${SUPPORT_EMAIL}?subject=Notify%20me%20when%20GateTest%20MCP%20opens`}>{SUPPORT_EMAIL}</a>{' '}
          and we&apos;ll tell you the moment it opens. The local MCP server is free and works today.
        </p>
      </div>
    );
  }

  return (
    <button
      onClick={handleClick}
      disabled={emailReady === null}
      className="btn-cta inline-flex items-center gap-2 px-6 py-3 text-sm font-semibold rounded-xl cursor-pointer disabled:opacity-70"
    >
      {label}
    </button>
  );
}
